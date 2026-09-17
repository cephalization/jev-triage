import { serve } from "@hono/node-server";
import type { ZeroContext } from "@triage/schema";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { checkState, colorFor, contextFromRequest, mintToken, newState } from "./auth.ts";
import { sql } from "./db.ts";
import { env } from "./env.ts";
import {
  exchangeCode,
  fetchGithubUser,
  resolveAccount,
  userIdFor,
  type GithubUser,
} from "./github/account.ts";
import { isSyncing, syncRepo } from "./github/sync.ts";
import { isKind, KINDS, listModels } from "./providers/catalog.ts";
import {
  clearProviderKey,
  getProvider,
  loadProviderKey,
  setProviderKey,
} from "./providers/store.ts";
import { ClassifierWorker } from "./worker/classifier.ts";
import { TypeSafeSystemOne } from "./worker/typesafe.ts";
import { zeroRoutes } from "./zero/routes.ts";

const worker = new ClassifierWorker(
  env.typesafeKey ? new TypeSafeSystemOne(env.typesafeKey, env.typesafeModel) : null,
);
const poke = (repoId: string, reason: string) => worker.poke(repoId, reason);

const app = new Hono();
app.use("/api/*", cors());
app.route("/", zeroRoutes(poke));

app.get("/api/health", async (c) => {
  const rows = await sql<{ now: Date }[]>`select now()`;
  const now = rows[0]?.now ?? null;
  return c.json({
    ok: true,
    now,
    typesafe: env.typesafeKey !== null,
    github: env.githubToken !== null,
    auth: {
      github: env.githubClientId !== null && env.githubClientSecret !== null,
      emulated: env.githubApiUrl !== "https://api.github.com",
    },
    prices:
      env.priceInputPerMTok !== null && env.priceOutputPerMTok !== null
        ? { inputPerMTok: env.priceInputPerMTok, outputPerMTok: env.priceOutputPerMTok }
        : null,
  });
});

/**
 * Both sign-in paths end here: decide from env admins and the invite row, upsert the user,
 * mark the invite accepted, and mint the session. Returns the denied login otherwise.
 */
async function signIn(
  gh: GithubUser,
): Promise<{ ok: true; token: string; user: ZeroContext } | { ok: false; login: string }> {
  const login = gh.login.toLowerCase();
  const [invite] = await sql<{ role: string }[]>`select role from invite where login = ${login}`;
  const decision = resolveAccount(gh.login, {
    adminLogins: env.adminLogins,
    invite: invite ?? null,
  });
  if (!decision.ok) return { ok: false, login: gh.login };
  const userID = userIdFor(gh.id);
  const user: ZeroContext = {
    userID,
    name: gh.name?.trim() || gh.login,
    color: colorFor(userID),
    login: gh.login,
    role: decision.role,
    avatarUrl: gh.avatar_url,
  };
  await sql.begin(async (tx) => {
    await tx`insert into "user" (id, name, color, login, github_id, avatar_url, role, last_login_at)
      values (${userID}, ${user.name}, ${user.color}, ${gh.login}, ${gh.id}, ${gh.avatar_url}, ${user.role}, now())
      on conflict (id) do update set name = excluded.name, login = excluded.login,
        avatar_url = excluded.avatar_url, role = excluded.role, last_login_at = now()`;
    if (decision.viaInvite)
      await tx`update invite set accepted_at = coalesce(accepted_at, now()), accepted_by = coalesce(accepted_by, ${userID})
        where login = ${login}`;
  });
  return { ok: true, token: await mintToken(user), user };
}

const callbackUrl = `${env.appUrl}/api/auth/github/callback`;
const backToApp = (fragment: Record<string, string>) =>
  `${env.appUrl}/#${new URLSearchParams(fragment).toString()}`;

/** OAuth step one: send the browser to GitHub (or the emulator) with a signed state. */
app.get("/api/auth/github/start", (c) => {
  if (!env.githubClientId) return c.redirect(backToApp({ auth_error: "config" }));
  const url = new URL(`${env.githubOauthUrl}/login/oauth/authorize`);
  url.searchParams.set("client_id", env.githubClientId);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", newState());
  return c.redirect(url.toString());
});

/** OAuth step two: code → token → GitHub user → allowlist → session in the URL fragment. */
app.get("/api/auth/github/callback", async (c) => {
  if (!env.githubClientId || !env.githubClientSecret)
    return c.redirect(backToApp({ auth_error: "config" }));
  const code = c.req.query("code");
  if (!code || !checkState(c.req.query("state")))
    return c.redirect(backToApp({ auth_error: "state" }));
  try {
    const token = await exchangeCode(env.githubOauthUrl, {
      clientId: env.githubClientId,
      clientSecret: env.githubClientSecret,
      code,
      redirectUri: callbackUrl,
    });
    const result = await signIn(await fetchGithubUser(env.githubApiUrl, token));
    if (!result.ok)
      return c.redirect(backToApp({ auth_error: "not_invited", login: result.login }));
    return c.redirect(backToApp({ session: result.token }));
  } catch (e) {
    console.warn("[auth] github callback failed:", e instanceof Error ? e.message : e);
    return c.redirect(backToApp({ auth_error: "exchange" }));
  }
});

/** Token sign-in for agents, tests and emulator users: the token is used once and not kept. */
const tokenBody = z.object({ token: z.string().trim().min(1) });
app.post("/api/auth/token", async (c) => {
  const parsed = tokenBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "token required" }, 400);
  let gh: GithubUser;
  try {
    gh = await fetchGithubUser(env.githubApiUrl, parsed.data.token);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "GitHub rejected the token" }, 401);
  }
  const result = await signIn(gh);
  if (!result.ok)
    return c.json({ error: `@${result.login} is not on the allowlist`, login: result.login }, 403);
  return c.json({ token: result.token, user: result.user });
});

// ---- Providers: the key never travels through Zero, so it has its own routes -------------

async function requireAdmin(c: { req: { raw: Request } }): Promise<ZeroContext | null> {
  const ctx = await contextFromRequest(c.req.raw);
  return ctx?.role === "admin" ? ctx : null;
}

/** Kinds, labels and default base URLs, so the UI never hardcodes provider facts. */
app.get("/api/providers/kinds", (c) => c.json({ kinds: KINDS }));

const keyBody = z.object({ key: z.string().trim().min(1).max(500) });
app.put("/api/providers/:id/key", async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: "admins only" }, 403);
  const id = c.req.param("id");
  if (!(await getProvider(id))) return c.json({ error: "no such provider" }, 404);
  const parsed = keyBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "key required" }, 400);
  const keyHint = await setProviderKey(id, parsed.data.key);
  return c.json({ ok: true, keyHint });
});

app.delete("/api/providers/:id/key", async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: "admins only" }, 403);
  await clearProviderKey(c.req.param("id"));
  return c.json({ ok: true });
});

/** Ask the provider for its models with the stored key; the UI merges the answer into the row. */
app.post("/api/providers/:id/models", async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: "admins only" }, 403);
  const p = await getProvider(c.req.param("id"));
  if (!p || !isKind(p.kind)) return c.json({ error: "no such provider" }, 404);
  const key = await loadProviderKey(p.id);
  if (!key) return c.json({ error: "set a key first" }, 400);
  try {
    return c.json({ models: await listModels(p.kind, p.base_url, key) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "model list failed" }, 502);
  }
});

/** Which logins the server treats as admins, for the People screen. */
app.get("/api/auth/admins", async (c) => {
  const ctx = await contextFromRequest(c.req.raw);
  if (ctx?.role !== "admin") return c.json({ error: "admins only" }, 403);
  return c.json({ logins: env.adminLogins });
});

/**
 * Lets the client check a stored token before trusting it (secrets rotate, tokens expire, and a
 * user row can be removed under a live session, after which every write would fail on its
 * foreign key). A missing row answers 401 so the client signs out cleanly.
 */
app.get("/api/auth/me", async (c) => {
  const ctx = await contextFromRequest(c.req.raw);
  if (!ctx) return c.json({ error: "invalid or expired token" }, 401);
  const [row] = await sql<{ id: string }[]>`select id from "user" where id = ${ctx.userID}`;
  if (!row) return c.json({ error: "account no longer exists; sign in again" }, 401);
  return c.json({ user: ctx });
});

const syncBody = z.object({
  owner: z.string().trim().min(1),
  name: z.string().trim().min(1),
  /** Create the repo with classification paused (cost control for big repos). */
  paused: z.boolean().optional(),
  /** Max issues to keep (testing knob; default 100). */
  limit: z.number().int().min(1).max(5000).optional(),
});
app.post("/api/sync", async (c) => {
  const parsed = syncBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "owner and name required" }, 400);
  const { owner, name, paused, limit } = parsed.data;
  const repoId = `${owner}/${name}`;
  if (isSyncing(repoId)) return c.json({ ok: true, repoId, status: "already running" }, 202);
  // Fire and forget: progress streams through the repo row; classification starts per page.
  syncRepo(owner, name, { onPage: (id) => poke(id, "sync page") }, { paused, limit })
    .then((r) => {
      console.log(
        `[sync] ${r.repoId} finished: ${r.issues} issues in ${r.pages} pages (${r.phase})`,
      );
      poke(r.repoId, "sync done");
    })
    .catch((e) => console.error(`[sync] ${repoId} failed:`, e instanceof Error ? e.message : e));
  return c.json({ ok: true, repoId, status: "started" }, 202);
});

app.post("/api/classify/poke", async (c) => {
  const parsed = z.object({ repoId: z.string() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "repoId required" }, 400);
  poke(parsed.data.repoId, "manual");
  return c.json({ ok: true });
});

app.delete("/api/repo/:owner/:name", async (c) => {
  const id = `${c.req.param("owner")}/${c.req.param("name")}`;
  await sql`delete from repo where id = ${id}`;
  return c.json({ ok: true });
});

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(
    `[api] listening on http://localhost:${info.port} (typesafe ${env.typesafeKey ? "on" : "OFF"}, github token ${env.githubToken ? "on" : "off"})`,
  );
  void worker.pokeAllWithPendingWork();
});

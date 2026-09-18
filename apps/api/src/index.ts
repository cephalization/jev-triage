import { badHeaderChar } from "./providers/catalog.ts";
import { serve } from "@hono/node-server";
import type { ZeroContext } from "@triage/schema";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { checkState, colorFor, contextFromRequest, mintToken, newState } from "./auth.ts";
import { newId, sql } from "./db.ts";
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
  failOrphanedReviews,
  generationBlocker,
  isGenerating,
  runReviewJob,
} from "./review/job.ts";
import { OI, Tracer } from "@triage/triage/trace";
import { askSystemOne } from "./review/jev.ts";
import { overBudget, RateLimiter } from "./review/limits.ts";
import { noul } from "@typesafe-ai/sdk";
import {
  clearProviderKey,
  getProvider,
  loadProviderKey,
  setProviderKey,
} from "./providers/store.ts";
import { ClassifierWorker } from "./worker/classifier.ts";
import { TypeSafeSystemOne } from "./worker/typesafe.ts";
import { zeroRoutes } from "./zero/routes.ts";

const systemOne = env.typesafeKey
  ? new TypeSafeSystemOne(env.typesafeKey, env.typesafeModel)
  : null;
const worker = new ClassifierWorker(systemOne);
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
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "admins only" }, 403);
  const id = c.req.param("id");
  if (!(await getProvider(id))) return c.json({ error: "no such provider" }, 404);
  const parsed = keyBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "key required" }, 400);
  // A key travels in an HTTP header. Pasting from a terminal box or a rich-text field can
  // smuggle in a box-drawing character or a non-breaking space, and every call then fails
  // with "Invalid header value"; refuse it here and name the culprit.
  const bad = badHeaderChar(parsed.data.key);
  if (bad !== null)
    return c.json(
      {
        error: `the key contains a character that cannot go in a header: ${JSON.stringify(bad)}. Paste it again from the provider's console.`,
      },
      400,
    );
  const keyHint = await setProviderKey(id, parsed.data.key, admin.userID);
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

// ---- Guided reviews -----------------------------------------------------------------

const reviewBody = z.object({
  pullId: z.string().min(1),
  providerId: z.string().optional(),
  model: z.string().max(200).optional(),
});
/** Queue a walkthrough of a pull request; progress streams through the guided_review row. */
/** Generation is the expensive action: a dozen per person per ten minutes is plenty. */
const reviewLimiter = new RateLimiter(12, 10 * 60_000);

app.post("/api/reviews", async (c) => {
  const ctx = await contextFromRequest(c.req.raw);
  if (!ctx) return c.json({ error: "sign in first" }, 401);
  const gate = reviewLimiter.take(ctx.userID);
  if (!gate.ok)
    return c.json(
      { error: `slow down: try again in ${Math.ceil(gate.retryAfterMs / 1000)} s` },
      429,
    );
  const parsed = reviewBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "pullId required" }, 400);
  const { pullId } = parsed.data;
  const [pull] = await sql<
    {
      id: string;
      repo_id: string;
      review_provider_id: string | null;
      review_model: string | null;
      review_budget_tokens: number;
      spent: number;
    }[]
  >`select p.id, p.repo_id, r.review_provider_id, r.review_model, r.review_budget_tokens,
      coalesce((select sum(input_tokens + output_tokens) from guided_review where repo_id = r.id), 0)::int as spent
      from pull p join repo r on r.id = p.repo_id where p.id = ${pullId}`;
  if (!pull) return c.json({ error: "no such pull request" }, 404);
  if (overBudget(pull.spent, pull.review_budget_tokens))
    return c.json(
      { error: "this repository's review token budget is spent; raise it under System" },
      400,
    );
  const providerId = parsed.data.providerId ?? pull.review_provider_id;
  const model = parsed.data.model ?? pull.review_model;
  if (!providerId || !model)
    return c.json({ error: "pick a provider and model in System → Guided reviews first" }, 400);
  if (isGenerating(pullId)) return c.json({ error: "a review is already generating" }, 409);
  const blocker = await generationBlocker(systemOne);
  if (blocker) return c.json({ error: blocker }, 503);
  const id = newId();
  await sql`insert into guided_review (id, pull_id, repo_id, provider_id, model, created_by)
    values (${id}, ${pullId}, ${pull.repo_id}, ${providerId}, ${model}, ${ctx.userID})`;
  void runReviewJob(id, { systemOne });
  return c.json({ id }, 202);
});

/**
 * jev behind the agent's `rank_files` tool: which of the candidate paths are relevant to the
 * question. Called by the reviewer cell, never by browsers: the shared token gates it when
 * one is configured, and loopback is required otherwise.
 */
const rerankBody = z.object({
  repo: z.string().min(3),
  trace: z
    .object({
      endpoint: z.string(),
      project: z.string(),
      traceId: z.string(),
      parentSpanId: z.string().nullable(),
    })
    .nullable()
    .optional(),
  question: z.string().min(1).max(500),
  candidates: z.array(z.string().min(1).max(500)).min(1).max(40),
});
app.post("/api/internal/rerank", async (c) => {
  const token = c.req.header("x-reviewer-token") ?? null;
  const host = c.req.header("host") ?? "";
  const local = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
  if (env.reviewCellToken ? token !== env.reviewCellToken : !local)
    return c.json({ error: "reviewer only" }, 403);
  if (!systemOne) return c.json({ error: "no classifier configured" }, 503);
  const parsed = rerankBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "question and candidates required" }, 400);
  const { repo, question, candidates, trace } = parsed.data;
  const tracer = trace ? new Tracer(trace.endpoint, trace.project, "typeful-api") : Tracer.off();
  const span = tracer.start("rank_files", "RERANKER", trace ?? null, {
    [OI.inputValue]: JSON.stringify({ question, candidates }),
    [OI.inputMime]: "application/json",
  });
  const questions: Record<string, ReturnType<typeof noul>> = {};
  candidates.forEach((_, i) => {
    questions[`r${i}`] = noul(
      `Is \`candidates[${i}]\` likely to contain what the question needs? Judge from the path alone: its directory, name and extension.`,
      {
        true: "The path names the module, type, test or config the question is about, or a direct caller or definition of it",
        false: "Unrelated area, generated output, or a file the question would not need",
      },
    );
  });
  try {
    const result = await askSystemOne(
      systemOne,
      {
        repoId: repo,
        kind: "review_rerank",
        state: { question, candidates: candidates.map((path) => ({ path })) },
        questions,
        items: candidates.length,
      },
      { tracer, parent: span },
    );
    const ranked = candidates
      .map((path, i) => {
        const a = result.answers[`r${i}`] as { noul?: number } | undefined;
        return { path, relevance: a?.noul ?? 0 };
      })
      .sort((a, b) => b.relevance - a.relevance);
    tracer.end(span, {
      [OI.outputValue]: JSON.stringify(ranked),
      [OI.outputMime]: "application/json",
    });
    await tracer.flush();
    return c.json({ ranked });
  } catch (e) {
    tracer.end(span, {}, e);
    await tracer.flush();
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/** What the reviewer cells hold for a repository: snapshots and run records, with sizes. */
app.get("/api/repos/:owner/:name/cell", async (c) => {
  const ctx = await contextFromRequest(c.req.raw);
  if (!ctx) return c.json({ error: "sign in first" }, 401);
  if (!env.reviewCellUrl) return c.json({ configured: false });
  try {
    const res = await fetch(
      `${env.reviewCellUrl}/repos/${c.req.param("owner")}/${c.req.param("name")}/stats`,
      {
        headers: env.reviewCellToken ? { "x-reviewer-token": env.reviewCellToken } : {},
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return c.json({ configured: true, reachable: false });
    const stats = (await res.json()) as Record<string, unknown>;
    return c.json({ configured: true, reachable: true, ...stats });
  } catch {
    return c.json({ configured: true, reachable: false });
  }
});

app.delete("/api/repos/:owner/:name/cell/snapshots/:sha", async (c) => {
  const ctx = await contextFromRequest(c.req.raw);
  if (!ctx) return c.json({ error: "sign in first" }, 401);
  if (!env.reviewCellUrl) return c.json({ error: "no reviewer cell" }, 400);
  const sha = c.req.param("sha");
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return c.json({ error: "bad sha" }, 400);
  const res = await fetch(
    `${env.reviewCellUrl}/snapshots/${c.req.param("owner")}/${c.req.param("name")}/${sha}`,
    {
      method: "DELETE",
      headers: env.reviewCellToken ? { "x-reviewer-token": env.reviewCellToken } : {},
      signal: AbortSignal.timeout(10_000),
    },
  );
  return c.json({ ok: res.ok }, res.ok ? 200 : 502);
});

/** The unified diff a review was generated from, for rendering its steps. */
app.get("/api/reviews/:id/patch", async (c) => {
  const ctx = await contextFromRequest(c.req.raw);
  if (!ctx) return c.json({ error: "sign in first" }, 401);
  const [row] = await sql<{ patch: string }[]>`
    select patch from private.review_patch where review_id = ${c.req.param("id")}`;
  if (!row) return c.json({ error: "no patch stored" }, 404);
  return c.text(row.patch, 200, { "content-type": "text/x-diff; charset=utf-8" });
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
  const [row] = await sql<
    { id: string; revoked_at: Date | null }[]
  >`select id, revoked_at from "user" where id = ${ctx.userID}`;
  if (!row) return c.json({ error: "account no longer exists; sign in again" }, 401);
  if (row.revoked_at) return c.json({ error: "access was removed by an admin" }, 401);
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
  void failOrphanedReviews();
});

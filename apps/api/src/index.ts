import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { colorFor, mintToken, userIdFor } from "./auth.ts";
import { sql } from "./db.ts";
import { env } from "./env.ts";
import { syncRepo } from "./github/sync.ts";
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
    prices:
      env.priceInputPerMTok !== null && env.priceOutputPerMTok !== null
        ? { inputPerMTok: env.priceInputPerMTok, outputPerMTok: env.priceOutputPerMTok }
        : null,
  });
});

const devAuth = z.object({ name: z.string().trim().min(1).max(40) });
app.post("/api/auth/dev", async (c) => {
  const parsed = devAuth.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "name required" }, 400);
  const name = parsed.data.name;
  const userID = userIdFor(name);
  const color = colorFor(userID);
  await sql`insert into "user" (id, name, color) values (${userID}, ${name}, ${color})
    on conflict (id) do update set name = excluded.name`;
  const token = await mintToken({ userID, name, color });
  return c.json({ token, user: { userID, name, color } });
});

const syncBody = z.object({
  owner: z.string().trim().min(1),
  name: z.string().trim().min(1),
  /** Create the repo with classification paused (cost control for big repos). */
  paused: z.boolean().optional(),
});
app.post("/api/sync", async (c) => {
  const parsed = syncBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "owner and name required" }, 400);
  const { owner, name, paused } = parsed.data;
  try {
    const result = await syncRepo(owner, name, paused ?? false);
    poke(result.repoId, "sync");
    return c.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return c.json({ error: message }, 502);
  }
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

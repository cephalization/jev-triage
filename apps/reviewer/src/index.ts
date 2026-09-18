import { DurableObject } from "cloudflare:workers";
import { runNarrative, runSkeleton, type NarrativeBody, type SkeletonBody } from "./review.ts";
import { Tracer } from "@triage/triage/trace";
import { snapshotClient, type SnapshotClient } from "./agent.ts";
import { RepoSnapshot, type SnapshotStats } from "./snapshot.ts";

export { RepoSnapshot };

/**
 * The reviewer cell. The API drives a review in stages:
 *   POST /snapshots/{owner}/{repo}/{sha}   load the repository at that commit (once per head)
 *   POST /runs/{id}/skeleton               name the steps, with repository tools
 *   POST /runs/{id}/narrative              write one step, with repository tools (in parallel)
 *   GET  /repos/{owner}/{repo}/stats       what this repository's cells hold, for the settings page
 * One ReviewRun cell per review, one RepoSnapshot per commit, one RepoIndex per repository.
 */

export interface Env {
  REVIEW_RUN: DurableObjectNamespace<ReviewRun>;
  REPO_SNAPSHOT: DurableObjectNamespace<RepoSnapshot>;
  REPO_INDEX: DurableObjectNamespace<RepoIndex>;
  /** When set, requests must carry it as `x-reviewer-token`. */
  REVIEWER_TOKEN?: string;
}

const RUN = /^\/runs\/([A-Za-z0-9_-]{1,64})\/(skeleton|narrative)$/;
const SNAPSHOT = /^\/snapshots\/([\w.-]+)\/([\w.-]+)\/([0-9a-f]{7,40})(?:\/(file|list|grep))?$/;
const REPO = /^\/repos\/([\w.-]+)\/([\w.-]+)\/stats$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, now: Date.now() });
    if (env.REVIEWER_TOKEN && request.headers.get("x-reviewer-token") !== env.REVIEWER_TOKEN)
      return Response.json({ error: "bad reviewer token" }, { status: 401 });
    let m = RUN.exec(url.pathname);
    if (m) return env.REVIEW_RUN.get(env.REVIEW_RUN.idFromName(m[1]!)).fetch(request);
    m = SNAPSHOT.exec(url.pathname);
    if (m) {
      const name = `${m[1]}/${m[2]}@${m[3]}`;
      return env.REPO_SNAPSHOT.get(env.REPO_SNAPSHOT.idFromName(name)).fetch(request);
    }
    m = REPO.exec(url.pathname);
    if (m) {
      const name = `${m[1]}/${m[2]}`;
      return env.REPO_INDEX.get(env.REPO_INDEX.idFromName(name)).fetch("http://index/index/stats");
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

interface RunRecord {
  status: "running" | "ready" | "failed";
  startedAt: number;
  finishedAt: number | null;
  model: string;
  error: string | null;
  /** Calls this cell has served, for the repository's ledger. */
  calls: number;
  repo: string | null;
}

export class ReviewRun extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const stage = RUN.exec(new URL(request.url).pathname)?.[2] as "skeleton" | "narrative";
    if (request.method === "GET") {
      const rec = await this.ctx.storage.get<RunRecord>("run");
      return rec ? Response.json(rec) : Response.json({ error: "no run" }, { status: 404 });
    }
    if (request.method !== "POST") return Response.json({ error: "method" }, { status: 405 });
    let body: SkeletonBody | NarrativeBody;
    try {
      body = (await request.json()) as typeof body;
      if (!body?.provider?.apiKey || !body.model || !body.request || !body.snapshot || !body.repo)
        throw new Error("provider, model, repo, snapshot and request are required");
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "bad body" }, { status: 400 });
    }
    const rec = (await this.ctx.storage.get<RunRecord>("run")) ?? {
      status: "running" as const,
      startedAt: Date.now(),
      finishedAt: null,
      model: body.model,
      error: null,
      calls: 0,
      repo: null,
    };
    rec.calls += 1;
    rec.repo = (body as { repo?: string }).repo ?? rec.repo;
    // The key is never stored: only what is needed to answer a later GET.
    await this.ctx.storage.put("run", rec);
    try {
      const host = {
        snapshot: this.#snapshot(body),
        callback: body.callback,
        repo: body.repo,
        tracer: body.trace
          ? new Tracer(body.trace.endpoint, body.trace.project, "typeful-reviewer")
          : Tracer.off("typeful-reviewer"),
      };
      const out =
        stage === "skeleton"
          ? await runSkeleton(body as SkeletonBody, host)
          : await runNarrative(body as NarrativeBody, host);
      await this.#report(rec);
      return Response.json(out);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await this.ctx.storage.put("run", {
        ...rec,
        status: "failed",
        finishedAt: Date.now(),
        error,
      });
      return Response.json({ error }, { status: 502 });
    }
  }

  /** The snapshot the request names; every stage reads the repository through it. */
  #snapshot(body: SkeletonBody | NarrativeBody): SnapshotClient {
    const s = body.snapshot;
    const id = this.env.REPO_SNAPSHOT.idFromName(`${s.owner}/${s.repo}@${s.sha}`);
    return snapshotClient(
      this.env.REPO_SNAPSHOT.get(id),
      `/snapshots/${s.owner}/${s.repo}/${s.sha}`,
    );
  }

  async #report(rec: RunRecord) {
    if (!rec.repo) return;
    const index = this.env.REPO_INDEX.get(this.env.REPO_INDEX.idFromName(rec.repo));
    await index.fetch("http://index/index/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: this.ctx.id.toString(),
        bytes: JSON.stringify(rec).length,
        calls: rec.calls,
        createdAt: rec.startedAt,
      }),
    });
  }
}

/**
 * Per-repository ledger of what the cells hold, because a namespace cannot list its objects.
 * Snapshots report themselves when they load or clear; runs report on every call.
 */
export class RepoIndex extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS snapshot (sha TEXT PRIMARY KEY, status TEXT NOT NULL, files INTEGER NOT NULL, bytes INTEGER NOT NULL, db_bytes INTEGER NOT NULL, error TEXT, created_at INTEGER, last_used_at INTEGER);
       CREATE TABLE IF NOT EXISTS run (id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, calls INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sql = this.ctx.storage.sql;
    if (url.pathname === "/index/snapshot" && request.method === "POST") {
      const s = (await request.json()) as SnapshotStats;
      sql.exec(
        `INSERT INTO snapshot (sha, status, files, bytes, db_bytes, error, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sha) DO UPDATE SET status = excluded.status, files = excluded.files, bytes = excluded.bytes,
           db_bytes = excluded.db_bytes, error = excluded.error, created_at = excluded.created_at, last_used_at = excluded.last_used_at`,
        s.sha,
        s.status,
        s.files,
        s.bytes,
        s.dbBytes,
        s.error,
        s.createdAt,
        Date.now(),
      );
      return Response.json({ ok: true });
    }
    const del = /^\/index\/snapshot\/([0-9a-f]+)$/.exec(url.pathname);
    if (del && request.method === "DELETE") {
      sql.exec("DELETE FROM snapshot WHERE sha = ?", del[1]);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/index/run" && request.method === "POST") {
      const r = (await request.json()) as {
        id: string;
        bytes: number;
        calls: number;
        createdAt: number;
      };
      sql.exec(
        `INSERT INTO run (id, bytes, calls, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET bytes = excluded.bytes, calls = excluded.calls`,
        r.id,
        r.bytes,
        r.calls,
        r.createdAt,
      );
      return Response.json({ ok: true });
    }
    const snapshots = sql
      .exec<{
        sha: string;
        status: string;
        files: number;
        bytes: number;
        db_bytes: number;
        error: string | null;
        created_at: number | null;
        last_used_at: number | null;
      }>("SELECT * FROM snapshot ORDER BY last_used_at DESC")
      .toArray();
    const runs = sql
      .exec<{ n: number; bytes: number | null; calls: number | null }>(
        "SELECT count(*) AS n, sum(bytes) AS bytes, sum(calls) AS calls FROM run",
      )
      .one();
    return Response.json({
      snapshots: snapshots.map((s) => ({
        sha: s.sha,
        status: s.status,
        files: s.files,
        bytes: s.bytes,
        dbBytes: s.db_bytes,
        error: s.error,
        createdAt: s.created_at,
        lastUsedAt: s.last_used_at,
      })),
      runs: { count: runs.n, bytes: runs.bytes ?? 0, calls: runs.calls ?? 0 },
      indexBytes: sql.databaseSize,
    });
  }
}

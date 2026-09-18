import { DurableObject } from "cloudflare:workers";
import { runReview, type RunBody, type RunResult } from "./review.ts";

/**
 * The reviewer cell. The API posts a run to `/runs/{reviewId}`; the ReviewRun cell for that
 * id performs the generation and answers with the result, keeping a record of the run in its
 * own storage. One cell per review, single-threaded, so a repeated post waits its turn.
 */

export interface Env {
  REVIEW_RUN: DurableObjectNamespace<ReviewRun>;
  /** When set, requests must carry it as `x-reviewer-token`. */
  REVIEWER_TOKEN?: string;
}

const RUN_PATH = /^\/runs\/([A-Za-z0-9_-]{1,64})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, now: Date.now() });
    if (env.REVIEWER_TOKEN && request.headers.get("x-reviewer-token") !== env.REVIEWER_TOKEN)
      return Response.json({ error: "bad reviewer token" }, { status: 401 });
    const m = RUN_PATH.exec(url.pathname);
    if (!m) return Response.json({ error: "not found" }, { status: 404 });
    const stub = env.REVIEW_RUN.get(env.REVIEW_RUN.idFromName(m[1]!));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

interface RunRecord {
  status: "running" | "ready" | "failed";
  startedAt: number;
  finishedAt: number | null;
  model: string;
  error: string | null;
  result: RunResult | null;
}

export class ReviewRun extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const rec = await this.ctx.storage.get<RunRecord>("run");
      return rec ? Response.json(rec) : Response.json({ error: "no run" }, { status: 404 });
    }
    if (request.method !== "POST") return Response.json({ error: "method" }, { status: 405 });
    let body: RunBody;
    try {
      body = (await request.json()) as RunBody;
      if (!body?.provider?.apiKey || !body.model || !body.request?.patch)
        throw new Error("provider, model and request.patch are required");
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "bad body" }, { status: 400 });
    }
    const rec: RunRecord = {
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      model: body.model,
      error: null,
      result: null,
    };
    // The key is never stored: only what is needed to answer a later GET.
    await this.ctx.storage.put("run", rec);
    try {
      const result = await runReview(body);
      await this.ctx.storage.put("run", {
        ...rec,
        status: "ready",
        finishedAt: Date.now(),
        result,
      });
      return Response.json(result);
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
}

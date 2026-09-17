import { mustGetMutator, mustGetQuery } from "@rocicorp/zero";
import { handleMutateRequest, handleQueryRequest } from "@rocicorp/zero/server";
import { queries, schema } from "@triage/schema";
import { Hono } from "hono";
import { contextFromRequest } from "../auth.ts";
import { dbProvider } from "../db.ts";
import { createServerMutators } from "./server-mutators.ts";

export function zeroRoutes(poke: (repoId: string, reason: string) => void) {
  const app = new Hono();

  app.post("/api/query", async (c) => {
    const ctx = await contextFromRequest(c.req.raw);
    const result = await handleQueryRequest({
      handler: (name, args) => {
        const query = mustGetQuery(queries, name);
        return query.fn({ args, ctx });
      },
      schema,
      request: c.req.raw,
      userID: ctx?.userID,
    });
    return c.json(result);
  });

  app.post("/api/mutate", async (c) => {
    const ctx = await contextFromRequest(c.req.raw);
    if (!ctx) console.warn("[mutate] request without a valid token; mutators will refuse writes");
    const asyncTasks: Array<() => Promise<void>> = [];
    const serverMutators = createServerMutators(asyncTasks, poke);
    const result = await handleMutateRequest({
      dbProvider,
      handler: (transact) =>
        transact(async (tx, name, args) => {
          const mutator = mustGetMutator(serverMutators, name);
          try {
            await mutator.fn({ tx, ctx, args });
          } catch (e) {
            console.warn(`[mutate] ${name} failed:`, e instanceof Error ? e.message : e);
            throw e;
          }
        }),
      request: c.req.raw,
      userID: ctx?.userID,
    });
    await Promise.allSettled(asyncTasks.map((t) => t()));
    return c.json(result);
  });

  return app;
}

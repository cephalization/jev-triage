import { defineQueries, defineQuery } from "@rocicorp/zero";
import { z } from "zod";
import { zql } from "./schema.ts";

/**
 * Synced queries. Each runs on the client against the local replica and again on
 * the server (apps/api /api/query) where the same definition is used to produce ZQL
 * for zero-cache. Everything is readable by everyone, so the server adds no filters.
 */

export const issueFilterArgs = z.object({
  repoId: z.string(),
  state: z.enum(["open", "closed", "all"]).default("open"),
  search: z.string().default(""),
  limit: z.number().int().min(1).max(2000).default(500),
});

export const queries = defineQueries({
  users: {
    all: defineQuery(() => zql.user.orderBy("name", "asc")),
  },
  repos: {
    all: defineQuery(() => zql.repo.orderBy("id", "asc").related("workerState")),
    byId: defineQuery(z.string(), ({ args: id }) =>
      zql.repo.where("id", id).related("workerState").related("labels").one(),
    ),
  },
  issues: {
    byRepo: defineQuery(issueFilterArgs, ({ args }) => {
      let q = zql.issue.where("repo_id", args.repoId);
      if (args.state !== "all") q = q.where("state", args.state);
      if (args.search.trim()) {
        const needle = `%${args.search.trim().replaceAll("%", "")}%`;
        q = q.where((eb) =>
          eb.or(eb.cmp("title", "ILIKE", needle), eb.cmp("body", "ILIKE", needle)),
        );
      }
      return q
        .orderBy("updated_at", "desc")
        .limit(args.limit)
        .related("classifications", (c) => c.orderBy("created_at", "desc"))
        .related("feedback", (f) => f.orderBy("created_at", "desc"))
        .related("labels")
        .related("presence");
    }),
    byId: defineQuery(z.string(), ({ args: id }) =>
      zql.issue
        .where("id", id)
        .one()
        .related("classifications", (c) => c.orderBy("created_at", "desc"))
        .related("feedback", (f) => f.orderBy("created_at", "desc").related("user"))
        .related("labels")
        .related("presence"),
    ),
    byIds: defineQuery(z.array(z.string()), ({ args: ids }) => zql.issue.where("id", "IN", ids)),
  },
  runs: {
    byRepo: defineQuery(
      z.object({ repoId: z.string(), limit: z.number().int().default(30) }),
      ({ args }) =>
        zql.run.where("repo_id", args.repoId).orderBy("started_at", "desc").limit(args.limit),
    ),
  },
  feedback: {
    byRepo: defineQuery(
      z.object({ repoId: z.string(), limit: z.number().int().default(300) }),
      ({ args }) =>
        zql.feedback
          .where("repo_id", args.repoId)
          .orderBy("created_at", "desc")
          .limit(args.limit)
          .related("user")
          .related("issue"),
    ),
  },
  presence: {
    /** Small table; clients filter by updated_at themselves so the query args never change. */
    all: defineQuery(() => zql.presence.orderBy("name", "asc")),
  },
});

export type Queries = typeof queries;

import { zeroPostgresJS } from "@rocicorp/zero/server/adapters/postgresjs";
import { schema } from "@triage/schema";
import postgres from "postgres";
import { env } from "./env.ts";

/** Single postgres.js pool shared by raw SQL (sync, worker) and Zero's mutate endpoint. */
export const sql = postgres(env.upstreamDb, { max: 10, onnotice: () => {} });

/** Zero gets its own small pool; the adapter's generic does not line up with ours. */
export const dbProvider = zeroPostgresJS(schema, env.upstreamDb);

declare module "@rocicorp/zero" {
  interface DefaultTypes {
    dbProvider: typeof dbProvider;
  }
}

export function newId(): string {
  return crypto.randomUUID();
}

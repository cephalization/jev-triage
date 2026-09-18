import { sql } from "./db.ts";

/**
 * Sessions are stateless 30-day tokens, so ending someone's access needs one server-side
 * check: the set of revoked user ids, refreshed from the database every few seconds and
 * updated at once when an admin revokes or re-invites.
 */

const REFRESH_MS = 15_000;
let revoked = new Set<string>();
let loadedAt = 0;
let loading: Promise<void> | null = null;

async function refresh(): Promise<void> {
  try {
    const rows = await sql<{ id: string }[]>`select id from "user" where revoked_at is not null`;
    revoked = new Set(rows.map((r) => r.id));
    loadedAt = Date.now();
  } catch (e) {
    // Without the database nothing else works either; keep the last known set.
    console.warn(
      `[auth] could not load revoked users: ${e instanceof Error ? e.message : String(e)}`,
    );
    loadedAt = Date.now();
  }
}

export async function isRevoked(userId: string): Promise<boolean> {
  if (Date.now() - loadedAt > REFRESH_MS) {
    loading ??= refresh().finally(() => {
      loading = null;
    });
    await loading;
  }
  return revoked.has(userId);
}

/** Flip a login's access now, ahead of the next refresh. Admins from env cannot be revoked. */
export async function setRevoked(login: string, on: boolean): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    update "user" set revoked_at = ${on ? sql`now()` : null}
    where lower(login) = ${login.toLowerCase()} and role <> 'admin' returning id`;
  for (const r of rows) {
    if (on) revoked.add(r.id);
    else revoked.delete(r.id);
  }
}

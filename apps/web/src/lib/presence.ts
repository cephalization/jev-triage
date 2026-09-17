import { useQuery, useZero } from "@rocicorp/zero/react";
import { mutators, queries } from "@triage/schema";
import { useEffect, useMemo, useState } from "react";
import { activeUsers, type PresenceLike } from "./derive.ts";

export const PRESENCE_TTL_MS = 45_000;
const HEARTBEAT_MS = 15_000;
const CLIENT_KEY = "typeful-triage.client";

/** Stable per-tab id: sessionStorage is per tab, so two tabs of one user get two rows. */
export function clientId(): string {
  try {
    const existing = sessionStorage.getItem(CLIENT_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    sessionStorage.setItem(CLIENT_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

/**
 * Sends a heartbeat every 15 s with what this tab is looking at. A heartbeat the server
 * rejects (dead session, schema mismatch) is reported so the app can re-check the session
 * instead of showing an optimistic row that keeps vanishing.
 */
export function usePresenceHeartbeat(
  repoId: string | null,
  issueId: string | null,
  onRejected?: (error: unknown) => void,
) {
  const z = useZero();
  useEffect(() => {
    const id = clientId();
    const beat = () => {
      const result = z.mutate(mutators.presence.heartbeat({ clientId: id, repoId, issueId }));
      result.server.catch((e: unknown) => onRejected?.(e));
      result.client.catch(() => {});
    };
    beat();
    const t = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [z, repoId, issueId, onRejected]);
}

/** Ticks so stale presence rows drop out of the UI without a query change. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Fresh presence rows collapsed to one entry per user. */
export function viewersOf<P extends PresenceLike>(rows: readonly P[], now: number) {
  return activeUsers(rows, now, PRESENCE_TTL_MS);
}

export function useOnline() {
  const [rows] = useQuery(queries.presence.all());
  const now = useNow();
  return useMemo(() => viewersOf(rows, now), [rows, now]);
}

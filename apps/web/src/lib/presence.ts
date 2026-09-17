import { useQuery, useZero } from "@rocicorp/zero/react";
import { mutators, queries } from "@triage/schema";
import { useEffect, useState } from "react";

export const PRESENCE_TTL_MS = 45_000;
const HEARTBEAT_MS = 15_000;

/** Sends a heartbeat every 15 s with what this user is looking at. */
export function usePresenceHeartbeat(repoId: string | null, issueId: string | null) {
  const z = useZero();
  useEffect(() => {
    const beat = () => void z.mutate(mutators.presence.heartbeat({ repoId, issueId }));
    beat();
    const t = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [z, repoId, issueId]);
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

export function useOnline() {
  const [rows] = useQuery(queries.presence.all());
  const now = useNow();
  return rows.filter((p) => p.updated_at > now - PRESENCE_TTL_MS);
}

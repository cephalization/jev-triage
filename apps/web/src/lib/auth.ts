import type { ZeroContext } from "@triage/schema";

const KEY = "typeful-triage.session";

export interface Session {
  token: string;
  user: ZeroContext;
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (!s.token || !s.user?.userID) return null;
    return s;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable (private mode); the session just lives in memory
  }
}

export async function devLogin(name: string): Promise<Session> {
  const res = await fetch("/api/auth/dev", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`login failed (${res.status})`);
  const data = (await res.json()) as Session;
  saveSession(data);
  return data;
}

/** True when the API still accepts this token; null when the API cannot be reached. */
export async function verifySession(s: Session): Promise<boolean | null> {
  try {
    const res = await fetch("/api/auth/me", { headers: { authorization: `Bearer ${s.token}` } });
    if (res.status === 401) return false;
    return res.ok ? true : null;
  } catch {
    return null;
  }
}

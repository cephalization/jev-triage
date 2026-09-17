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

/** Where the browser goes to start the GitHub OAuth flow; the API redirects back with a token. */
export const GITHUB_LOGIN_URL = "/api/auth/github/start";

export class LoginError extends Error {
  login: string | undefined;
  constructor(message: string, login?: string) {
    super(message);
    this.login = login;
  }
}

/** Sign in with a GitHub token (a personal access token, or an emulator token). */
export async function tokenLogin(token: string): Promise<Session> {
  const res = await fetch("/api/auth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<Session> & {
    error?: string;
    login?: string;
  };
  if (!res.ok || !data.token || !data.user)
    throw new LoginError(data.error ?? `sign-in failed (${res.status})`, data.login);
  saveSession(data as Session);
  return data as Session;
}

/** Turn a token into a session by asking the API who it belongs to. */
export async function sessionFromToken(token: string): Promise<Session | null> {
  const res = await fetch("/api/auth/me", { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const { user } = (await res.json()) as { user: ZeroContext };
  const s = { token, user };
  saveSession(s);
  return s;
}

/**
 * The OAuth callback lands on the app with the outcome in the URL fragment, which never reaches
 * a server log. Read it once and clear it.
 */
export function takeAuthFragment(): { token?: string; error?: string; login?: string } {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return {};
  const p = new URLSearchParams(hash);
  const out = {
    token: p.get("session") ?? undefined,
    error: p.get("auth_error") ?? undefined,
    login: p.get("login") ?? undefined,
  };
  if (out.token || out.error)
    history.replaceState(null, "", window.location.pathname + window.location.search);
  return out;
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

export interface AuthInfo {
  /** GitHub OAuth is configured on the server (client id present). */
  github: boolean;
  /** GitHub calls go to an emulator rather than github.com. */
  emulated: boolean;
}

export async function fetchAuthInfo(): Promise<AuthInfo> {
  try {
    const res = await fetch("/api/health");
    const h = (await res.json()) as { auth?: AuthInfo };
    return h.auth ?? { github: false, emulated: false };
  } catch {
    return { github: false, emulated: false };
  }
}

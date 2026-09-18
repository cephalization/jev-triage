import type { Role } from "@triage/schema";

/**
 * Who may sign in, and as what. Pure: the routes gather the facts (env admins, the invite row)
 * and this decides. Both sign-in paths (OAuth and token) end here so they cannot drift.
 */

export interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

export interface InviteLike {
  role: string;
}

export type Resolution =
  | { ok: true; role: Role; viaInvite: boolean }
  | { ok: false; reason: "not_invited" };

export function resolveAccount(
  login: string,
  facts: { adminLogins: readonly string[]; invite: InviteLike | null },
): Resolution {
  const l = login.trim().toLowerCase();
  if (!l) return { ok: false, reason: "not_invited" };
  if (facts.adminLogins.includes(l)) return { ok: true, role: "admin", viaInvite: false };
  if (facts.invite)
    return { ok: true, role: facts.invite.role === "admin" ? "admin" : "member", viaInvite: true };
  return { ok: false, reason: "not_invited" };
}

/** Stable user id from the GitHub numeric id, so renames keep history. */
export function userIdFor(githubId: number): string {
  return `gh_${githubId}`;
}

const UA = "typeful-triage";

/** `GET /user` with a token from either flow; throws with the status on failure. */
export async function fetchGithubUser(apiUrl: string, token: string): Promise<GithubUser> {
  const res = await fetch(`${apiUrl}/user`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": UA,
    },
  });
  if (!res.ok) throw new Error(`GitHub rejected the token (${res.status})`);
  const u = (await res.json()) as Partial<GithubUser>;
  if (typeof u.id !== "number" || typeof u.login !== "string")
    throw new Error("GitHub returned no user");
  return { id: u.id, login: u.login, name: u.name ?? null, avatar_url: u.avatar_url ?? null };
}

/** OAuth web flow, step two: the code from the callback becomes a user token. */
export async function exchangeCode(
  oauthUrl: string,
  args: { clientId: string; clientSecret: string; code: string; redirectUri: string },
): Promise<string> {
  const res = await fetch(`${oauthUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      redirect_uri: args.redirectUri,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token)
    throw new Error(
      data.error_description ?? data.error ?? `token exchange failed (${res.status})`,
    );
  return data.access_token;
}

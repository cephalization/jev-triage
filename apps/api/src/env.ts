function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return v;
}

function optionalNumber(name: string): number | null {
  const v = process.env[name]?.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function url(name: string, fallback: string): string {
  return (process.env[name]?.trim() || fallback).replace(/\/+$/, "");
}

const githubApiUrl = url("GITHUB_API_URL", "https://api.github.com");

export const env = {
  port: Number(process.env.API_PORT ?? 3939),
  upstreamDb: required("ZERO_UPSTREAM_DB"),
  authSecret: required("AUTH_SECRET"),
  typesafeKey: process.env.TYPESAFE_API_KEY?.trim() || null,
  typesafeModel: process.env.TYPESAFE_DEFAULT_MODEL?.trim() || undefined,
  /** Server token for sync. Sign-in uses each person's own GitHub identity, not this. */
  githubToken: process.env.GITHUB_TOKEN?.trim() || null,
  /** Both default to github.com; point them at an emulator for offline development. */
  githubApiUrl,
  githubOauthUrl: url("GITHUB_OAUTH_URL", "https://github.com"),
  /** Where repository sync reads from; defaults to the same API, split so sign-in can be emulated while sync stays real. */
  githubSyncApiUrl: url("GITHUB_SYNC_API_URL", githubApiUrl),
  githubClientId: process.env.GITHUB_CLIENT_ID?.trim() || null,
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET?.trim() || null,
  /** Where the browser lives; the OAuth callback and the post-login redirect are built from it. */
  appUrl: url("APP_URL", "http://localhost:5173"),
  /** Always allowed, always admin, no invite needed. */
  adminLogins: (process.env.ADMIN_GITHUB_LOGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  priceInputPerMTok: optionalNumber("TYPESAFE_PRICE_INPUT_PER_MTOK"),
  priceOutputPerMTok: optionalNumber("TYPESAFE_PRICE_OUTPUT_PER_MTOK"),
};

import { existsSync } from "node:fs";
import path from "node:path";
import {
  apiPort,
  appUrl,
  isLocalUrl,
  reviewCellApiUrl,
  reviewCellPhoenixUrl,
  zeroCacheUrl,
} from "./urls.ts";

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

/** The built web app to serve from this process, when it exists; unset in development. */
function webDist(): string | null {
  const dir = process.env.WEB_DIST?.trim();
  if (!dir) return null;
  const abs = path.resolve(dir);
  if (!existsSync(path.join(abs, "index.html"))) {
    console.warn(`[api] WEB_DIST=${dir} has no index.html; not serving the web app`);
    return null;
  }
  return abs;
}

const githubApiUrl = url("GITHUB_API_URL", "https://api.github.com");
const phoenixEndpoint = process.env.PHOENIX_COLLECTOR_ENDPOINT?.trim().replace(/\/+$/, "") || null;
const reviewCellUrl = process.env.REVIEW_CELL_URL?.trim().replace(/\/+$/, "") || null;
const reviewCellToken = process.env.REVIEWER_TOKEN?.trim() || null;
// Provider keys and the GitHub token travel to the cell inside requests; past this machine
// that link must be authenticated on both ends.
if (reviewCellUrl && !isLocalUrl(reviewCellUrl) && !reviewCellToken)
  throw new Error(
    `REVIEWER_TOKEN is required when REVIEW_CELL_URL (${reviewCellUrl}) is not on this machine`,
  );

export const env = {
  port: apiPort(process.env),
  upstreamDb: required("ZERO_UPSTREAM_DB"),
  authSecret: required("AUTH_SECRET"),
  /** Seals provider API keys at rest. Falls back to AUTH_SECRET so a fresh clone still works. */
  configSecret: process.env.CONFIG_SECRET?.trim() || required("AUTH_SECRET"),
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
  /** Where the browser lives; the OAuth callback, the post-login redirect and CORS are built from it. */
  appUrl: appUrl(process.env),
  /** Where browsers reach zero-cache; handed to the web app at runtime. */
  zeroCacheUrl: zeroCacheUrl(process.env),
  /** The built web app, served by this process on one origin; null leaves that to `vp dev`. */
  webDist: webDist(),
  /** Always allowed, always admin, no invite needed. */
  adminLogins: (process.env.ADMIN_GITHUB_LOGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  /** The reviewer cell (apps/reviewer). Unset means reviews run inside this process. */
  reviewCellUrl,
  reviewCellToken,
  /** How the cell reaches this API and Phoenix from where it runs. */
  reviewCellApiUrl: reviewCellApiUrl(process.env),
  reviewCellPhoenixUrl: reviewCellPhoenixUrl(process.env, phoenixEndpoint),
  /** Arize Phoenix (OTLP/HTTP) for guided-review traces; the compose file serves it on 7006. */
  phoenixEndpoint,
  /** A Phoenix API key, for an instance with authentication on; sent by the API and the cell. */
  phoenixApiKey: process.env.PHOENIX_API_KEY?.trim() || null,
  phoenixProject: process.env.PHOENIX_PROJECT_NAME?.trim() || "typeful-triage",
  priceInputPerMTok: optionalNumber("TYPESAFE_PRICE_INPUT_PER_MTOK"),
  priceOutputPerMTok: optionalNumber("TYPESAFE_PRICE_OUTPUT_PER_MTOK"),
};

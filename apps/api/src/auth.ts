import type { Role, ZeroContext } from "@triage/schema";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { env } from "./env.ts";
import { isRevoked } from "./revoked.ts";

const key = new TextEncoder().encode(env.authSecret);

const PALETTE = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#d97706",
  "#7c3aed",
  "#db2777",
  "#0891b2",
  "#65a30d",
  "#ea580c",
  "#4f46e5",
];

export function colorFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

/** Sessions are 30-day HS256 tokens carrying the whole context; the API keeps no session state. */
export async function mintToken(user: ZeroContext): Promise<string> {
  return new SignJWT({
    name: user.name,
    color: user.color,
    login: user.login,
    role: user.role,
    avatar: user.avatarUrl,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.userID)
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(key);
}

export async function verifyToken(token: string): Promise<ZeroContext | undefined> {
  try {
    const { payload } = await jwtVerify(token, key);
    // Tokens from before accounts existed carry no login; refusing them signs those tabs out.
    if (!payload.sub || typeof payload.name !== "string" || typeof payload.login !== "string")
      return undefined;
    return {
      userID: payload.sub,
      name: payload.name,
      color: typeof payload.color === "string" ? payload.color : colorFor(payload.sub),
      login: payload.login,
      role: payload.role === "admin" ? "admin" : ("member" satisfies Role),
      avatarUrl: typeof payload.avatar === "string" ? payload.avatar : null,
    };
  } catch {
    return undefined;
  }
}

/** zero-cache forwards the client's token as `Authorization: Bearer <jwt>`. */
export async function contextFromRequest(req: Request): Promise<ZeroContext | undefined> {
  const h = req.headers.get("authorization");
  if (!h?.toLowerCase().startsWith("bearer ")) return undefined;
  const ctx = await verifyToken(h.slice(7).trim());
  if (ctx && (await isRevoked(ctx.userID))) return undefined;
  return ctx;
}

// ---- OAuth state ----------------------------------------------------------

const STATE_TTL_MS = 10 * 60_000;

function sign(body: string): string {
  return createHmac("sha256", env.authSecret).update(body).digest("base64url");
}

/** A signed nonce with a timestamp, so the callback can reject forged or stale states. */
export function newState(): string {
  const body = `${Date.now()}.${randomBytes(12).toString("base64url")}`;
  return `${body}.${sign(body)}`;
}

export function checkState(state: string | undefined, now = Date.now()): boolean {
  if (!state) return false;
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [ts, nonce, sig] = parts as [string, string, string];
  const expected = sign(`${ts}.${nonce}`);
  if (sig.length !== expected.length) return false;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const t = Number(ts);
  return Number.isFinite(t) && now - t >= 0 && now - t < STATE_TTL_MS;
}

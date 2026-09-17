import type { ZeroContext } from "@triage/schema";
import { createHash } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { env } from "./env.ts";

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

export function userIdFor(name: string): string {
  return `u_${createHash("sha256").update(name.trim().toLowerCase()).digest("hex").slice(0, 12)}`;
}

export function colorFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export async function mintToken(user: ZeroContext): Promise<string> {
  return new SignJWT({ name: user.name, color: user.color })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.userID)
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(key);
}

export async function verifyToken(token: string): Promise<ZeroContext | undefined> {
  try {
    const { payload } = await jwtVerify(token, key);
    if (!payload.sub || typeof payload.name !== "string") return undefined;
    return {
      userID: payload.sub,
      name: payload.name,
      color: typeof payload.color === "string" ? payload.color : colorFor(payload.sub),
    };
  } catch {
    return undefined;
  }
}

/** zero-cache forwards the client's token as `Authorization: Bearer <jwt>`. */
export async function contextFromRequest(req: Request): Promise<ZeroContext | undefined> {
  const h = req.headers.get("authorization");
  if (!h?.toLowerCase().startsWith("bearer ")) return undefined;
  return verifyToken(h.slice(7).trim());
}

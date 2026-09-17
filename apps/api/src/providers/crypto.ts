import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Provider keys at rest: AES-256-GCM under a key derived from CONFIG_SECRET. The ciphertext
 * lives in a table outside Zero's publication, so it is never replicated; only a hint (the
 * last characters) is shown to admins.
 */

export function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(`typeful-triage:provider-key:${secret}`).digest();
}

/** `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(
    ".",
  );
}

export function decrypt(sealed: string, key: Buffer): string {
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("unrecognised sealed key");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString(
    "utf8",
  );
}

/** What admins see instead of the key: its length class and last four characters. */
export function hint(plain: string): string {
  const tail = plain.slice(-4);
  return plain.length > 4 ? `…${tail}` : "set";
}

import type { ProviderKind } from "@triage/schema";
import { sql } from "../db.ts";
import { env } from "../env.ts";
import { decrypt, deriveKey, encrypt, hint } from "./crypto.ts";
import { KINDS, isKind } from "./catalog.ts";

/** Server-only access to provider secrets. Nothing here is reachable from Zero. */

const key = deriveKey(env.configSecret);

export interface ProviderRow {
  id: string;
  kind: string;
  label: string;
  base_url: string;
  key_hint: string | null;
}

export async function getProvider(id: string): Promise<ProviderRow | null> {
  const [row] = await sql<ProviderRow[]>`
    select id, kind, label, base_url, key_hint from provider where id = ${id}`;
  return row ?? null;
}

export async function setProviderKey(providerId: string, plain: string): Promise<string> {
  const sealed = encrypt(plain, key);
  const h = hint(plain);
  await sql.begin(async (tx) => {
    await tx`insert into private.provider_key (provider_id, sealed) values (${providerId}, ${sealed})
      on conflict (provider_id) do update set sealed = excluded.sealed, updated_at = now()`;
    await tx`update provider set key_hint = ${h}, updated_at = now() where id = ${providerId}`;
  });
  return h;
}

export async function clearProviderKey(providerId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`delete from private.provider_key where provider_id = ${providerId}`;
    await tx`update provider set key_hint = null, updated_at = now() where id = ${providerId}`;
  });
}

/** The plaintext key, for the server's own calls to the provider. Null when none is set. */
export async function loadProviderKey(providerId: string): Promise<string | null> {
  const [row] = await sql<{ sealed: string }[]>`
    select sealed from private.provider_key where provider_id = ${providerId}`;
  return row ? decrypt(row.sealed, key) : null;
}

/** A provider resolved for use by a runner: base URL, the env var its CLI reads, the key. */
export async function resolveProvider(
  providerId: string,
): Promise<{ kind: ProviderKind; baseUrl: string; keyEnv: string; key: string } | null> {
  const p = await getProvider(providerId);
  if (!p || !isKind(p.kind)) return null;
  const k = await loadProviderKey(providerId);
  if (!k) return null;
  return { kind: p.kind, baseUrl: p.base_url, keyEnv: KINDS[p.kind].keyEnv, key: k };
}

import type { SystemOne } from "@triage/triage";
import {
  APIError,
  TypeSafeClient,
  type EntryType,
  type Questions,
  type SystemOneResult,
} from "@typesafe-ai/sdk";

/** The only place the TypeSafe SDK is constructed. Never imported by apps/web. */
export class TypeSafeSystemOne implements SystemOne {
  readonly #client: TypeSafeClient;

  constructor(apiKey: string, defaultModel?: string) {
    this.#client = new TypeSafeClient({
      apiKey,
      defaultModel,
      timeout: 20_000,
      retry: { maxRetries: 1 },
    });
  }

  ask<const Q extends Questions>(state: EntryType, questions: Q): Promise<SystemOneResult<Q>> {
    return this.#client.systemOne({ state, questions });
  }
}

/**
 * True when the API refused the request itself rather than the call: a 400 or 422, which is
 * what an over-long request comes back as. Rate limits and outages are retried by the SDK and
 * arrive as other classes; those are not a reason to split a batch.
 */
export function isRequestRejected(e: unknown): boolean {
  return e instanceof APIError && (e.status === 400 || e.status === 422);
}

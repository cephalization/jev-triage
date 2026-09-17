import type { SystemOne } from "@triage/triage";
import {
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

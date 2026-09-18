import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace";

/**
 * OTLP/HTTP protobuf over `fetch`. The stock exporter picks a transport by platform and the
 * Node one needs `http`; this one needs only `fetch`, which every worker has. Exports are
 * tracked so `forceFlush` can wait for them, which is how a Durable Object hands the last
 * request's spans to `waitUntil` before it may be evicted.
 */
export interface FetchTraceExporterOptions {
  /** The collector's traces endpoint, e.g. `http://localhost:6006/v1/traces`. */
  url: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** Called with export failures; the default logs to the console. */
  onError?: (error: unknown) => void;
}

export class FetchTraceExporter implements SpanExporter {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof fetch;
  readonly #onError: (error: unknown) => void;
  readonly #inFlight = new Set<Promise<void>>();
  #shutdown = false;

  constructor(options: FetchTraceExporterOptions) {
    this.#url = options.url;
    this.#headers = options.headers ?? {};
    this.#fetch = options.fetch ?? fetch;
    this.#onError =
      options.onError ??
      ((e) =>
        console.warn(
          `[openinference] export failed: ${e instanceof Error ? e.message : String(e)}`,
        ));
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.#shutdown) {
      resultCallback({ code: ExportResultCode.FAILED, error: new Error("exporter is shut down") });
      return;
    }
    const body = ProtobufTraceSerializer.serializeRequest(spans);
    if (!body) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }
    const send = (async () => {
      try {
        const res = await this.#fetch(this.#url, {
          method: "POST",
          headers: { "content-type": "application/x-protobuf", ...this.#headers },
          body,
        });
        if (!res.ok) throw new Error(`collector answered ${res.status}`);
        resultCallback({ code: ExportResultCode.SUCCESS });
      } catch (e) {
        this.#onError(e);
        resultCallback({
          code: ExportResultCode.FAILED,
          error: e instanceof Error ? e : new Error(String(e)),
        });
      }
    })();
    this.#inFlight.add(send);
    void send.finally(() => this.#inFlight.delete(send));
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.#inFlight);
  }

  async shutdown(): Promise<void> {
    this.#shutdown = true;
    await this.forceFlush();
  }
}

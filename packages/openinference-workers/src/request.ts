import {
  SemanticConventions,
  type OpenInferenceSpanKind,
} from "@arizeai/openinference-semantic-conventions";
import { context, SpanStatusCode, type Attributes, type Span } from "@opentelemetry/api";
import type { OITracer } from "@arizeai/openinference-core";
import { extractTraceContext } from "./propagation.ts";

/**
 * One inbound request as one span: the parent comes from the request's `traceparent`, the
 * span is active for everything `fn` awaits, its status follows the outcome, and the export
 * is handed to `waitUntil` so the response is not held for the collector. Works for a Worker's
 * `fetch(request, env, ctx)` and for a Durable Object's `fetch(request)` with `this.ctx`.
 */
export interface RequestSpanOptions {
  tracer: OITracer;
  request: { headers: Headers };
  name: string;
  kind: OpenInferenceSpanKind | `${OpenInferenceSpanKind}`;
  attributes?: Attributes;
  /** `ctx` of a Worker handler or a Durable Object; without it the flush is awaited inline. */
  execution?: { waitUntil(promise: Promise<unknown>): void } | null;
  flush: () => Promise<void>;
}

export async function withRequestSpan<T>(
  options: RequestSpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const parent = extractTraceContext(options.request.headers);
  const attributes: Attributes = {
    [SemanticConventions.OPENINFERENCE_SPAN_KIND]: options.kind,
    ...options.attributes,
  };
  const run = () =>
    options.tracer.startActiveSpan(options.name, { attributes }, async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (e) {
        span.recordException(e instanceof Error ? e : new Error(String(e)));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: e instanceof Error ? e.message : String(e),
        });
        throw e;
      } finally {
        span.end();
      }
    });
  try {
    return await context.with(parent, run);
  } finally {
    const flushing = options.flush();
    if (options.execution) options.execution.waitUntil(flushing);
    else await flushing;
  }
}

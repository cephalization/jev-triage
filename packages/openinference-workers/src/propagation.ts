import { context, propagation, type Context } from "@opentelemetry/api";

/**
 * W3C trace context across the hops a worker makes: `fetch` to another service, `stub.fetch`
 * to another Durable Object, or a callback into the host application. Inject on the way out
 * and extract on the way in, and the spans on both sides share one trace.
 */

/** A headers object for an outbound request carrying the active (or given) context. */
export function injectTraceHeaders(
  headers: Record<string, string> = {},
  ctx: Context = context.active(),
): Record<string, string> {
  const out = { ...headers };
  propagation.inject(ctx, out, {
    set: (carrier, key, value) => {
      carrier[key] = value;
    },
  });
  return out;
}

/** The context carried by an inbound request's headers, or the root context when none. */
export function extractTraceContext(
  headers: Headers | Record<string, string | undefined>,
): Context {
  const get = (key: string): string | undefined =>
    headers instanceof Headers ? (headers.get(key) ?? undefined) : headers[key];
  return propagation.extract(context.active(), headers, {
    get: (_carrier, key) => get(key),
    keys: () => (headers instanceof Headers ? [...headers.keys()] : Object.keys(headers)),
  });
}

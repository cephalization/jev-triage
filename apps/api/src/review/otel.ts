import { OITracer } from "@arizeai/openinference-core";
import { SEMRESATTRS_PROJECT_NAME } from "@arizeai/openinference-semantic-conventions";
import { context, propagation, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { env } from "../env.ts";

/**
 * The API's OpenTelemetry setup: the Node provider, the stock OTLP protobuf exporter pointed
 * at Phoenix, and the OpenInference tracer over it. Registering the provider installs the
 * AsyncLocalStorage context manager and the W3C propagator, so spans nest across `await`
 * and `traceHeaders()` carries the trace to the reviewer cell. Without a collector nothing is
 * registered and the tracer is the API's no-op.
 */

let provider: NodeTracerProvider | null = null;

if (env.phoenixEndpoint) {
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [SEMRESATTRS_PROJECT_NAME]: env.phoenixProject,
      "service.name": "typeful-api",
    }),
    spanProcessors: [
      new BatchSpanProcessor({
        exporter: new OTLPTraceExporter({ url: `${env.phoenixEndpoint}/v1/traces` }),
        // A review is seconds long and people watch Phoenix while it runs; ship promptly.
        scheduledDelayMillis: 500,
      }),
    ],
  });
  provider.register();
}

/** The OpenInference tracer; context attributes (session, user) land on every span it starts. */
export const tracer = new OITracer({ tracer: trace.getTracer("typeful-api") });

/** The collector the cell should report to, or null when tracing is off. */
export const traceTarget = env.phoenixEndpoint
  ? { endpoint: env.phoenixEndpoint, project: env.phoenixProject }
  : null;

/** Headers carrying the active span as W3C `traceparent`, for a request to the cell. */
export function traceHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const out = { ...headers };
  propagation.inject(context.active(), out, {
    set: (carrier, key, value) => {
      carrier[key] = value;
    },
  });
  return out;
}

/** The context an inbound request carries in `traceparent`, for a callback from the cell. */
export function contextFromHeaders(headers: Headers) {
  return propagation.extract(context.active(), headers, {
    get: (carrier, key) => carrier.get(key) ?? undefined,
    keys: (carrier) => [...carrier.keys()],
  });
}

export async function flushTraces(): Promise<void> {
  await provider?.forceFlush();
}

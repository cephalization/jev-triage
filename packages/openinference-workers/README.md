# openinference-workers

OpenInference tracing for Cloudflare Workers, Durable Objects and [celld](https://celld.dev):
the standard OpenTelemetry JS stack, arranged for a runtime that has `fetch` and
`AsyncLocalStorage` but no Node `http`, no long-lived process, and no promise that an isolate
survives the request it is serving. Spans land in [Arize Phoenix](https://arize.com/docs/phoenix)
or any OTLP collector.

The package is small because the pieces already exist; it chooses and wires them:

| Piece                                        | What it is                                                                                                                                                                                                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createWorkersTracing(options)`              | `@opentelemetry/sdk-trace`'s `TracerProvider` with the OpenInference project name on its resource, a `SimpleSpanProcessor` and the fetch exporter; registers the context manager, the W3C propagator and the global provider; returns an `OITracer` from `@arizeai/openinference-core` |
| `FetchTraceExporter`                         | OTLP/HTTP protobuf via `fetch`, serialised by `@opentelemetry/otlp-transformer`; tracks exports so `forceFlush` waits for them                                                                                                                                                         |
| `AsyncLocalStorageContextManager`            | `@opentelemetry/api`'s `ContextManager` on `node:async_hooks`, which workerd provides under `nodejs_compat`                                                                                                                                                                            |
| `injectTraceHeaders` / `extractTraceContext` | W3C `traceparent` in and out of `Headers`, for `fetch`, `stub.fetch` and callbacks into your host application                                                                                                                                                                          |
| `withRequestSpan(options, fn)`               | One inbound request as one span: parent from `traceparent`, active for everything `fn` awaits, status from the outcome, flush handed to `waitUntil`                                                                                                                                    |

## Install

```sh
npm install @arizeai/openinference-workers @opentelemetry/api @arizeai/openinference-semantic-conventions
```

Your `wrangler.jsonc` needs the Node compatibility flag for `AsyncLocalStorage`:

```jsonc
{ "compatibility_flags": ["nodejs_compat"] }
```

## Use

Create the tracing once per isolate. In a Worker that is module scope; in a Durable Object it
is a module-level map keyed by collector, because a Durable Object class is instantiated per
object and may be evicted between requests.

```ts
import {
  createWorkersTracing,
  withRequestSpan,
  injectTraceHeaders,
} from "@arizeai/openinference-workers";
import {
  OpenInferenceSpanKind,
  SemanticConventions as S,
} from "@arizeai/openinference-semantic-conventions";

const tracing = createWorkersTracing({
  endpoint: "http://localhost:6006", // Phoenix; /v1/traces is appended
  projectName: "my-agent",
  serviceName: "my-worker",
  headers: { authorization: `Bearer ${PHOENIX_API_KEY}` }, // when Phoenix has auth on
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withRequestSpan(
      {
        tracer: tracing.tracer,
        request,
        name: "answer",
        kind: OpenInferenceSpanKind.AGENT,
        attributes: { [S.INPUT_VALUE]: await request.clone().text() },
        execution: ctx, // the flush rides on ctx.waitUntil, after the response
        flush: tracing.flush,
      },
      async (span) => {
        const answer = await runAgent(); // anything traced inside nests under the request span
        span.setAttribute(S.OUTPUT_VALUE, answer);
        return Response.json({ answer });
      },
    );
  },
};
```

Inside `runAgent`, use the OpenTelemetry API as anywhere else. The active context follows
`await`, so a model call and a tool call started in the loop nest under the request span
without passing it around:

```ts
import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("my-agent");

const reply = await tracer.startActiveSpan(
  "anthropic.completion",
  {
    attributes: {
      [S.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.LLM,
      [S.LLM_MODEL_NAME]: model,
    },
  },
  async (span) => {
    try {
      const r = await callModel(messages);
      span.setAttributes({
        [S.LLM_TOKEN_COUNT_PROMPT]: r.usage.input,
        [S.LLM_TOKEN_COUNT_COMPLETION]: r.usage.output,
        [S.LLM_COST_TOTAL]: r.usage.cost.total,
      });
      span.setStatus({ code: SpanStatusCode.OK });
      return r;
    } finally {
      span.end();
    }
  },
);
```

`@arizeai/openinference-core`'s helpers (`withSpan`, `traceAgent`, `traceTool`,
`getLLMAttributes`, `setSession`, `setUser`) work on the returned `tracer` too.

### Crossing hops

Every hop a worker makes is an HTTP request, so the W3C header is the whole story:

```ts
// Out: to another service, another Durable Object, or your host application.
await stub.fetch("http://snapshot/grep?q=…", { headers: injectTraceHeaders() });
await fetch(`${api}/internal/rerank`, {
  method: "POST",
  headers: injectTraceHeaders({ "content-type": "application/json" }),
  body,
});

// In: withRequestSpan reads `traceparent` from the request for you. By hand:
const parent = extractTraceContext(request.headers);
await context.with(parent, () => tracer.startActiveSpan("work", fn));
```

The host on the other end only has to read `traceparent` with its own OpenTelemetry setup, or
parse it if it traces by hand; the trace id and parent span id are all it needs.

### Durable Objects

```ts
export class Agent extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const tracing = tracingFor(this.env); // your module-level map
    return withRequestSpan(
      {
        tracer: tracing.tracer,
        request,
        name: "turn",
        kind: OpenInferenceSpanKind.AGENT,
        execution: this.ctx,
        flush: tracing.flush,
      },
      async () => this.turn(request),
    );
  }
}
```

`this.ctx.waitUntil` keeps the object alive until the export completes, so the last request's
spans are never lost to eviction, and the caller gets its response first.

## Why these choices

- **`SimpleSpanProcessor`, not batch.** A batch processor holds spans on a timer. Isolates are
  evicted, Durable Objects hibernate, and a Worker's timers stop with the request; anything
  still in the batch is gone. Simple export plus `waitUntil` is one request per span batch but
  loses nothing.
- **A fetch exporter, not the stock one.** `@opentelemetry/exporter-trace-otlp-proto` picks a
  transport per platform; its Node transport needs `http`, and which build a bundler picks
  depends on conditions the runtime does not control. This exporter has one transport, `fetch`,
  and reuses the stock serializer.
- **`AsyncLocalStorage`, not a stack.** With it the OpenTelemetry API's `context.active()` is
  correct across `await`, and `startActiveSpan` nests spans the way it does in Node. Without it
  every function has to carry a parent span. Workers have had it since `nodejs_compat`.
- **Protobuf, not JSON.** Phoenix's `/v1/traces` accepts `application/x-protobuf` only; the
  serializer in `@opentelemetry/otlp-transformer` produces it without a native dependency.
- **Project name on the resource.** `openinference.project.name` is how Phoenix files a trace;
  `createWorkersTracing` sets it once so every span in the isolate lands in the same project.

## What it does not do

- No auto-instrumentation. The instrumentation packages in this repository wrap specific SDKs;
  an agent loop written on a raw client still describes its own model and tool spans. The
  example above is the shape.
- No metrics or logs. Traces only.
- No sampling configuration beyond what `@opentelemetry/sdk-trace` takes; pass `spanProcessors`
  for anything custom and it runs before the exporter's.

## Verified against

celld 0.5 running a Durable Object that drives the pi SDK against a model provider, exporting
to Phoenix 20.14 in Docker: request spans per stage, an LLM span per model turn with messages,
tools, tokens and cost, a tool span per call, and the trace continuing through a callback into
the host API and back. See `apps/reviewer` in this repository.

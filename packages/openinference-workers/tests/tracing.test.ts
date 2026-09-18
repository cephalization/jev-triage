import { describe, expect, test } from "vite-plus/test";
import {
  OpenInferenceSpanKind,
  SemanticConventions,
} from "@arizeai/openinference-semantic-conventions";
import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import {
  AsyncLocalStorageContextManager,
  createWorkersTracing,
  extractTraceContext,
  FetchTraceExporter,
  injectTraceHeaders,
  withRequestSpan,
} from "../src/index.ts";

const memory = new InMemorySpanExporter();
const posted: { url: string; type: string; body: Uint8Array }[] = [];
const tracing = createWorkersTracing({
  endpoint: "http://phoenix:6006/",
  projectName: "proj",
  serviceName: "svc",
  spanProcessors: [new SimpleSpanProcessor({ exporter: memory })],
  fetch: (async (url: string, init: RequestInit) => {
    posted.push({
      url,
      type: (init.headers as Record<string, string>)["content-type"]!,
      body: init.body as Uint8Array,
    });
    return new Response(null, { status: 200 });
  }) as typeof fetch,
});

describe("workers tracing", () => {
  test("the AsyncLocalStorage context follows await, so spans nest without a parent argument", async () => {
    const manager = new AsyncLocalStorageContextManager();
    const key = Symbol("k");
    const inner = await manager.with(context.active().setValue(key, 1), async () => {
      await new Promise((r) => setTimeout(r, 5));
      return manager.active().getValue(key);
    });
    expect(inner).toBe(1);
    expect(manager.active().getValue(key)).toBeUndefined();
    memory.reset();
    await tracing.tracer.startActiveSpan("outer", async (outer) => {
      await new Promise((r) => setTimeout(r, 2));
      tracing.otelTracer.startSpan("inner").end();
      outer.end();
    });
    const spans = memory.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual(["inner", "outer"]);
    expect(spans[0]!.parentSpanContext?.spanId).toBe(spans[1]!.spanContext().spanId);
    expect(spans[1]!.resource.attributes["openinference.project.name"]).toBe("proj");
  });

  test("the fetch exporter posts OTLP protobuf and forceFlush waits for it", async () => {
    memory.reset();
    posted.length = 0;
    tracing.otelTracer.startSpan("exported").end();
    await tracing.flush();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe("http://phoenix:6006/v1/traces");
    expect(posted[0]!.type).toBe("application/x-protobuf");
    expect(posted[0]!.body.byteLength).toBeGreaterThan(20);
    // The same span serialised as JSON names it, which the protobuf bytes must too.
    const json = new TextDecoder().decode(
      JsonTraceSerializer.serializeRequest(memory.getFinishedSpans())!,
    );
    expect(json).toContain('"name":"exported"');
    expect(
      new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(posted[0]!.body),
    ).toContain("exported");
    const failures: unknown[] = [];
    const failing = new FetchTraceExporter({
      url: "http://x/v1/traces",
      fetch: (async () => new Response(null, { status: 500 })) as typeof fetch,
      onError: (e) => failures.push(e),
    });
    await new Promise<void>((r) => failing.export(memory.getFinishedSpans(), () => r()));
    expect(String(failures[0])).toContain("500");
  });

  test("W3C headers carry the trace across a hop and a request span hangs from them", async () => {
    memory.reset();
    let headers: Record<string, string> = {};
    await tracing.tracer.startActiveSpan("caller", async (span) => {
      headers = injectTraceHeaders({ "content-type": "application/json" });
      span.end();
    });
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const parent = trace.getSpanContext(extractTraceContext(new Headers(headers)));
    const caller = memory.getFinishedSpans()[0]!;
    expect(parent?.traceId).toBe(caller.spanContext().traceId);

    const waited: Promise<unknown>[] = [];
    const out = await withRequestSpan(
      {
        tracer: tracing.tracer,
        request: { headers: new Headers(headers) },
        name: "stage",
        kind: OpenInferenceSpanKind.AGENT,
        attributes: { [SemanticConventions.INPUT_VALUE]: "x" },
        execution: { waitUntil: (p) => void waited.push(p) },
        flush: tracing.flush,
      },
      async () => {
        tracing.otelTracer.startSpan("llm").end();
        return 42;
      },
    );
    expect(out).toBe(42);
    expect(waited).toHaveLength(1);
    const names = memory.getFinishedSpans().map((s) => s.name);
    expect(names).toEqual(["caller", "llm", "stage"]);
    const stage = memory.getFinishedSpans()[2]!;
    expect(stage.parentSpanContext?.spanId).toBe(caller.spanContext().spanId);
    expect(stage.attributes[SemanticConventions.OPENINFERENCE_SPAN_KIND]).toBe("AGENT");
    await expect(
      withRequestSpan(
        {
          tracer: tracing.tracer,
          request: { headers: new Headers() },
          name: "bad",
          kind: OpenInferenceSpanKind.CHAIN,
          flush: tracing.flush,
        },
        async () => {
          throw new Error("nope");
        },
      ),
    ).rejects.toThrow("nope");
    expect(memory.getFinishedSpans().at(-1)!.status.code).toBe(2);
  });
});

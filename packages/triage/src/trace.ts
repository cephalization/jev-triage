/**
 * OpenInference spans over OTLP/HTTP protobuf, with nothing but `fetch` and a hand-rolled
 * encoder for the handful of message types OTLP traces need, so the same tracer runs in the
 * API (Node) and in the reviewer cell (workerd). Spans are buffered and shipped in one request
 * per flush. Telemetry never fails the work it describes: an export error is logged.
 *
 * Attribute names follow the OpenInference semantic conventions
 * (github.com/Arize-ai/openinference/tree/main/spec) so Phoenix renders LLM calls, tool
 * calls, tokens and cost natively.
 */

export type SpanKind = "CHAIN" | "LLM" | "TOOL" | "AGENT" | "RERANKER" | "RETRIEVER";

export type AttrValue = string | number | boolean | string[];
export type Attrs = Record<string, AttrValue | null | undefined>;

/** What crosses a service boundary: where to ship, which project, and the parent to hang from. */
export interface TraceContext {
  endpoint: string;
  project: string;
  traceId: string;
  parentSpanId: string | null;
}

export const OI = {
  kind: "openinference.span.kind",
  inputValue: "input.value",
  inputMime: "input.mime_type",
  outputValue: "output.value",
  outputMime: "output.mime_type",
  sessionId: "session.id",
  userId: "user.id",
  metadata: "metadata",
  tags: "tag.tags",
  modelName: "llm.model_name",
  system: "llm.system",
  provider: "llm.provider",
  invocationParameters: "llm.invocation_parameters",
  promptTokens: "llm.token_count.prompt",
  completionTokens: "llm.token_count.completion",
  totalTokens: "llm.token_count.total",
  cacheReadTokens: "llm.token_count.prompt_details.cache_read",
  cacheWriteTokens: "llm.token_count.prompt_details.cache_write",
  costPrompt: "llm.cost.prompt",
  costCompletion: "llm.cost.completion",
  costTotal: "llm.cost.total",
  toolName: "tool.name",
  toolDescription: "tool.description",
  toolSchema: "tool.json_schema",
  toolId: "tool.id",
} as const;

/**
 * The shared package touches no runtime globals by name; the host (Node or workerd) provides
 * these through globalThis, typed minimally here so the package stays portable.
 */
interface Host {
  fetch: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: Uint8Array },
  ) => Promise<{ ok: boolean; status: number }>;
  crypto: { getRandomValues: (a: Uint8Array) => Uint8Array };
  console: { warn: (message: string) => void };
}
const host = () => globalThis as unknown as Host;

const hex = (bytes: number): string => {
  const a = new Uint8Array(bytes);
  host().crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
};
export const newTraceId = () => hex(16);
export const newSpanId = () => hex(8);

// ---- OTLP protobuf encoding ------------------------------------------------------------
// Only what ExportTraceServiceRequest needs: varints, fixed64, length-delimited messages.
// Field numbers from opentelemetry/proto/{trace/v1/trace,common/v1/common,resource/v1/resource}.proto.

/** UTF-8 by hand: the shared package names no runtime globals. */
function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
  }
  return Uint8Array.from(out);
}

class Writer {
  #parts: Uint8Array[] = [];
  #size = 0;
  #push(b: Uint8Array) {
    this.#parts.push(b);
    this.#size += b.length;
  }
  varint(n: number | bigint) {
    let v = BigInt(n);
    const out: number[] = [];
    do {
      let byte = Number(v & 0x7fn);
      v >>= 7n;
      if (v > 0n) byte |= 0x80;
      out.push(byte);
    } while (v > 0n);
    this.#push(Uint8Array.from(out));
  }
  tag(field: number, wire: 0 | 1 | 2) {
    this.varint((field << 3) | wire);
  }
  bytes(field: number, b: Uint8Array) {
    this.tag(field, 2);
    this.varint(b.length);
    this.#push(b);
  }
  string(field: number, s: string) {
    this.bytes(field, utf8(s));
  }
  uint(field: number, n: number | bigint) {
    this.tag(field, 0);
    this.varint(n);
  }
  fixed64(field: number, n: bigint) {
    this.tag(field, 1);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    this.#push(b);
  }
  double(field: number, n: number) {
    this.tag(field, 1);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, n, true);
    this.#push(b);
  }
  message(field: number, build: (w: Writer) => void) {
    const w = new Writer();
    build(w);
    this.bytes(field, w.finish());
  }
  finish(): Uint8Array {
    const out = new Uint8Array(this.#size);
    let at = 0;
    for (const p of this.#parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

const hexBytes = (h: string) =>
  Uint8Array.from(h.match(/.{2}/g)?.map((x) => parseInt(x, 16)) ?? []);
/** Milliseconds since the epoch as OTLP's nanoseconds. */
const nanos = (ms: number) => BigInt(Math.floor(ms)) * 1_000_000n;

function anyValue(w: Writer, v: AttrValue) {
  if (typeof v === "string") w.string(1, v);
  else if (typeof v === "boolean") w.uint(2, v ? 1 : 0);
  else if (typeof v === "number") {
    if (Number.isInteger(v) && v >= 0) w.uint(3, v);
    else w.double(4, v);
  } else w.message(5, (a) => v.forEach((s) => a.message(1, (x) => x.string(1, s))));
}

function keyValues(w: Writer, field: number, attrs: Attrs) {
  for (const [key, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    w.message(field, (kv) => {
      kv.string(1, key);
      kv.message(2, (av) => anyValue(av, v));
    });
  }
}

/** ExportTraceServiceRequest with one resource and one scope. */
export function encodeExport(resource: Attrs, spans: readonly Span[]): Uint8Array {
  const w = new Writer();
  w.message(1, (rs) => {
    rs.message(1, (r) => keyValues(r, 1, resource));
    rs.message(2, (ss) => {
      ss.message(1, (scope) => scope.string(1, "typeful-triage"));
      for (const s of spans)
        ss.message(2, (sp) => {
          sp.bytes(1, hexBytes(s.traceId));
          sp.bytes(2, hexBytes(s.id));
          if (s.parentId) sp.bytes(4, hexBytes(s.parentId));
          sp.string(5, s.name);
          sp.uint(6, 1);
          sp.fixed64(7, nanos(s.start));
          sp.fixed64(8, nanos(s.end ?? Date.now()));
          keyValues(sp, 9, s.attrs);
          sp.message(15, (st) => {
            if (s.error) st.string(2, s.error);
            st.uint(3, s.error ? 2 : 1);
          });
        });
    });
  });
  return w.finish();
}

export class Span {
  readonly traceId: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly start: number;
  end: number | null = null;
  error: string | null = null;
  readonly attrs: Attrs;

  constructor(
    traceId: string,
    parentId: string | null,
    name: string,
    kind: SpanKind,
    attrs: Attrs,
  ) {
    this.traceId = traceId;
    this.id = newSpanId();
    this.parentId = parentId;
    this.name = name;
    this.start = Date.now();
    this.attrs = { [OI.kind]: kind, ...attrs };
  }

  /** The context a child in another service should carry. */
  context(endpoint: string, project: string): TraceContext {
    return { endpoint, project, traceId: this.traceId, parentSpanId: this.id };
  }
}

export class Tracer {
  readonly endpoint: string | null;
  readonly project: string;
  readonly service: string;
  #pending: Span[] = [];

  constructor(endpoint: string | null, project: string, service: string) {
    this.endpoint = endpoint ? endpoint.replace(/\/+$/, "") : null;
    this.project = project;
    this.service = service;
  }

  /** A tracer that records nothing, for when no collector is configured. */
  static off(service = "none"): Tracer {
    return new Tracer(null, "", service);
  }

  get enabled(): boolean {
    return this.endpoint !== null;
  }

  /** A root span, or a child of a span or a context from another service. */
  start(name: string, kind: SpanKind, parent: Span | TraceContext | null, attrs: Attrs = {}): Span {
    const traceId = parent
      ? parent instanceof Span
        ? parent.traceId
        : parent.traceId
      : newTraceId();
    const parentId = parent ? (parent instanceof Span ? parent.id : parent.parentSpanId) : null;
    return new Span(traceId, parentId, name, kind, attrs);
  }

  /** Close a span with its result; it ships on the next flush. */
  end(span: Span, attrs: Attrs = {}, error: unknown = null): void {
    Object.assign(span.attrs, attrs);
    span.end = Date.now();
    if (error !== null) span.error = describe(error);
    if (this.enabled) this.#pending.push(span);
  }

  /** Run `fn` inside a span, recording its error and re-throwing it. */
  async span<T>(
    name: string,
    kind: SpanKind,
    parent: Span | TraceContext | null,
    attrs: Attrs,
    fn: (span: Span) => Promise<T>,
    output?: (result: T) => Attrs,
  ): Promise<T> {
    const s = this.start(name, kind, parent, attrs);
    try {
      const result = await fn(s);
      this.end(s, output ? output(result) : {});
      return result;
    } catch (e) {
      this.end(s, {}, e);
      throw e;
    }
  }

  /** Ship every closed span in one OTLP/HTTP request. Failures are logged, never thrown. */
  async flush(fetchImpl: Host["fetch"] = (url, init) => host().fetch(url, init)): Promise<number> {
    if (!this.endpoint || this.#pending.length === 0) return 0;
    const spans = this.#pending;
    this.#pending = [];
    const body = encodeExport(
      { "service.name": this.service, "openinference.project.name": this.project },
      spans,
    );
    try {
      const res = await fetchImpl(`${this.endpoint}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/x-protobuf" },
        body,
      });
      if (!res.ok) host().console.warn(`[trace] collector answered ${res.status}`);
    } catch (e) {
      host().console.warn(`[trace] export failed: ${describe(e)}`);
    }
    return spans.length;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

export function toAttributes(attrs: Attrs): { key: string; value: unknown }[] {
  const out: { key: string; value: unknown }[] = [];
  for (const [key, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") out.push({ key, value: { stringValue: v } });
    else if (typeof v === "boolean") out.push({ key, value: { boolValue: v } });
    else if (typeof v === "number")
      out.push({
        key,
        value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v },
      });
    else out.push({ key, value: { arrayValue: { values: v.map((s) => ({ stringValue: s })) } } });
  }
  return out;
}

/** `llm.input_messages.N.message.role/content` for a list of messages. */
export function messageAttrs(
  prefix: "llm.input_messages" | "llm.output_messages",
  messages: readonly {
    role: string;
    content: string;
    toolCalls?: { id: string; name: string; arguments: unknown }[];
  }[],
): Attrs {
  const out: Attrs = {};
  messages.forEach((m, i) => {
    out[`${prefix}.${i}.message.role`] = m.role;
    out[`${prefix}.${i}.message.content`] = m.content;
    m.toolCalls?.forEach((c, j) => {
      out[`${prefix}.${i}.message.tool_calls.${j}.tool_call.id`] = c.id;
      out[`${prefix}.${i}.message.tool_calls.${j}.tool_call.function.name`] = c.name;
      out[`${prefix}.${i}.message.tool_calls.${j}.tool_call.function.arguments`] = JSON.stringify(
        c.arguments,
      );
    });
  });
  return out;
}

/** `llm.tools.N.tool.*` for the tools offered on a call. */
export function toolAttrs(
  tools: readonly { name: string; description: string; parameters: unknown }[],
): Attrs {
  const out: Attrs = {};
  tools.forEach((t, i) => {
    out[`llm.tools.${i}.tool.name`] = t.name;
    out[`llm.tools.${i}.tool.description`] = t.description;
    out[`llm.tools.${i}.tool.json_schema`] = JSON.stringify(t.parameters);
  });
  return out;
}

/** Keep attribute payloads bounded; Phoenix stores them, but a 5 MB prompt helps nobody. */
export function clip(text: string, max = 200_000): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more chars)` : text;
}

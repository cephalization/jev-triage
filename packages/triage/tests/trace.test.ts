import { describe, expect, test } from "vite-plus/test";
import { encodeExport, messageAttrs, OI, toAttributes, toolAttrs, Tracer } from "../src/trace.ts";

/** A generic protobuf walker: enough to check what the encoder produced. */
type Field = { field: number; wire: number; value: Uint8Array | bigint };
function decode(bytes: Uint8Array): Field[] {
  const out: Field[] = [];
  let at = 0;
  const varint = () => {
    let v = 0n;
    let shift = 0n;
    for (;;) {
      const b = bytes[at]!;
      at += 1;
      v |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return v;
      shift += 7n;
    }
  };
  while (at < bytes.length) {
    const key = Number(varint());
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 0) out.push({ field, wire, value: varint() });
    else if (wire === 1) {
      out.push({
        field,
        wire,
        value: new DataView(bytes.buffer, bytes.byteOffset + at, 8).getBigUint64(0, true),
      });
      at += 8;
    } else {
      const len = Number(varint());
      out.push({ field, wire, value: bytes.subarray(at, at + len) });
      at += len;
    }
  }
  return out;
}
const sub = (fields: Field[], n: number) =>
  fields.filter((f) => f.field === n).map((f) => decode(f.value as Uint8Array));
const str = (fields: Field[], n: number) =>
  String.fromCharCode(...(fields.find((f) => f.field === n)!.value as Uint8Array));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("tracer", () => {
  test("spans nest, cross a service boundary by context, and ship as OTLP protobuf", async () => {
    const t = new Tracer("http://phoenix:7006/", "proj", "svc");
    const root = t.start("review", "AGENT", null, { [OI.sessionId]: "r1" });
    const child = t.start("classify", "CHAIN", root);
    const ctx = child.context(t.endpoint!, t.project);
    const remote = t.start("llm", "LLM", ctx, { [OI.promptTokens]: 10, [OI.costTotal]: 0.5 });
    t.end(remote, { [OI.outputValue]: "ok" });
    t.end(child, {}, new Error("boom"));
    t.end(root);
    const sent: { url: string; type: string; body: Uint8Array }[] = [];
    const n = await t.flush(async (url, init) => {
      sent.push({ url, type: init.headers["content-type"]!, body: init.body });
      return { ok: true, status: 200 };
    });
    expect(n).toBe(3);
    expect(sent[0]!.url).toBe("http://phoenix:7006/v1/traces");
    expect(sent[0]!.type).toBe("application/x-protobuf");
    const req = decode(sent[0]!.body);
    const resourceSpans = sub(req, 1)[0]!;
    const resource = sub(resourceSpans, 1)[0]!;
    const resourceKeys = sub(resource, 1).map((kv) => str(kv, 1));
    expect(resourceKeys).toEqual(["service.name", "openinference.project.name"]);
    const scopeSpans = sub(resourceSpans, 2)[0]!;
    const spans = sub(scopeSpans, 2);
    expect(spans.map((s) => str(s, 5))).toEqual(["llm", "classify", "review"]);
    expect(hex(spans[0]!.find((f) => f.field === 1)!.value as Uint8Array)).toBe(root.traceId);
    expect(hex(spans[0]!.find((f) => f.field === 4)!.value as Uint8Array)).toBe(child.id);
    expect(spans[2]!.some((f) => f.field === 4)).toBe(false);
    const status = sub(spans[1]!, 15)[0]!;
    expect(str(status, 2)).toBe("boom");
    expect(status.find((f) => f.field === 3)!.value).toBe(2n);
    const llmAttrs = sub(spans[0]!, 9);
    const kinds = llmAttrs.map((kv) => str(kv, 1));
    expect(kinds).toContain("llm.token_count.prompt");
    expect(await t.flush(async () => ({ ok: true, status: 200 }))).toBe(0);
  });

  test("an off tracer records nothing", async () => {
    const t = Tracer.off();
    const s = t.start("x", "CHAIN", null);
    t.end(s);
    expect(t.enabled).toBe(false);
    expect(await t.flush()).toBe(0);
    expect(encodeExport({}, []).length).toBeGreaterThan(0);
  });

  test("attribute helpers follow the OpenInference names", () => {
    expect(toAttributes({ a: "s", b: 3, c: 1.5, d: true, e: ["x"], f: null })).toHaveLength(5);
    const m = messageAttrs("llm.input_messages", [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "grep", arguments: { q: 1 } }],
      },
    ]);
    expect(m["llm.input_messages.1.message.tool_calls.0.tool_call.function.name"]).toBe("grep");
    expect(m["llm.input_messages.1.message.tool_calls.0.tool_call.function.arguments"]).toBe(
      '{"q":1}',
    );
    const tools = toolAttrs([
      { name: "grep", description: "search", parameters: { type: "object" } },
    ]);
    expect(tools["llm.tools.0.tool.json_schema"]).toBe('{"type":"object"}');
  });
});

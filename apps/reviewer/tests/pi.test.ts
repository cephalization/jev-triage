import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { baseFor, completeWithPi, modelFor } from "../src/pi.ts";
import { Tracer } from "@triage/triage/trace";
import { runNarrative } from "../src/review.ts";

const GROUPS = '{"summary":"Adds the widget.","impact":"","findings":[]}';

/**
 * A fake provider speaking the two streaming shapes the SDK uses here: Anthropic messages
 * (SSE with named events) and OpenAI-style chat completions (SSE data chunks). It answers
 * junk first and the real JSON once it sees the retry marker, like the API's fake.
 */
function fakeProvider() {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      hits.push(`${path} ${String(req.headers.authorization ?? req.headers["x-api-key"])}`);
      const body = JSON.parse(raw) as { messages: { content: unknown }[] };
      const first = body.messages[0]?.content;
      const prompt = typeof first === "string" ? first : JSON.stringify(first);
      const text = prompt.includes("previous response was rejected") ? GROUPS : "not json";
      res.setHeader("content-type", "text/event-stream");
      if (path.endsWith("/messages")) {
        const ev = (type: string, data: object) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        ev("message_start", {
          message: {
            id: "m",
            type: "message",
            role: "assistant",
            model: "x",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        });
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
        ev("content_block_stop", { index: 0 });
        ev("message_delta", {
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 5 },
        });
        ev("message_stop", {});
        return res.end();
      }
      if (path.endsWith("/chat/completions")) {
        const chunk = (o: object) =>
          res.write(
            `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", ...o })}\n\n`,
          );
        chunk({
          choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
        });
        chunk({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        });
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      res.writeHead(404);
      res.end(JSON.stringify({ path }));
    });
  });
  return { server, hits };
}

describe("pi runner", () => {
  let server: Server;
  let hits: string[];
  let base = "";
  beforeAll(async () => {
    const f = fakeProvider();
    server = f.server;
    hits = f.hits;
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterAll(() => server.close());

  test("base URL conventions per kind", () => {
    expect(baseFor("anthropic", "https://api.anthropic.com/v1")).toBe("https://api.anthropic.com");
    expect(baseFor("openai", "https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    expect(baseFor("openrouter", "https://openrouter.ai/api/v1")).toBe(
      "https://openrouter.ai/api/v1",
    );
  });

  test("unknown model ids get a template of the right wire API", () => {
    const m = modelFor(
      { kind: "openai-compatible", baseUrl: "http://proxy/v1", apiKey: "k" },
      "my-model",
    );
    expect(m.model.id).toBe("my-model");
    expect(m.model.api).toBe("openai-completions");
    expect(m.model.baseUrl).toBe("http://proxy/v1");
    expect(m.priced).toBe(false);
    const a = modelFor(
      { kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "k" },
      "claude-sonnet-4-5",
    );
    expect(a.model.api).toBe("anthropic-messages");
    expect(a.model.baseUrl).toBe("https://api.anthropic.com");
    expect(a.priced).toBe(true);
  });

  test("anthropic shape: text and usage from the stream, key in x-api-key", async () => {
    const c = await completeWithPi(
      { kind: "anthropic", baseUrl: base, apiKey: "ka" },
      "claude-sonnet-4-5",
      "hi",
    );
    expect(c).toMatchObject({ text: "not json", inputTokens: 10, outputTokens: 5, priced: true });
    expect(c.costUsd).toBeGreaterThan(0);
    expect(hits.at(-1)).toBe("/v1/messages ka");
  });

  test("openai-compatible shape: bearer key, chat completions", async () => {
    const c = await completeWithPi(
      { kind: "openai-compatible", baseUrl: base, apiKey: "kb" },
      "any-model",
      "hi",
    );
    expect(c).toMatchObject({
      text: "not json",
      inputTokens: 7,
      outputTokens: 3,
      priced: false,
      costUsd: 0,
    });
    expect(hits.at(-1)).toBe("/v1/chat/completions Bearer kb");
  });

  test("runNarrative retries once and returns a validated narrative with summed usage", async () => {
    const snapshot = {
      list: async () => [],
      read: async () => null,
      grep: async () => [],
    };
    const out = await runNarrative(
      {
        provider: { kind: "anthropic", baseUrl: base, apiKey: "ka" },
        model: "claude-sonnet-4-5",
        callback: null,
        repo: "o/r",
        snapshot: { owner: "o", repo: "r", sha: "abc" },
        trace: null,
        request: {
          intent: { title: "t", body: "", author: "a", headRef: "h", baseRef: "b" },
          step: { name: "Core", intent: "the widget" },
          index: 0,
          allSteps: [{ name: "Core", intent: "the widget" }],
          patch:
            "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n",
          classification: null,
        },
      },
      { snapshot, callback: null, repo: "o/r", tracer: Tracer.off() },
    );
    expect(out.result.summary).toBe("Adds the widget.");
    expect(out.result.findings).toEqual([]);
    expect(out.inputTokens).toBe(20);
    expect(out.outputTokens).toBe(10);
    expect(out.priced).toBe(true);
  });
});

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

process.env.ZERO_UPSTREAM_DB ??= "postgres://unused";
process.env.AUTH_SECRET ??= "test";
const { complete } = await import("../src/review/runner.ts");
const { generate, seedReview } = await import("../src/review/job.ts");
const { cellReachable, runInCell } = await import("../src/review/cell.ts");

const GROUPS = { groups: [{ name: "Core", summary: "Adds the widget.", files: ["src/a.ts"] }] };

/** A fake provider that speaks both shapes and records what it was asked. */
function fakeProvider() {
  const seen: { path: string; auth: string | undefined; body: unknown }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages: { content: string }[] };
      seen.push({
        path: req.url ?? "",
        auth: req.headers.authorization ?? (req.headers["x-api-key"] as string),
        body,
      });
      res.setHeader("content-type", "application/json");
      const text = body.messages[0]!.content.includes("previous response was rejected")
        ? JSON.stringify(GROUPS)
        : "not json at all";
      if (req.url === "/v1/messages")
        res.end(
          JSON.stringify({
            content: [{ type: "text", text }],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        );
      else
        res.end(
          JSON.stringify({
            choices: [{ message: { content: text } }],
            usage: { prompt_tokens: 7, completion_tokens: 3 },
          }),
        );
    });
  });
  return { server, seen };
}

describe("http runner", () => {
  let server: Server;
  let seen: ReturnType<typeof fakeProvider>["seen"];
  let base = "";
  beforeAll(async () => {
    const f = fakeProvider();
    server = f.server;
    seen = f.seen;
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address() as { port: number };
    base = `http://localhost:${addr.port}/v1`;
  });
  afterAll(() => server.close());

  test("anthropic shape: messages endpoint, x-api-key, usage read", async () => {
    const c = await complete({ kind: "anthropic", baseUrl: base, key: "k1" }, "claude-x", "hi");
    expect(c).toEqual({ text: "not json at all", inputTokens: 10, outputTokens: 5 });
    expect(seen.at(-1)).toMatchObject({ path: "/v1/messages", auth: "k1" });
  });

  test("openai shape: chat completions, bearer, usage read", async () => {
    const c = await complete({ kind: "openrouter", baseUrl: base, key: "k2" }, "m", "hi");
    expect(c).toEqual({ text: "not json at all", inputTokens: 7, outputTokens: 3 });
    expect(seen.at(-1)).toMatchObject({ path: "/v1/chat/completions", auth: "Bearer k2" });
  });

  test("generate retries with the error and sums usage across attempts", async () => {
    const snapshot = {
      headSha: "abc",
      intent: { title: "t", body: "", author: "a", headRef: "h", baseRef: "b" },
      diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n",
    };
    const out = await generate(snapshot, null, (prompt) =>
      complete({ kind: "openai", baseUrl: base, key: "k" }, "m", prompt),
    );
    expect(out.groups).toEqual(GROUPS.groups);
    expect(out.files).toEqual(["src/a.ts"]);
    expect(out.inputTokens).toBe(14);
    expect(out.outputTokens).toBe(6);
  });
});

describe("classification hand-off", () => {
  const snapshot = {
    headSha: "abc",
    intent: { title: "t", body: "", author: "a", headRef: "h", baseRef: "b" },
    diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n",
  };

  test("generate puts the proposal in the prompt", async () => {
    const prompts: string[] = [];
    await generate(
      snapshot,
      null,
      async (prompt) => {
        prompts.push(prompt);
        return { text: JSON.stringify(GROUPS), inputTokens: 1, outputTokens: 1 };
      },
      "1. src/a.ts: role core",
    );
    expect(prompts[0]).toContain("<classification>");
    expect(prompts[0]).toContain("1. src/a.ts: role core");
  });

  test("seedReview serves jev's order over every file when the agent fails", () => {
    const out = seedReview(
      [
        {
          path: "src/a.ts",
          status: "M",
          added: 1,
          removed: 1,
          signal: {
            role: "core",
            roleConfidence: 1,
            risk: 0.5,
            attention: 0.5,
            entry: 0.9,
            probabilities: {},
          },
        },
      ],
      ["src/a.ts", "src/b.ts"],
    );
    expect(out.groups.map((g) => g.name)).toEqual(["The core change", "Everything else"]);
    expect(out.groups[1]!.files).toEqual(["src/b.ts"]);
    expect(out.inputTokens).toBe(0);
  });
});

describe("reviewer cell client", () => {
  const request = {
    patch: "diff --git a/x b/x\n",
    intent: { title: "t", body: "", author: "a", headRef: "h", baseRef: "b" },
    previousGroups: null,
  };
  const provider = { kind: "anthropic" as const, baseUrl: "http://p/v1", key: "sealed-key" };

  test("posts the run under the review id with the token and reads the result", async () => {
    const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: url instanceof Request ? url.url : url.toString(),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(init?.body as string),
      });
      return Response.json({
        groups: GROUPS.groups,
        files: ["src/a.ts"],
        inputTokens: 3,
        outputTokens: 4,
      });
    }) as typeof fetch;
    const out = await runInCell(
      { url: "http://cell:9876/", token: "shh" },
      "rev_1",
      { provider, model: "m", request },
      { fetchImpl },
    );
    expect(out).toEqual({
      groups: GROUPS.groups,
      files: ["src/a.ts"],
      inputTokens: 3,
      outputTokens: 4,
    });
    expect(calls[0]!.url).toBe("http://cell:9876/runs/rev_1");
    expect(calls[0]!.headers["x-reviewer-token"]).toBe("shh");
    expect(calls[0]!.body).toEqual({
      provider: { kind: "anthropic", baseUrl: "http://p/v1", apiKey: "sealed-key" },
      model: "m",
      request,
    });
  });

  test("surfaces the cell's error message", async () => {
    const fetchImpl = (async () =>
      Response.json({ error: "anthropic m: 401 bad key" }, { status: 502 })) as typeof fetch;
    await expect(
      runInCell(
        { url: "http://cell", token: null },
        "r",
        { provider, model: "m", request },
        { fetchImpl },
      ),
    ).rejects.toThrow("reviewer cell: anthropic m: 401 bad key");
  });
});

describe("cell reachability", () => {
  test("a dead cell reads as unreachable, a healthy one as reachable", async () => {
    expect(await cellReachable({ url: "http://127.0.0.1:1" })).toBe(false);
    const ok = (async () => Response.json({ ok: true })) as typeof fetch;
    expect(await cellReachable({ url: "http://cell/" }, ok)).toBe(true);
  });
});

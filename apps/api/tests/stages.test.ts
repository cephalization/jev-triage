import { describe, expect, test } from "vite-plus/test";
import type { SystemOne } from "@triage/triage";

process.env.ZERO_UPSTREAM_DB ??= "postgres://unused";
process.env.AUTH_SECRET ??= "test";
const { generateStaged, inProcessAgent } = await import("../src/review/stages.ts");

const file = (path: string, body: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n-old\n${body}\n`;
const patch =
  file("src/core.ts", "+core") + file("src/core.test.ts", "+test") + file("docs/x.md", "+doc");
const intent = { title: "Add widgets", body: "", author: "a", headRef: "h", baseRef: "b" };

/** jev that places core and test files in step 1 and everything else in none. */
const systemOne: SystemOne = {
  async ask(_state, questions) {
    const answers: Record<string, unknown> = {};
    const state = _state as { files?: { path: string }[] };
    for (const key of Object.keys(questions)) {
      const i = Number(/\d+/.exec(key)?.[0] ?? 0);
      const path = state.files?.[i]?.path ?? "";
      if (key.endsWith("__step"))
        answers[key] = {
          type: "choice",
          choice: path.startsWith("src/") ? "step_1" : "none",
          confidence: 0.9,
          probabilities: {},
        };
      else if (key.endsWith("__material"))
        answers[key] = { type: "noul", noul: path.startsWith("docs/") ? 0.9 : 0.1 };
    }
    return { answers, usage: { input_tokens: 10, output_tokens: 1 }, model: "fake-jev" } as never;
  },
};

/** The accounted call without the database: straight to the fake. */
const ask = ((s: SystemOne, req: { state: unknown; questions: unknown }) =>
  s.ask(req.state as never, req.questions as never)) as never;

describe("staged generation", () => {
  test("snapshot and classification run first, skeleton, assignment, then parallel narratives", async () => {
    const phases: string[] = [];
    const prompts: string[] = [];
    let concurrent = 0;
    let peak = 0;
    const complete = async (prompt: string) => {
      prompts.push(prompt);
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent -= 1;
      if (prompt.includes("Name the steps only"))
        return {
          text: '{"steps":[{"name":"Add the widget","intent":"the widget"},{"name":"Docs","intent":"docs"}]}',
          inputTokens: 5,
          outputTokens: 2,
        };
      return {
        text: `{"summary":"Written for ${/<step>\n\d+\. ([^\n]+)/.exec(prompt)?.[1] ?? "?"}."}`,
        inputTokens: 3,
        outputTokens: 1,
      };
    };
    const out = await generateStaged({
      reviewId: "r1",
      repoId: "o/r",
      intent,
      headSha: "abc",
      patch,
      previous: null,
      systemOne,
      loadSnapshot: async () => null,
      agent: () => inProcessAgent(complete),
      classify: async () => [],
      ask,
      onPhase: async (phase, groups) => {
        phases.push(`${phase}${groups ? `:${groups.length}` : ""}`);
      },
    });
    expect(phases).toEqual(["snapshot", "classify", "skeleton", "assign", "narrate:2"]);
    expect(out.groups.map((g) => [g.name, g.files, g.summary])).toEqual([
      ["Add the widget", ["src/core.test.ts", "src/core.ts"], "Written for Add the widget."],
      ["Supporting changes", ["docs/x.md"], "Written for Supporting changes."],
    ]);
    expect(peak).toBe(2);
    expect(out.inputTokens).toBe(11);
    expect(out.toolCalls).toBe(0);
  });

  test("a previous review's unchanged steps are kept, text included, and not rewritten", async () => {
    const written: string[] = [];
    const complete = async (prompt: string) => {
      if (prompt.includes("Name the steps only")) {
        expect(prompt).toContain("<kept>");
        return {
          text: '{"steps":[{"name":"Add the widget","intent":"w"},{"name":"Docs","intent":"d"}]}',
          inputTokens: 1,
          outputTokens: 1,
        };
      }
      written.push(/<step>\n\d+\. ([^\n]+)/.exec(prompt)?.[1] ?? "?");
      return { text: '{"summary":"New text."}', inputTokens: 1, outputTokens: 1 };
    };
    const out = await generateStaged({
      reviewId: "r2",
      repoId: "o/r",
      intent,
      headSha: "def",
      patch,
      previous: {
        groups: [
          {
            name: "Add the widget",
            summary: "Kept text.",
            files: ["src/core.ts", "src/core.test.ts"],
          },
          { name: "Old docs", summary: "Stale.", files: ["docs/x.md"] },
        ],
        patch:
          file("src/core.ts", "+core") +
          file("src/core.test.ts", "+test") +
          file("docs/x.md", "+older"),
      },
      systemOne,
      loadSnapshot: async () => null,
      agent: () => inProcessAgent(complete),
      classify: async () => [],
      ask,
      onPhase: async () => {},
    });
    expect(out.reusedSteps).toBe(1);
    expect(out.groups[0]).toEqual({
      name: "Add the widget",
      summary: "Kept text.",
      files: ["src/core.ts", "src/core.test.ts"],
    });
    expect(written).toEqual(["Supporting changes"]);
  });
});

import { describe, expect, test } from "vite-plus/test";
import { skeletonSchema } from "@triage/triage/review";
import { NO_USAGE } from "../src/pi.ts";
import { freshState, resumeStaged, type Step, type StepResult } from "../src/resume.ts";

const part = (over: Partial<StepResult>): StepResult => ({
  text: null,
  messages: [],
  turns: 0,
  toolCalls: 0,
  ...NO_USAGE,
  inputTokens: 10,
  ...over,
});
const build = (prev: string | null) => (prev ? `retry: ${prev}` : "prompt");
const GOOD = '{"steps":[{"name":"a","intent":"b"}]}';

describe("resumeStaged", () => {
  test("pauses with the conversation, resumes it, and retries once on bad output", async () => {
    const seen: { prompt: string; turns: number; count: number }[] = [];
    const answers = [
      // Part 1: two turns, then time is up.
      (m: unknown[], turns: number) =>
        part({
          messages: [...m, { role: "user", content: "t", timestamp: 1 }] as never,
          turns: turns + 2,
          toolCalls: 2,
        }),
      // Part 2: answers junk.
      (m: unknown[], turns: number) =>
        part({ text: "not json", messages: m as never, turns: turns + 1 }),
      // Attempt 2 starts with the error folded in and answers well.
      (m: unknown[], turns: number) =>
        part({ text: GOOD, messages: m as never, turns: turns + 1, toolCalls: 1 }),
    ];
    const step: Step = async (messages, turns) => {
      const first = messages[0]!;
      const prompt = typeof first.content === "string" ? first.content : "?";
      seen.push({ prompt, turns, count: messages.length });
      return answers.shift()!(messages, turns);
    };
    const state = freshState();
    const paused = await resumeStaged(state, build, skeletonSchema, step, () => true);
    expect(paused.status).toBe("running");
    expect(state.turns).toBe(2);
    expect(state.messages).toHaveLength(2);
    // The API asks again: the same state resumes; the junk answer starts attempt 2 in a
    // fresh conversation, and because time is up the retry waits for the next part.
    const again = await resumeStaged(state, build, skeletonSchema, step, () => true);
    expect(again.status).toBe("running");
    expect(state.attempt).toBe(1);
    expect(state.messages).toEqual([]);
    expect(state.turns).toBe(0);
    const done = await resumeStaged(state, build, skeletonSchema, step, () => false);
    expect(done.status).toBe("done");
    if (done.status === "done") expect(done.result.steps[0]!.name).toBe("a");
    expect(seen.map((s) => [s.prompt, s.turns, s.count])).toEqual([
      ["prompt", 0, 1],
      ["prompt", 2, 2],
      ["retry: response contained no JSON object", 0, 1],
    ]);
    expect(state.toolCalls).toBe(3);
    expect(state.usage.inputTokens).toBe(30);
  });

  test("a second bad answer fails the stage", async () => {
    const step: Step = async (messages, turns) =>
      part({ text: "nope", messages, turns: turns + 1 });
    await expect(
      resumeStaged(freshState(), build, skeletonSchema, step, () => false),
    ).rejects.toThrow(/failed validation/);
  });
});

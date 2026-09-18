import type { Message } from "@earendil-works/pi-ai";
import { extractJson } from "@triage/triage/review";
import { addUsage, NO_USAGE, type CallUsage } from "./pi.ts";

/**
 * A stage as a resumable state machine. A cell answers each request inside a time budget
 * (celld's handler budget, five minutes by default), and an agent that reads a repository can
 * take longer than that. So a stage runs in parts: the agent works until the part's deadline,
 * the cell stores the conversation and answers "running", and the API asks again. Nothing is
 * repeated; the model sees one continuous conversation across the parts.
 */
export interface AgentState {
  /** 0 on the first try; 1 once the model's answer failed validation and it was asked again. */
  attempt: number;
  lastError: string | null;
  /** The conversation so far; empty means the next part builds the prompt. */
  messages: Message[];
  /** Model turns in this attempt (the turn cap is per attempt). */
  turns: number;
  toolCalls: number;
  usage: CallUsage;
}

export function freshState(): AgentState {
  return { attempt: 0, lastError: null, messages: [], turns: 0, toolCalls: 0, usage: NO_USAGE };
}

/** What one part of agent work reports back. */
export interface StepResult extends CallUsage {
  /** The model's final text, or null when the deadline passed before it answered. */
  text: string | null;
  messages: Message[];
  /** Turns taken in this attempt so far, counting earlier parts. */
  turns: number;
  /** Tool calls in this part only. */
  toolCalls: number;
}

export type Step = (messages: Message[], turns: number) => Promise<StepResult>;

export type Outcome<T> =
  | { status: "running"; state: AgentState }
  | { status: "done"; result: T; state: AgentState };

/**
 * Advance a stage by one part. Returns "running" with the state to store, or "done" with the
 * validated result. A second failed validation throws, like a provider error does.
 */
export async function resumeStaged<T>(
  state: AgentState,
  build: (previousError: string | null) => string,
  schema: Parameters<typeof extractJson<T>>[1],
  step: Step,
  timeUp: () => boolean,
): Promise<Outcome<T>> {
  for (;;) {
    if (state.messages.length === 0)
      state.messages = [{ role: "user", content: build(state.lastError), timestamp: Date.now() }];
    const part = await step(state.messages, state.turns);
    state.messages = part.messages;
    state.turns = part.turns;
    state.toolCalls += part.toolCalls;
    state.usage = addUsage(state.usage, part);
    if (part.text === null) return { status: "running", state };
    try {
      return { status: "done", result: extractJson(part.text, schema), state };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (state.attempt >= 1) throw new Error(`output failed validation: ${message}`);
      state.attempt += 1;
      state.lastError = message;
      state.messages = [];
      state.turns = 0;
      if (timeUp()) return { status: "running", state };
    }
  }
}

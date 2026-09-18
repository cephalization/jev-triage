import { Type, type Message, type Tool } from "@earendil-works/pi-ai";
import { injectTraceHeaders } from "@triage/openinference-workers";
import {
  OpenInferenceSpanKind,
  SemanticConventions as S,
} from "@arizeai/openinference-semantic-conventions";
import { SpanStatusCode, trace, type Attributes, type Tracer } from "@opentelemetry/api";
import {
  addUsage,
  modelFor,
  models,
  NO_USAGE,
  usageOf,
  type CallUsage,
  type ProviderSpec,
} from "./pi.ts";
import type { StepResult } from "./resume.ts";

/**
 * The agent loop: one prompt, a small set of repository tools, and jev behind `rank_files`
 * so the agent asks which of many candidates matter instead of reading them all. Tool calls
 * are executed here, appended to the context, and the model is asked again. Every model turn
 * is an LLM span and every tool call a TOOL span, nested under whatever span is active.
 */

export interface Callback {
  /** The API's base URL for jev-backed tools, with the shared token. */
  url: string;
  token: string | null;
}

/** The repository at the pull request's head, behind the RepoSnapshot cell's HTTP surface. */
export interface SnapshotClient {
  list(prefix: string, limit: number): Promise<{ path: string; size: number }[]>;
  read(path: string): Promise<{ path: string; size: number; text: string } | null>;
  grep(
    pattern: string,
    glob: string | null,
    limit: number,
  ): Promise<{ path: string; line: number; text: string }[]>;
}

export function snapshotClient(
  stub: { fetch: (input: string, init?: RequestInit) => Promise<Response> },
  base: string,
): SnapshotClient {
  const get = async <T>(tail: string, params: Record<string, string | number | null>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== null && v !== "") q.set(k, String(v));
    // The snapshot cell is another isolate; the trace follows through the headers.
    const res = await stub.fetch(`http://snapshot${base}/${tail}?${q.toString()}`, {
      headers: injectTraceHeaders(),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 500);
      throw new Error(`snapshot ${tail} answered ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return (await res.json()) as T;
  };
  return {
    list: async (prefix, limit) =>
      (await get<{ path: string; size: number }[]>("list", { prefix, limit })) ?? [],
    read: (path) => get("file", { path }),
    grep: async (pattern, glob, limit) =>
      (await get<{ path: string; line: number; text: string }[]>("grep", {
        q: pattern,
        glob,
        limit,
      })) ?? [],
  };
}

/** How long one part works before handing the conversation back to be resumed. */
export interface AgentOptions {
  /** Epoch ms: after the first turn that ends past this, return with `text: null`. */
  yieldAfter: number;
  /** Turns already taken in this attempt by earlier parts. */
  turns: number;
}

/** A ceiling on model turns per attempt, far above any review. */
const MAX_TURNS = 200;
const READ_LINES = 400;

export function toolDefinitions(): Tool[] {
  return [
    {
      name: "list_files",
      description:
        "List files in the repository at this pull request's head under a path prefix. Returns paths and sizes.",
      parameters: Type.Object({
        prefix: Type.Optional(Type.String({ description: "Directory prefix, e.g. src/server/" })),
        limit: Type.Optional(Type.Number()),
      }),
    },
    {
      name: "read_file",
      description:
        "Read a file from the repository at this pull request's head, optionally a line range (1-based, inclusive). At most 400 lines per call.",
      parameters: Type.Object({
        path: Type.String(),
        start: Type.Optional(Type.Number()),
        end: Type.Optional(Type.Number()),
      }),
    },
    {
      name: "grep",
      description:
        "Search file contents at this pull request's head. `pattern` is a regular expression (or a literal); `glob` narrows paths (e.g. src/**/*.ts). Returns path, line and text.",
      parameters: Type.Object({
        pattern: Type.String(),
        glob: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
      }),
    },
    {
      name: "rank_files",
      description:
        "Ask a fast classifier which of up to 40 candidate paths are relevant to a question, so you read the few that matter. Returns the candidates with a relevance probability, best first.",
      parameters: Type.Object({
        question: Type.String({
          description:
            "What you need to understand, e.g. 'callers of execute_operation that pass allow_mutations'",
        }),
        candidates: Type.Array(Type.String(), { maxItems: 40 }),
      }),
    },
  ];
}

export interface ToolHost {
  snapshot: SnapshotClient;
  callback: Callback | null;
  /** `owner/repo`, so jev's work is accounted to the repository. */
  repo: string;
  /** Null traces into nothing. */
  tracer: Tracer | null;
}

const noopTracer = trace.getTracer("noop");

/** Bounded attribute payloads; Phoenix stores them, but a 5 MB prompt helps nobody. */
function clip(text: string, max = 200_000): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more chars)` : text;
}

export async function runTool(
  host: ToolHost,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const snap = host.snapshot;
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  const num = (k: string, d: number) => (typeof args[k] === "number" ? (args[k] as number) : d);
  const run = async (): Promise<{ text: string; isError: boolean }> => {
    switch (name) {
      case "list_files": {
        const rows = await snap.list(str("prefix"), Math.min(500, num("limit", 200)));
        return {
          text: rows.map((r) => `${r.path} (${r.size} bytes)`).join("\n") || "(none)",
          isError: false,
        };
      }
      case "read_file": {
        const row = await snap.read(str("path"));
        if (!row) return { text: `no such file: ${str("path")}`, isError: true };
        const lines = row.text.split("\n");
        const start = Math.max(1, num("start", 1));
        const end = Math.min(
          lines.length,
          num("end", start + READ_LINES - 1),
          start + READ_LINES - 1,
        );
        const body = lines
          .slice(start - 1, end)
          .map((l, i) => `${String(start + i).padStart(5)}  ${l}`)
          .join("\n");
        return {
          text: `${row.path} lines ${start}-${end} of ${lines.length}\n${body}`,
          isError: false,
        };
      }
      case "grep": {
        const rows = await snap.grep(
          str("pattern"),
          str("glob") || null,
          Math.min(200, num("limit", 50)),
        );
        return {
          text: rows.map((r) => `${r.path}:${r.line}: ${r.text}`).join("\n") || "(no matches)",
          isError: false,
        };
      }
      case "rank_files": {
        if (!host.callback) return { text: "rank_files is not available", isError: true };
        const candidates = Array.isArray(args.candidates)
          ? (args.candidates as unknown[])
              .filter((c): c is string => typeof c === "string")
              .slice(0, 40)
          : [];
        const res = await fetch(`${host.callback.url.replace(/\/+$/, "")}/api/internal/rerank`, {
          method: "POST",
          headers: injectTraceHeaders({
            "content-type": "application/json",
            ...(host.callback.token ? { "x-reviewer-token": host.callback.token } : {}),
          }),
          body: JSON.stringify({ repo: host.repo, question: str("question"), candidates }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          ranked?: { path: string; relevance: number }[];
          error?: string;
        };
        if (!res.ok || !data.ranked)
          return { text: data.error ?? `rerank failed (${res.status})`, isError: true };
        return {
          text:
            data.ranked.map((r) => `${r.relevance.toFixed(2)}  ${r.path}`).join("\n") || "(none)",
          isError: false,
        };
      }
      default:
        return { text: `unknown tool ${name}`, isError: true };
    }
  };
  const tracer = host.tracer ?? noopTracer;
  return tracer.startActiveSpan(
    name,
    {
      attributes: {
        [S.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
        [S.TOOL_NAME]: name,
        [S.INPUT_VALUE]: JSON.stringify(args),
        [S.INPUT_MIME_TYPE]: "application/json",
      },
    },
    async (span) => {
      try {
        // A tool that throws is a failed call, not a failed review: the model sees the message
        // as the tool's result and can change its arguments or its approach.
        const result = await run().catch((e: unknown) => {
          const error = e instanceof Error ? e : new Error(String(e));
          span.recordException(error);
          return { text: `${name} failed: ${error.message}`, isError: true };
        });
        span.setAttributes({
          [S.OUTPUT_VALUE]: clip(result.text, 40_000),
          [S.OUTPUT_MIME_TYPE]: "text/plain",
        });
        span.setStatus(
          result.isError
            ? { code: SpanStatusCode.ERROR, message: result.text.slice(0, 200) }
            : { code: SpanStatusCode.OK },
        );
        return result;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Ask with tools until the model answers in text or the part's time is up. `messages` is the
 * conversation so far (a single user prompt to start) and is extended in place, so the caller
 * can store it and resume later with the same array.
 */
export async function runAgent(
  spec: ProviderSpec,
  modelId: string,
  messages: Message[],
  host: ToolHost,
  options: AgentOptions,
): Promise<StepResult> {
  const m = models();
  const { model, priced } = modelFor(spec, modelId);
  const tools = toolDefinitions();
  const tracer = host.tracer ?? noopTracer;
  let usage: CallUsage = NO_USAGE;
  let toolCalls = 0;
  let turns = options.turns;
  while (turns < MAX_TURNS) {
    const turn = turns;
    const r = await tracer.startActiveSpan(
      `${spec.kind}.completion`,
      { attributes: llmRequestAttributes(spec, modelId, model.maxTokens, turn, messages, tools) },
      async (span) => {
        try {
          const out = await m.completeSimple(
            model,
            { messages, tools },
            { apiKey: spec.apiKey, maxTokens: model.maxTokens },
          );
          span.setAttributes(llmResponseAttributes(out, priced));
          if (out.stopReason === "error" || out.stopReason === "aborted")
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: out.errorMessage ?? out.stopReason,
            });
          else span.setStatus({ code: SpanStatusCode.OK });
          return out;
        } catch (e) {
          span.recordException(e instanceof Error ? e : new Error(String(e)));
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw e;
        } finally {
          span.end();
        }
      },
    );
    turns += 1;
    usage = addUsage(usage, usageOf(r.usage, priced));
    if (r.stopReason === "error" || r.stopReason === "aborted")
      throw new Error(`${spec.kind} ${modelId}: ${r.errorMessage ?? r.stopReason}`);
    const calls = r.content.filter((c) => c.type === "toolCall");
    const text = r.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
    if (calls.length === 0 || r.stopReason !== "toolUse")
      return { text, messages, turns, toolCalls, ...usage };
    messages.push(r);
    for (const call of calls) {
      toolCalls += 1;
      const result = await runTool(host, call.name, call.arguments);
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: result.text.slice(0, 40_000) }],
        isError: result.isError,
        timestamp: Date.now(),
      });
    }
    if (Date.now() >= options.yieldAfter)
      return { text: null, messages, turns, toolCalls, ...usage };
  }
  throw new Error(`the agent used ${MAX_TURNS} tool turns without answering`);
}

type PiResponse = Awaited<ReturnType<ReturnType<typeof models>["completeSimple"]>>;

function llmRequestAttributes(
  spec: ProviderSpec,
  modelId: string,
  maxTokens: number,
  turn: number,
  messages: readonly Message[],
  tools: readonly Tool[],
): Attributes {
  const out: Attributes = {
    [S.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.LLM,
    [S.LLM_MODEL_NAME]: modelId,
    [S.LLM_SYSTEM]: spec.kind === "openai-compatible" ? "openai" : spec.kind,
    [S.LLM_PROVIDER]: new URL(spec.baseUrl).host,
    [S.LLM_INVOCATION_PARAMETERS]: JSON.stringify({ max_tokens: maxTokens, turn }),
  };
  messages.forEach((m, i) => {
    const p = `${S.LLM_INPUT_MESSAGES}.${i}.`;
    if (m.role === "user") {
      out[`${p}${S.MESSAGE_ROLE}`] = "user";
      out[`${p}${S.MESSAGE_CONTENT}`] = clip(
        typeof m.content === "string"
          ? m.content
          : m.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join(""),
      );
    } else if (m.role === "toolResult") {
      out[`${p}${S.MESSAGE_ROLE}`] = "tool";
      out[`${p}${S.MESSAGE_CONTENT}`] = clip(
        m.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join(""),
      );
      out[`${p}${S.MESSAGE_TOOL_CALL_ID}`] = m.toolCallId;
    } else {
      out[`${p}${S.MESSAGE_ROLE}`] = "assistant";
      out[`${p}${S.MESSAGE_CONTENT}`] = clip(
        m.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join(""),
      );
      m.content
        .filter((c) => c.type === "toolCall")
        .forEach((c, j) => {
          const t = `${p}${S.MESSAGE_TOOL_CALLS}.${j}.`;
          out[`${t}${S.TOOL_CALL_ID}`] = c.id;
          out[`${t}${S.TOOL_CALL_FUNCTION_NAME}`] = c.name;
          out[`${t}${S.TOOL_CALL_FUNCTION_ARGUMENTS_JSON}`] = JSON.stringify(c.arguments);
        });
    }
  });
  tools.forEach((t, i) => {
    out[`${S.LLM_TOOLS}.${i}.${S.TOOL_NAME}`] = t.name;
    out[`${S.LLM_TOOLS}.${i}.${S.TOOL_DESCRIPTION}`] = t.description;
    out[`${S.LLM_TOOLS}.${i}.${S.TOOL_JSON_SCHEMA}`] = JSON.stringify(t.parameters);
  });
  return out;
}

function llmResponseAttributes(r: PiResponse, priced: boolean): Attributes {
  const text = r.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  const out: Attributes = {
    [`${S.LLM_OUTPUT_MESSAGES}.0.${S.MESSAGE_ROLE}`]: "assistant",
    [`${S.LLM_OUTPUT_MESSAGES}.0.${S.MESSAGE_CONTENT}`]: clip(text),
    [S.LLM_TOKEN_COUNT_PROMPT]: r.usage.input,
    [S.LLM_TOKEN_COUNT_COMPLETION]: r.usage.output,
    [S.LLM_TOKEN_COUNT_TOTAL]: r.usage.input + r.usage.output,
    [S.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ]: r.usage.cacheRead,
    [S.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE]: r.usage.cacheWrite,
    "llm.stop_reason": r.stopReason,
  };
  r.content
    .filter((c) => c.type === "toolCall")
    .forEach((c, j) => {
      const t = `${S.LLM_OUTPUT_MESSAGES}.0.${S.MESSAGE_TOOL_CALLS}.${j}.`;
      out[`${t}${S.TOOL_CALL_ID}`] = c.id;
      out[`${t}${S.TOOL_CALL_FUNCTION_NAME}`] = c.name;
      out[`${t}${S.TOOL_CALL_FUNCTION_ARGUMENTS_JSON}`] = JSON.stringify(c.arguments);
    });
  if (priced) {
    out[S.LLM_COST_PROMPT] = r.usage.cost.input + r.usage.cost.cacheRead + r.usage.cost.cacheWrite;
    out[S.LLM_COST_COMPLETION] = r.usage.cost.output;
    out[S.LLM_COST_TOTAL] = r.usage.cost.total;
  }
  return out;
}

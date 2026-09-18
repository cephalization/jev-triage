import { Type, type Message, type Tool } from "@earendil-works/pi-ai";
import { clip, messageAttrs, OI, toolAttrs, type Span, type Tracer } from "@triage/triage/trace";
import {
  addUsage,
  modelFor,
  models,
  NO_USAGE,
  usageOf,
  type CallUsage,
  type Completion,
  type ProviderSpec,
} from "./pi.ts";

/**
 * The agent loop: one prompt, a small set of repository tools, and jev behind `rank_files`
 * so the agent asks which of many candidates matter instead of reading them all. Tool calls
 * are executed here, appended to the context, and the model is asked again. Every model turn
 * and every tool call is a span in Phoenix.
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
  stub: { fetch: (input: string) => Promise<Response> },
  base: string,
): SnapshotClient {
  const get = async <T>(tail: string, params: Record<string, string | number | null>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== null && v !== "") q.set(k, String(v));
    const res = await stub.fetch(`http://snapshot${base}/${tail}?${q.toString()}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`snapshot ${tail} answered ${res.status}`);
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

export interface AgentRun extends Completion {
  toolCalls: number;
}

/** A ceiling on tool turns per call, far above any review; the API's ten-minute timeout is the real limit. */
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
  tracer: Tracer;
}

export async function runTool(
  host: ToolHost,
  name: string,
  args: Record<string, unknown>,
  parent: Span | null,
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
          headers: {
            "content-type": "application/json",
            ...(host.callback.token ? { "x-reviewer-token": host.callback.token } : {}),
          },
          body: JSON.stringify({
            repo: host.repo,
            question: str("question"),
            candidates,
            trace: parent ? parent.context(host.tracer.endpoint ?? "", host.tracer.project) : null,
          }),
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
  const span = host.tracer.start(name, "TOOL", parent, {
    [OI.toolName]: name,
    [OI.inputValue]: JSON.stringify(args),
    [OI.inputMime]: "application/json",
  });
  const result = await run();
  host.tracer.end(
    span,
    { [OI.outputValue]: clip(result.text, 40_000), [OI.outputMime]: "text/plain" },
    result.isError ? result.text.slice(0, 200) : null,
  );
  return result;
}

/** Ask with tools until the model answers in text. */
export async function runAgent(
  spec: ProviderSpec,
  modelId: string,
  prompt: string,
  host: ToolHost,
  parent: Span | null,
): Promise<AgentRun> {
  const m = models();
  const { model, priced } = modelFor(spec, modelId);
  const messages: Message[] = [{ role: "user", content: prompt, timestamp: Date.now() }];
  const tools = toolDefinitions();
  let usage: CallUsage = NO_USAGE;
  let toolCalls = 0;
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const span = host.tracer.start(`${spec.kind}.completion`, "LLM", parent, {
      [OI.modelName]: modelId,
      [OI.system]: spec.kind === "openai-compatible" ? "openai" : spec.kind,
      [OI.provider]: new URL(spec.baseUrl).host,
      [OI.invocationParameters]: JSON.stringify({ max_tokens: model.maxTokens, turn }),
      ...messageAttrs("llm.input_messages", messages.map(asPlainMessage)),
      ...toolAttrs(tools),
    });
    let r: Awaited<ReturnType<typeof m.completeSimple>>;
    try {
      r = await m.completeSimple(
        model,
        { messages, tools },
        { apiKey: spec.apiKey, maxTokens: model.maxTokens },
      );
    } catch (e) {
      host.tracer.end(span, {}, e);
      throw e;
    }
    const turnUsage = usageOf(r.usage, priced);
    usage = addUsage(usage, turnUsage);
    const calls = r.content.filter((c) => c.type === "toolCall");
    const text = r.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
    host.tracer.end(
      span,
      {
        ...messageAttrs("llm.output_messages", [
          {
            role: "assistant",
            content: text,
            toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
          },
        ]),
        [OI.promptTokens]: turnUsage.inputTokens,
        [OI.completionTokens]: turnUsage.outputTokens,
        [OI.totalTokens]: turnUsage.inputTokens + turnUsage.outputTokens,
        [OI.cacheReadTokens]: turnUsage.cacheReadTokens,
        [OI.cacheWriteTokens]: turnUsage.cacheWriteTokens,
        ...(priced
          ? {
              [OI.costPrompt]:
                r.usage.cost.input + r.usage.cost.cacheRead + r.usage.cost.cacheWrite,
              [OI.costCompletion]: r.usage.cost.output,
              [OI.costTotal]: r.usage.cost.total,
            }
          : {}),
        "llm.stop_reason": r.stopReason,
      },
      r.stopReason === "error" || r.stopReason === "aborted"
        ? (r.errorMessage ?? r.stopReason)
        : null,
    );
    if (r.stopReason === "error" || r.stopReason === "aborted")
      throw new Error(`${spec.kind} ${modelId}: ${r.errorMessage ?? r.stopReason}`);
    if (calls.length === 0 || r.stopReason !== "toolUse") return { text, ...usage, toolCalls };
    messages.push(r);
    for (const call of calls) {
      toolCalls += 1;
      const result = await runTool(host, call.name, call.arguments, parent);
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: result.text.slice(0, 40_000) }],
        isError: result.isError,
        timestamp: Date.now(),
      });
    }
  }
  throw new Error(`the agent used ${MAX_TURNS} tool turns without answering`);
}

/** pi's message shapes flattened for the trace. */
function asPlainMessage(m: Message): {
  role: string;
  content: string;
  toolCalls?: { id: string; name: string; arguments: unknown }[];
} {
  if (m.role === "user")
    return {
      role: "user",
      content: clip(
        typeof m.content === "string"
          ? m.content
          : m.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join(""),
      ),
    };
  if (m.role === "toolResult")
    return {
      role: "tool",
      content: clip(m.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("")),
    };
  return {
    role: "assistant",
    content: clip(
      m.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join(""),
    ),
    toolCalls: m.content
      .filter(
        (
          c,
        ): c is {
          type: "toolCall";
          id: string;
          name: string;
          arguments: Record<string, unknown>;
        } => c.type === "toolCall",
      )
      .map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
  };
}

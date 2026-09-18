import type { SystemOne } from "@triage/triage";
import {
  askJson,
  buildAssignQuestions,
  buildAssignState,
  buildChangeQuestions,
  buildChangeState,
  buildNarrativePrompt,
  buildSkeletonPrompt,
  changedFiles,
  FILES_PER_ASSIGN_REQUEST,
  foldAssignments,
  foldChanges,
  groupsFromAssignments,
  MATERIAL,
  narrativeSchema,
  renderClassification,
  reusableSteps,
  skeletonSchema,
  splitPatch,
  type ClassifiedFile,
  type NarrativeRequest,
  type PatchFile,
  type ReviewGroup,
  type ReviewIntent,
  type SkeletonRequest,
  type StepAssignment,
  type StepSkeleton,
} from "@triage/triage/review";
import { askSystemOne } from "./jev.ts";
import type { Completion, RunnerProvider } from "./runner.ts";

/**
 * The staged generation. Serial work is limited to two short agent calls; everything that can
 * run side by side does: the repository snapshot loads while jev classifies the files, and
 * every step's narrative is written at the same time as the others. Steps whose files did not
 * change since the previous review are kept, text and marks included.
 */

export type Phase = "snapshot" | "classify" | "skeleton" | "assign" | "narrate";

export interface Cell {
  url: string;
  token: string | null;
}

export interface Snapshot {
  owner: string;
  repo: string;
  sha: string;
}

/** The agent stages: structured request in, validated answer and usage out. */
export interface AgentStage {
  skeleton(req: SkeletonRequest): Promise<AgentAnswer<{ steps: StepSkeleton[] }>>;
  narrative(req: NarrativeRequest): Promise<AgentAnswer<{ summary: string }>>;
}

export interface AgentAnswer<T> {
  result: T;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
}

export interface StageInput {
  reviewId: string;
  repoId: string;
  intent: ReviewIntent;
  headSha: string;
  patch: string;
  previous: { groups: ReviewGroup[]; patch: string } | null;
  systemOne: SystemOne;
  /** Loads the repository at the head; resolves null when there is no cell or it failed. */
  loadSnapshot: () => Promise<Snapshot | null>;
  /** The agent, with tools when a snapshot is given. */
  agent: (snapshot: Snapshot | null) => AgentStage;
  classify: (intent: ReviewIntent, files: readonly PatchFile[]) => Promise<ClassifiedFile[]>;
  onPhase: (phase: Phase, groups: ReviewGroup[] | null) => Promise<void>;
  /** The accounted System One call; tests pass one that skips the database. */
  ask?: typeof askSystemOne;
}

export interface StagedOutput {
  groups: ReviewGroup[];
  files: string[];
  classified: ClassifiedFile[];
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  reusedSteps: number;
  snapshot: Snapshot | null;
}

const NARRATIVE_CONCURRENCY = 6;

export async function generateStaged(input: StageInput): Promise<StagedOutput> {
  const files = splitPatch(input.patch);
  const paths = files.map((x) => x.path);
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  const count = <T>(a: AgentAnswer<T>): T => {
    inputTokens += a.inputTokens;
    outputTokens += a.outputTokens;
    toolCalls += a.toolCalls;
    return a.result;
  };

  // 1. Snapshot and classification side by side; neither failing stops the review.
  await input.onPhase("snapshot", null);
  const snapshotP = input.loadSnapshot().catch((e: unknown) => {
    console.warn(`[review] ${input.reviewId}: snapshot failed: ${message(e)}`);
    return null;
  });
  const classifiedP = input.classify(input.intent, files).catch((e: unknown) => {
    console.warn(
      `[review] ${input.reviewId}: file classification failed, continuing without it: ${message(e)}`,
    );
    return [] as ClassifiedFile[];
  });
  await input.onPhase("classify", null);
  const classified = await classifiedP;
  const classification = classified.length > 0 ? renderClassification(classified) : null;
  const skimPaths = new Set(
    classified.filter((c) => (c.signal.attention ?? 1) < 0.2).map((c) => c.path),
  );

  // 2. What survives from the previous review.
  const reused = input.previous ? await keepUnchanged(input, files, input.previous) : [];
  const reusedPaths = new Set(reused.flatMap((g) => g.files));

  // 3. The skeleton: step names and intents, with repository tools when the snapshot loaded.
  await input.onPhase("skeleton", null);
  const snapshot = await snapshotP;
  const agent = input.agent(snapshot);
  const skeleton = count(
    await agent.skeleton({
      intent: input.intent,
      files,
      classification,
      reusedSteps: reused,
      skimPaths,
      tools: snapshot !== null,
    }),
  );
  const steps = withReusedSteps(skeleton.steps, reused);

  // 4. jev places every file that is not already in a kept step.
  await input.onPhase("assign", null);
  const toAssign = files.filter((x) => !reusedPaths.has(x.path));
  const assignments = await assignAll(input, steps, toAssign);
  let groups: ReviewGroup[] = groupsFromAssignments(steps, toAssign, assignments, classified);
  const keptNames = new Set<string>();
  for (const g of reused) {
    const hit = groups.find((x) => x.name === g.name);
    if (hit) {
      // New or changed files landed in a kept step: it is rewritten with all of them.
      hit.files = [...g.files, ...hit.files];
    } else {
      groups.push({ name: g.name, summary: g.summary, files: [...g.files] });
      keptNames.add(g.name);
    }
  }
  groups = orderLike(groups, steps);

  // 5. Narratives, in parallel, for every step that is not kept. The skeleton is visible now.
  await input.onPhase("narrate", groups);
  const byPath = new Map(files.map((x) => [x.path, x]));
  const lines = classification ? classification.split("\n") : [];
  const allSteps = groups.map(
    (x) => steps.find((s) => s.name === x.name) ?? { name: x.name, intent: x.summary },
  );
  await parallel(
    groups.filter((g) => !keptNames.has(g.name)),
    NARRATIVE_CONCURRENCY,
    async (g) => {
      const index = groups.indexOf(g);
      const out = count(
        await agent.narrative({
          intent: input.intent,
          step: allSteps[index]!,
          index,
          allSteps,
          files: g.files.map((p) => byPath.get(p)).filter((x): x is PatchFile => !!x),
          classification:
            lines.filter((l) => g.files.some((p) => l.includes(` ${p}:`))).join("\n") || null,
          tools: snapshot !== null,
        }),
      );
      g.summary = out.summary;
    },
  );

  return {
    groups,
    files: paths,
    classified,
    inputTokens,
    outputTokens,
    toolCalls,
    reusedSteps: keptNames.size,
    snapshot,
  };
}

/** The in-process agent: the pure prompts, one completion each, no tools. */
export function inProcessAgent(complete: (prompt: string) => Promise<Completion>): AgentStage {
  const run = async <T>(
    build: (prev: string | null) => string,
    schema: Parameters<typeof askJson<T>>[1],
  ): Promise<AgentAnswer<T>> => {
    let inputTokens = 0;
    let outputTokens = 0;
    const result = await askJson(build, schema, async (prompt) => {
      const c = await complete(prompt);
      inputTokens += c.inputTokens;
      outputTokens += c.outputTokens;
      return c.text;
    });
    return { result, inputTokens, outputTokens, toolCalls: 0 };
  };
  return {
    skeleton: (req) => run((p) => buildSkeletonPrompt({ ...req, tools: false }, p), skeletonSchema),
    narrative: (req) =>
      run((p) => buildNarrativePrompt({ ...req, tools: false }, p), narrativeSchema),
  };
}

/** The cell agent: the structured request travels; the cell builds the prompt and offers tools. */
export function cellAgent(
  cell: Cell,
  reviewId: string,
  repoId: string,
  provider: RunnerProvider,
  model: string,
  callbackUrl: string,
  snapshot: Snapshot | null,
  fetchImpl: typeof fetch = fetch,
): AgentStage {
  const post = async <T>(
    stage: "skeleton" | "narrative",
    request: unknown,
  ): Promise<AgentAnswer<T>> => {
    const res = await fetchImpl(`${cell.url}/runs/${encodeURIComponent(reviewId)}/${stage}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cell.token ? { "x-reviewer-token": cell.token } : {}),
      },
      body: JSON.stringify({
        provider: { kind: provider.kind, baseUrl: provider.baseUrl, apiKey: provider.key },
        model,
        callback: { url: callbackUrl, token: cell.token },
        repo: repoId,
        snapshot,
        request,
      }),
      signal: AbortSignal.timeout(10 * 60_000),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<AgentAnswer<T>> & {
      error?: string;
    };
    if (!res.ok || data.result === undefined)
      throw new Error(`reviewer cell: ${data.error ?? `status ${res.status}`}`);
    return {
      result: data.result,
      inputTokens: data.inputTokens ?? 0,
      outputTokens: data.outputTokens ?? 0,
      toolCalls: data.toolCalls ?? 0,
    };
  };
  return {
    skeleton: (req) =>
      post("skeleton", {
        intent: req.intent,
        patch: req.files.map((f) => f.text).join(""),
        classification: req.classification,
        reusedSteps: req.reusedSteps,
        skimPaths: [...req.skimPaths],
      }),
    narrative: (req) =>
      post("narrative", {
        intent: req.intent,
        step: req.step,
        index: req.index,
        allSteps: req.allSteps,
        patch: req.files.map((f) => f.text).join(""),
        classification: req.classification,
      }),
  };
}

/** Load the repository at the head into the cell; null when the cell cannot or has no token. */
export async function loadSnapshotInCell(
  cell: Cell,
  repoId: string,
  sha: string,
  github: { token: string | null; apiBase: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Snapshot | null> {
  const [owner, repo] = repoId.split("/") as [string, string];
  const res = await fetchImpl(`${cell.url}/snapshots/${owner}/${repo}/${sha}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cell.token ? { "x-reviewer-token": cell.token } : {}),
    },
    body: JSON.stringify({ owner, repo, sha, apiBase: github.apiBase, token: github.token }),
    signal: AbortSignal.timeout(180_000),
  });
  const s = (await res.json().catch(() => ({}))) as { status?: string; error?: string | null };
  if (s.status !== "ready") throw new Error(s.error ?? `snapshot ${s.status ?? res.status}`);
  return { owner, repo, sha };
}

/** Steps from the previous review whose files carry the same hunks now, jev judging near-misses. */
async function keepUnchanged(
  input: StageInput,
  files: readonly PatchFile[],
  previous: { groups: ReviewGroup[]; patch: string },
): Promise<ReviewGroup[]> {
  const before = splitPatch(previous.patch);
  const changed = changedFiles(before, files);
  const material = new Set<string>();
  if (changed.length > 0) {
    try {
      const result = await (input.ask ?? askSystemOne)(input.systemOne, {
        repoId: input.repoId,
        kind: "review_changes",
        state: buildChangeState(changed),
        questions: buildChangeQuestions(changed.length),
        items: changed.length,
      });
      const probs = foldChanges(
        result.answers as Parameters<typeof foldChanges>[0],
        changed.length,
      );
      changed.forEach((c, i) => {
        if ((probs[i] ?? 1) >= MATERIAL) material.add(c.path);
      });
    } catch {
      for (const c of changed) material.add(c.path);
    }
  }
  const current = new Set(files.map((x) => x.path));
  return reusableSteps(previous.groups, current, material);
}

/** The model may drop or rename a kept step; put every kept step back where it was. */
function withReusedSteps(steps: StepSkeleton[], reused: ReviewGroup[]): StepSkeleton[] {
  const out = [...steps];
  reused.forEach((g, i) => {
    if (!out.some((s) => s.name === g.name))
      out.splice(Math.min(i, out.length), 0, { name: g.name, intent: g.summary.slice(0, 400) });
  });
  return out;
}

function orderLike(groups: ReviewGroup[], steps: readonly StepSkeleton[]): ReviewGroup[] {
  const rank = new Map(steps.map((s, i) => [s.name, i]));
  return [...groups].sort((a, b) => (rank.get(a.name) ?? 99) - (rank.get(b.name) ?? 99));
}

async function assignAll(
  input: StageInput,
  steps: readonly StepSkeleton[],
  files: readonly PatchFile[],
): Promise<StepAssignment[]> {
  const batches: PatchFile[][] = [];
  for (let i = 0; i < files.length; i += FILES_PER_ASSIGN_REQUEST)
    batches.push(files.slice(i, i + FILES_PER_ASSIGN_REQUEST));
  const results = await Promise.all(
    batches.map(async (batch) => {
      try {
        const result = await (input.ask ?? askSystemOne)(input.systemOne, {
          repoId: input.repoId,
          kind: "review_assign",
          state: buildAssignState(input.intent, steps, batch),
          questions: buildAssignQuestions(batch.length, steps),
          items: batch.length,
        });
        return foldAssignments(
          result.answers as Parameters<typeof foldAssignments>[0],
          batch.length,
        );
      } catch (e) {
        console.warn(
          `[review] ${input.reviewId}: assignment failed for ${batch.length} files: ${message(e)}`,
        );
        return batch.map((): StepAssignment => ({ step: null, confidence: null }));
      }
    }),
  );
  return results.flat();
}

async function parallel<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      await fn(items[i]!);
    }
  });
  await Promise.all(workers);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

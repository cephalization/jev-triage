import type { SystemOne } from "@triage/triage";
import {
  assertCoversAll,
  buildAssignQuestions,
  buildAssignState,
  buildChangeQuestions,
  buildChangeState,
  changedFiles,
  FILES_PER_ASSIGN_REQUEST,
  foldAssignments,
  foldChanges,
  groupsFromAssignments,
  MATERIAL,
  renderClassification,
  reusableSteps,
  splitPatch,
  type ClassifiedFile,
  type Narrative,
  type NarrativeRequest,
  type PatchFile,
  type ReviewGroup,
  type ReviewIntent,
  type SkeletonRequest,
  type StepAssignment,
  type StepSkeleton,
} from "@triage/triage/review";
import { OI, type Attrs, type Span, type Tracer } from "@triage/triage/trace";
import { cellHeaders, type Cell, type Snapshot } from "./cell.ts";
import { askSystemOne, type JevTrace } from "./jev.ts";
import { addUsage, NO_USAGE, type CallUsage } from "./usage.ts";

/**
 * The staged generation. Serial work is limited to two short agent calls; everything that can
 * run side by side does: the repository snapshot loads while jev classifies the files, and
 * every step's narrative is written at the same time as the others. Steps whose files did not
 * change since the previous review are kept, text and marks included.
 *
 * Every stage either succeeds or throws. There is no degraded path: a review is the model's
 * work over jev's structure with the repository in reach, or it is a failure with its reason.
 */

export type Phase = "snapshot" | "classify" | "skeleton" | "assign" | "narrate";

/** The agent stages: structured request in, validated answer and usage out, under a span. */
export interface AgentStage {
  skeleton(req: SkeletonRequest, parent: Span): Promise<AgentAnswer<{ steps: StepSkeleton[] }>>;
  narrative(req: NarrativeRequest, parent: Span): Promise<AgentAnswer<Narrative>>;
}

export interface AgentAnswer<T> extends CallUsage {
  result: T;
  toolCalls: number;
}

/** One agent call as it will be stored: what stage, and what it cost. */
export interface CostCall extends CallUsage {
  stage: "skeleton" | "narrative";
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
  loadSnapshot: () => Promise<Snapshot>;
  agent: (snapshot: Snapshot) => AgentStage;
  classify: (
    intent: ReviewIntent,
    files: readonly PatchFile[],
    trace: JevTrace,
  ) => Promise<ClassifiedFile[]>;
  onPhase: (phase: Phase, groups: ReviewGroup[] | null) => Promise<void>;
  /** The accounted System One call; tests pass one that skips the database. */
  ask?: typeof askSystemOne;
  tracer: Tracer;
  /** The review's root span; every stage hangs from it. */
  root: Span;
}

export interface StagedOutput extends CallUsage {
  groups: ReviewGroup[];
  files: string[];
  classified: ClassifiedFile[];
  calls: CostCall[];
  toolCalls: number;
  reusedSteps: number;
  snapshot: Snapshot;
}

const NARRATIVE_CONCURRENCY = 6;

export async function generateStaged(input: StageInput): Promise<StagedOutput> {
  const files = splitPatch(input.patch);
  if (files.length === 0) throw new Error("the diff has no files");
  const paths = files.map((x) => x.path);
  let usage: CallUsage = NO_USAGE;
  let toolCalls = 0;
  const calls: CostCall[] = [];
  const count = <T>(stage: CostCall["stage"], a: AgentAnswer<T>): T => {
    const { result: _r, ...rest } = a;
    usage = addUsage(usage, rest);
    toolCalls += a.toolCalls;
    calls.push({ stage, ...rest });
    return a.result;
  };

  const tracer = input.tracer;
  const stage = <T>(name: string, fn: (span: Span) => Promise<T>, output?: (r: T) => Attrs) =>
    tracer.span(name, "CHAIN", input.root, {}, fn, output);
  const jev = (parent: Span): JevTrace => ({ tracer, parent });

  // 1. Snapshot and classification side by side; either failing fails the review.
  await input.onPhase("snapshot", null);
  const snapshotP = stage(
    "snapshot",
    () => input.loadSnapshot(),
    (s) => ({ [OI.outputValue]: s.sha }),
  );
  snapshotP.catch(() => {});
  const classifiedP = stage(
    "classify",
    (span) => input.classify(input.intent, files, jev(span)),
    (c) => ({ [OI.outputValue]: renderClassification(c) }),
  );
  await input.onPhase("classify", null);
  const classified = await classifiedP;
  const classification = renderClassification(classified);
  const skimPaths = new Set(
    classified.filter((c) => (c.signal.attention ?? 1) < 0.2).map((c) => c.path),
  );

  // 2. What survives from the previous review.
  const reused = input.previous
    ? await stage(
        "compare",
        (span) => keepUnchanged(input, files, input.previous!, jev(span)),
        (r) => ({
          [OI.outputValue]: r.map((g) => g.name).join(", ") || "(nothing kept)",
        }),
      )
    : [];
  const reusedPaths = new Set(reused.flatMap((g) => g.files));

  // 3. The skeleton: step names and intents, with the repository in reach.
  await input.onPhase("skeleton", null);
  const snapshot = await snapshotP;
  const agent = input.agent(snapshot);
  const skeleton = count(
    "skeleton",
    await stage("skeleton", (span) =>
      agent.skeleton(
        {
          intent: input.intent,
          files,
          classification,
          reusedSteps: reused,
          skimPaths,
          tools: true,
        },
        span,
      ),
    ),
  );
  const steps = withReusedSteps(skeleton.steps, reused);

  // 4. jev places every file that is not already in a kept step.
  await input.onPhase("assign", null);
  const toAssign = files.filter((x) => !reusedPaths.has(x.path));
  const assignments = await stage("assign", (span) => assignAll(input, steps, toAssign, jev(span)));
  let groups: ReviewGroup[] = groupsFromAssignments(steps, toAssign, assignments, classified);
  const keptNames = new Set<string>();
  for (const g of reused) {
    const hit = groups.find((x) => x.name === g.name);
    if (hit) {
      // New or changed files landed in a kept step: it is rewritten with all of them.
      hit.files = [...g.files, ...hit.files];
    } else {
      groups.push({ ...g, files: [...g.files] });
      keptNames.add(g.name);
    }
  }
  groups = orderLike(groups, steps);
  assertCoversAll(groups, paths);

  // 5. Narratives, in parallel, for every step that is not kept. The skeleton is visible now.
  await input.onPhase("narrate", groups);
  const byPath = new Map(files.map((x) => [x.path, x]));
  const lines = classification.split("\n");
  const allSteps = groups.map(
    (x) => steps.find((s) => s.name === x.name) ?? { name: x.name, intent: x.summary },
  );
  await stage("narrate", (narrateSpan) =>
    parallel(
      groups.filter((g) => !keptNames.has(g.name)),
      NARRATIVE_CONCURRENCY,
      async (g) => {
        const index = groups.indexOf(g);
        const out = count(
          "narrative",
          await agent.narrative(
            {
              intent: input.intent,
              step: allSteps[index]!,
              index,
              allSteps,
              files: g.files.map((p) => byPath.get(p)).filter((x): x is PatchFile => !!x),
              classification:
                lines.filter((l) => g.files.some((p) => l.includes(` ${p}:`))).join("\n") || null,
              tools: true,
            },
            narrateSpan,
          ),
        );
        g.summary = out.summary;
        g.impact = out.impact || undefined;
        g.findings = out.findings.length > 0 ? out.findings : undefined;
      },
    ),
  );

  return {
    groups,
    files: paths,
    classified,
    ...usage,
    calls,
    toolCalls,
    reusedSteps: keptNames.size,
    snapshot,
  };
}

/** The cell agent: the structured request travels; the cell builds the prompt and offers tools. */
export function cellAgent(
  cell: Cell,
  reviewId: string,
  repoId: string,
  provider: { kind: string; baseUrl: string; key: string },
  model: string,
  callbackUrl: string,
  snapshot: Snapshot,
  tracer: Tracer,
  fetchImpl: typeof fetch = fetch,
): AgentStage {
  const post = async <T>(
    stage: "skeleton" | "narrative",
    request: unknown,
    parent: Span,
  ): Promise<AgentAnswer<T>> => {
    const res = await fetchImpl(`${cell.url}/runs/${encodeURIComponent(reviewId)}/${stage}`, {
      method: "POST",
      headers: cellHeaders(cell),
      body: JSON.stringify({
        provider: { kind: provider.kind, baseUrl: provider.baseUrl, apiKey: provider.key },
        model,
        callback: { url: callbackUrl, token: cell.token },
        repo: repoId,
        snapshot,
        trace: tracer.enabled ? parent.context(tracer.endpoint!, tracer.project) : null,
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
      cacheReadTokens: data.cacheReadTokens ?? 0,
      cacheWriteTokens: data.cacheWriteTokens ?? 0,
      costUsd: data.costUsd ?? 0,
      priced: data.priced ?? false,
      toolCalls: data.toolCalls ?? 0,
    };
  };
  return {
    skeleton: (req, parent) =>
      post(
        "skeleton",
        {
          intent: req.intent,
          patch: req.files.map((f) => f.text).join(""),
          classification: req.classification,
          reusedSteps: req.reusedSteps,
          skimPaths: [...req.skimPaths],
        },
        parent,
      ),
    narrative: (req, parent) =>
      post(
        "narrative",
        {
          intent: req.intent,
          step: req.step,
          index: req.index,
          allSteps: req.allSteps,
          patch: req.files.map((f) => f.text).join(""),
          classification: req.classification,
        },
        parent,
      ),
  };
}

/** Steps from the previous review whose files carry the same hunks now, jev judging near-misses. */
async function keepUnchanged(
  input: StageInput,
  files: readonly PatchFile[],
  previous: { groups: ReviewGroup[]; patch: string },
  trace: JevTrace,
): Promise<ReviewGroup[]> {
  const before = splitPatch(previous.patch);
  const changed = changedFiles(before, files);
  const material = new Set<string>();
  if (changed.length > 0) {
    const result = await (input.ask ?? askSystemOne)(
      input.systemOne,
      {
        repoId: input.repoId,
        kind: "review_changes",
        state: buildChangeState(changed),
        questions: buildChangeQuestions(changed.length),
        items: changed.length,
      },
      trace,
    );
    const probs = foldChanges(result.answers as Parameters<typeof foldChanges>[0], changed.length);
    changed.forEach((c, i) => {
      if ((probs[i] ?? 1) >= MATERIAL) material.add(c.path);
    });
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
  trace: JevTrace,
): Promise<StepAssignment[]> {
  const batches: PatchFile[][] = [];
  for (let i = 0; i < files.length; i += FILES_PER_ASSIGN_REQUEST)
    batches.push(files.slice(i, i + FILES_PER_ASSIGN_REQUEST));
  const results = await Promise.all(
    batches.map(async (batch) => {
      const result = await (input.ask ?? askSystemOne)(
        input.systemOne,
        {
          repoId: input.repoId,
          kind: "review_assign",
          state: buildAssignState(input.intent, steps, batch),
          questions: buildAssignQuestions(batch.length, steps),
          items: batch.length,
        },
        trace,
      );
      return foldAssignments(result.answers as Parameters<typeof foldAssignments>[0], batch.length);
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

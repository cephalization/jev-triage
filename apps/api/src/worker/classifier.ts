import { NONE, QUESTIONS_VERSION } from "@triage/triage";
import {
  buildPullQuestions,
  buildPullState,
  buildQuestions,
  buildState,
  countQuestions,
  decide,
  decidePull,
  foldAnswers,
  foldPullAnswers,
  rankReviewers,
  type AnyAnswer,
  type DuplicateCandidate,
  type IssueForTriage,
  type LabeledExample,
  type PullForTriage,
  type RepoForTriage,
  type ReviewerStats,
  type SystemOne,
} from "@triage/triage";
import type { TransactionSql } from "postgres";
import { newId, sql } from "../db.ts";
import { env } from "../env.ts";
import { Scheduler, type JobResult, type SchedulerStats } from "./scheduler.ts";

/**
 * Classification worker: one Scheduler per repo, one TypeSafe request per batch.
 * Selection: issues flagged `reclassify`, or with no classification at the repo's
 * current questions_version; then open pull requests on the same rule. Every answer
 * is stored with that version; bumping it means new rows, never edits.
 */

const LABELED_EXAMPLES_MAX = 20;
const AREA_LABELS_MAX = 8;
const CANDIDATES_MAX = 5;
const COLLECT_MS = 300;
/** Pull state is heavier per item (files, candidates); keep requests well inside the model's window. */
const PULL_BATCH_MAX = 8;

interface RepoRow {
  id: string;
  owner: string;
  name: string;
  description: string | null;
  questions_version: number;
  batch_size: number;
  cadence_ms: number;
  budget_tokens: string | number;
  tokens_used: string | number;
  paused: boolean;
}

interface IssueRow {
  id: string;
  number: number;
  title: string;
  body: string;
  state: string;
  labels_json: string[];
  comments: number;
  reactions: number;
  created_at: Date;
  author_association: string;
}

interface PullRow {
  id: string;
  number: number;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  author: string;
  labels_json: string[];
  additions: number;
  deletions: number;
  changed_files: number;
  files_json: string[];
  base_ref: string;
  created_at: Date;
  requested_reviewers_json: string[];
  review_decision: string | null;
}

interface ReviewerRow {
  login: string;
  reviews: number;
  approvals: number;
  changes_requested: number;
  last_review_at: Date | null;
  median_response_hours: number | null;
  dirs_json: { dir: string; count: number }[];
  recent_titles_json: string[];
  open_load: number;
}

interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export class ClassifierWorker {
  readonly #schedulers = new Map<string, Scheduler>();
  readonly #systemOne: SystemOne | null;

  constructor(systemOne: SystemOne | null) {
    this.#systemOne = systemOne;
  }

  readonly #seed = new Map<string, { runs: number; dropped: number; coalesced: number }>();

  poke(repoId: string, reason: string): void {
    let s = this.#schedulers.get(repoId);
    if (!s) {
      s = new Scheduler(
        () => this.#runBatch(repoId),
        COLLECT_MS,
        (stats) => void this.#persistStats(repoId, stats),
      );
      const seed = this.#seed.get(repoId);
      if (seed) Object.assign(s.stats, seed);
      this.#schedulers.set(repoId, s);
    }
    console.log(`[worker] poke ${repoId} (${reason})`);
    s.poke();
  }

  async pokeAllWithPendingWork(): Promise<void> {
    await sql`update issue set classifying = false where classifying`;
    await sql`update pull set classifying = false where classifying`;
    // Counters survive restarts: seed in-memory stats from the last persisted values.
    const states = await sql<
      { repo_id: string; requests: number; dropped_triggers: number; coalesced_triggers: number }[]
    >`select repo_id, requests, dropped_triggers, coalesced_triggers from worker_state`;
    for (const w of states)
      this.#seed.set(w.repo_id, {
        runs: w.requests,
        dropped: w.dropped_triggers,
        coalesced: w.coalesced_triggers,
      });
    const repos = await sql<{ id: string }[]>`select id from repo where paused = false`;
    for (const r of repos) this.poke(r.id, "startup");
  }

  async #persistStats(repoId: string, stats: SchedulerStats): Promise<void> {
    try {
      await sql`
        insert into worker_state (repo_id, in_flight, dirty, dropped_triggers, coalesced_triggers, requests, updated_at)
        values (${repoId}, ${stats.inFlight}, ${stats.dirty}, ${stats.dropped}, ${stats.coalesced}, ${stats.runs}, now())
        on conflict (repo_id) do update set in_flight = excluded.in_flight, dirty = excluded.dirty,
          dropped_triggers = excluded.dropped_triggers, coalesced_triggers = excluded.coalesced_triggers,
          requests = excluded.requests, updated_at = now()`;
    } catch (e) {
      console.error("[worker] failed to persist stats", e);
    }
  }

  async #runBatch(repoId: string): Promise<JobResult> {
    const none: JobResult = { more: false, cadenceMs: 0 };
    const [repo] = await sql<RepoRow[]>`select * from repo where id = ${repoId}`;
    if (!repo) return none;
    if (repo.paused) return none;
    if (!this.#systemOne) {
      await this.#setError(repoId, "TYPESAFE_API_KEY is not set; classification disabled", 0);
      return none;
    }
    const budget = Number(repo.budget_tokens);
    const used = Number(repo.tokens_used);
    if (budget > 0 && used >= budget) {
      await this.#setError(
        repoId,
        `token budget reached (${used}/${budget}); raise the budget to continue`,
        0,
      );
      return none;
    }
    const version = Math.max(repo.questions_version, QUESTIONS_VERSION);
    if (repo.questions_version < version) {
      // The code's questions changed: bump the repo so every client reads rows at this version.
      await sql`update repo set questions_version = ${version} where id = ${repoId} and questions_version < ${version}`;
    }

    const issueFilter = sql`
      i.repo_id = ${repoId} and (i.reclassify or not exists (
        select 1 from classification c where c.issue_id = i.id and c.kind = 'category' and c.questions_version = ${version}))`;
    const pullFilter = sql`
      p.repo_id = ${repoId} and p.state = 'open' and (p.reclassify or not exists (
        select 1 from classification c where c.pull_id = p.id and c.kind = 'review_effort' and c.questions_version = ${version}))`;
    const [issueCount] = await sql<
      { count: string }[]
    >`select count(*)::text as count from issue i where ${issueFilter}`;
    const [pullCount] = await sql<
      { count: string }[]
    >`select count(*)::text as count from pull p where ${pullFilter}`;
    const pendingIssues = Number(issueCount?.count ?? "0");
    const pendingPulls = Number(pullCount?.count ?? "0");
    const pending = pendingIssues + pendingPulls;
    await sql`update worker_state set pending = ${pending}, last_error = null where repo_id = ${repoId}`;

    const repoInfo: RepoForTriage = {
      owner: repo.owner,
      name: repo.name,
      description: repo.description ?? "",
      areaLabels: await this.#areaLabels(repoId),
    };

    if (pendingIssues > 0) {
      const batch = await sql<IssueRow[]>`
        select i.id, i.number, i.title, i.body, i.state, i.labels_json, i.comments, i.reactions, i.created_at, i.author_association
        from issue i where ${issueFilter}
        order by i.reclassify desc, (i.state = 'open') desc, i.updated_at desc limit ${repo.batch_size}`;
      if (batch.length > 0) {
        const done = await this.#classifyIssues(repo, repoInfo, version, batch, pending);
        return done ? { more: pending > batch.length, cadenceMs: repo.cadence_ms } : none;
      }
    }
    if (pendingPulls > 0) {
      const batch = await sql<PullRow[]>`
        select p.id, p.number, p.title, p.body, p.state, p.draft, p.author, p.labels_json, p.additions, p.deletions,
          p.changed_files, p.files_json, p.base_ref, p.created_at, p.requested_reviewers_json, p.review_decision
        from pull p where ${pullFilter}
        order by p.reclassify desc, p.updated_at desc limit ${Math.min(repo.batch_size, PULL_BATCH_MAX)}`;
      if (batch.length > 0) {
        const done = await this.#classifyPulls(repo, repoInfo, version, batch, pending);
        return done ? { more: pending > batch.length, cadenceMs: repo.cadence_ms } : none;
      }
    }
    return none;
  }

  /** Returns true when the request succeeded (rows written); false after a recorded error. */
  async #classifyIssues(
    repo: RepoRow,
    repoInfo: RepoForTriage,
    version: number,
    batch: IssueRow[],
    pending: number,
  ): Promise<boolean> {
    const repoId = repo.id;
    const examples = await this.#labeledExamples(repoId);
    const issues: IssueForTriage[] = [];
    for (const row of batch) {
      issues.push({
        id: row.id,
        number: row.number,
        title: row.title,
        body: row.body,
        state: row.state,
        labels: row.labels_json,
        comments: row.comments,
        reactions: row.reactions,
        ageDays: (Date.now() - row.created_at.getTime()) / 86_400_000,
        authorAssociation: row.author_association,
        candidates: await this.#candidates(repoId, row),
      });
    }
    const state = buildState(repoInfo, examples, issues);
    const questions = buildQuestions(issues, repoInfo);
    const questionCount = countQuestions(questions);
    const batchIds = issues.map((i) => i.id);
    const runId = newId();
    await sql`insert into run (id, repo_id, kind, status, issues, questions) values (${runId}, ${repoId}, 'classify', 'running', ${issues.length}, ${questionCount})`;
    await sql`update issue set classifying = true where id in ${sql(batchIds)}`;
    const t0 = Date.now();
    try {
      const result = await this.#systemOne!.ask(state, questions);
      const ms = Date.now() - t0;
      this.#log(
        repoId,
        version,
        "issues",
        issues.length,
        questionCount,
        result.usage,
        ms,
        result.model,
      );
      const folded = foldAnswers(result.answers as Record<string, AnyAnswer>, issues.length);
      const rows = issues.flatMap((issue, idx) =>
        classificationRows(issue, folded[idx] ?? {}, version, result.model, runId, repoId),
      );
      await sql.begin(async (tx) => {
        await insertRows(tx, rows);
        await tx`update issue set reclassify = false, classifying = false where id in ${tx(batchIds)}`;
        await finishRun(tx, repoId, runId, result.usage, ms, result.model, pending - issues.length);
      });
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[worker] ${repoId} request failed: ${message}`);
      await sql`update run set finished_at = now(), status = 'error', error = ${message}, latency_ms = ${Date.now() - t0} where id = ${runId}`;
      await sql`update issue set classifying = false where id in ${sql(batchIds)}`;
      await this.#setError(repoId, message, pending);
      return false;
    }
  }

  async #classifyPulls(
    repo: RepoRow,
    repoInfo: RepoForTriage,
    version: number,
    batch: PullRow[],
    pending: number,
  ): Promise<boolean> {
    const repoId = repo.id;
    const reviewers = await this.#reviewers(repoId);
    const now = Date.now();
    const pulls: PullForTriage[] = batch.map((row) => {
      const files = Array.isArray(row.files_json) ? row.files_json : [];
      const requestedReviewers = Array.isArray(row.requested_reviewers_json)
        ? row.requested_reviewers_json
        : [];
      return {
        id: row.id,
        number: row.number,
        title: row.title,
        body: row.body,
        state: row.state,
        draft: row.draft,
        author: row.author,
        labels: Array.isArray(row.labels_json) ? row.labels_json : [],
        additions: row.additions,
        deletions: row.deletions,
        changedFiles: row.changed_files,
        files,
        baseRef: row.base_ref,
        ageDays: (now - row.created_at.getTime()) / 86_400_000,
        requestedReviewers,
        reviewDecision: row.review_decision,
        candidates: rankReviewers(
          { author: row.author, files, requestedReviewers },
          reviewers,
          now,
        ),
      };
    });
    const state = buildPullState(repoInfo, pulls);
    const questions = buildPullQuestions(pulls, repoInfo);
    const questionCount = countQuestions(questions);
    const batchIds = pulls.map((p) => p.id);
    const runId = newId();
    await sql`insert into run (id, repo_id, kind, status, issues, questions) values (${runId}, ${repoId}, 'classify_pulls', 'running', ${pulls.length}, ${questionCount})`;
    await sql`update pull set classifying = true where id in ${sql(batchIds)}`;
    const t0 = Date.now();
    try {
      const result = await this.#systemOne!.ask(state, questions);
      const ms = Date.now() - t0;
      this.#log(
        repoId,
        version,
        "pulls",
        pulls.length,
        questionCount,
        result.usage,
        ms,
        result.model,
      );
      const folded = foldPullAnswers(
        result.answers as Parameters<typeof foldPullAnswers>[0],
        pulls.length,
      );
      const rows = pulls.flatMap((pull, idx) =>
        pullClassificationRows(pull, folded[idx] ?? {}, version, result.model, runId, repoId),
      );
      await sql.begin(async (tx) => {
        await insertRows(tx, rows);
        await tx`update pull set reclassify = false, classifying = false where id in ${tx(batchIds)}`;
        await finishRun(tx, repoId, runId, result.usage, ms, result.model, pending - pulls.length);
      });
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[worker] ${repoId} pull request failed: ${message}`);
      await sql`update run set finished_at = now(), status = 'error', error = ${message}, latency_ms = ${Date.now() - t0} where id = ${runId}`;
      await sql`update pull set classifying = false where id in ${sql(batchIds)}`;
      await this.#setError(repoId, message, pending);
      return false;
    }
  }

  #log(
    repoId: string,
    version: number,
    what: string,
    n: number,
    questions: number,
    usage: Usage,
    ms: number,
    model: string,
  ) {
    const cost = this.#cost(usage.input_tokens, usage.output_tokens);
    console.log(
      `[worker] ${repoId} v${version}: ${n} ${what}, ${questions} questions, ${usage.input_tokens} in / ${usage.output_tokens} out tokens, ${ms} ms, model ${model}${cost === null ? "" : `, $${cost.toFixed(4)}`}`,
    );
  }

  #cost(input: number, output: number): number | null {
    if (env.priceInputPerMTok === null || env.priceOutputPerMTok === null) return null;
    return (input * env.priceInputPerMTok + output * env.priceOutputPerMTok) / 1_000_000;
  }

  async #setError(repoId: string, message: string, pending: number): Promise<void> {
    await sql`insert into worker_state (repo_id, last_error, pending) values (${repoId}, ${message}, ${pending})
      on conflict (repo_id) do update set last_error = excluded.last_error, pending = excluded.pending, updated_at = now()`;
  }

  async #areaLabels(repoId: string): Promise<string[]> {
    const rows = await sql<{ name: string }[]>`
      select l.name from issue_label il join label l on l.id = il.label_id
      where l.repo_id = ${repoId}
      group by l.name order by count(*) desc, l.name asc limit ${AREA_LABELS_MAX}`;
    return rows.map((r) => r.name);
  }

  async #reviewers(repoId: string): Promise<ReviewerStats[]> {
    const rows = await sql<ReviewerRow[]>`select * from reviewer where repo_id = ${repoId}`;
    return rows.map((r) => ({
      login: r.login,
      reviews: r.reviews,
      approvals: r.approvals,
      changesRequested: r.changes_requested,
      lastReviewAt: r.last_review_at ? r.last_review_at.getTime() : null,
      medianResponseHours: r.median_response_hours,
      dirs: Array.isArray(r.dirs_json) ? r.dirs_json : [],
      recentTitles: Array.isArray(r.recent_titles_json) ? r.recent_titles_json : [],
      openLoad: r.open_load,
    }));
  }

  async #labeledExamples(repoId: string): Promise<LabeledExample[]> {
    const rows = await sql<
      {
        number: number;
        title: string;
        body: string;
        category: string;
        area: string | null;
        action: string | null;
      }[]
    >`
      select distinct on (f.issue_id) i.number, i.title, i.body, f.value as category,
        (select a.value from feedback a where a.issue_id = f.issue_id and a.kind = 'area' order by a.created_at desc limit 1) as area,
        (select x.value from feedback x where x.issue_id = f.issue_id and x.kind = 'action' order by x.created_at desc limit 1) as action
      from feedback f join issue i on i.id = f.issue_id
      where f.repo_id = ${repoId} and f.kind = 'category'
      order by f.issue_id, f.created_at desc`;
    return rows
      .sort((a, b) => b.number - a.number)
      .slice(0, LABELED_EXAMPLES_MAX)
      .map((r) => ({
        number: r.number,
        title: r.title,
        excerpt: r.body.slice(0, 300),
        category: r.category,
        ...(r.area && r.area !== NONE ? { area: r.area } : {}),
        ...(r.action ? { action: r.action } : {}),
      }));
  }

  async #candidates(repoId: string, issue: IssueRow): Promise<DuplicateCandidate[]> {
    const rows = await sql<{ id: string; number: number; title: string }[]>`
      select id, number, title from issue
      where repo_id = ${repoId} and id <> ${issue.id} and similarity(title, ${issue.title}) > 0.3
      order by similarity(title, ${issue.title}) desc, number desc limit ${CANDIDATES_MAX}`;
    return rows;
  }
}

type Tx = TransactionSql<Record<string, never>>;

async function insertRows(tx: Tx, rows: ClassificationInsert[]) {
  if (rows.length === 0) return;
  await tx`insert into classification ${tx(
    rows,
    "id",
    "issue_id",
    "pull_id",
    "repo_id",
    "questions_version",
    "kind",
    "value",
    "confidence",
    "probabilities_json",
    "model",
    "run_id",
  )}`;
}

async function finishRun(
  tx: Tx,
  repoId: string,
  runId: string,
  usage: Usage,
  ms: number,
  model: string,
  pendingAfter: number,
) {
  await tx`update repo set tokens_used = tokens_used + ${usage.input_tokens + usage.output_tokens},
    input_tokens_used = input_tokens_used + ${usage.input_tokens},
    output_tokens_used = output_tokens_used + ${usage.output_tokens} where id = ${repoId}`;
  await tx`update run set finished_at = now(), status = 'ok', input_tokens = ${usage.input_tokens},
    output_tokens = ${usage.output_tokens}, latency_ms = ${ms}, model = ${model} where id = ${runId}`;
  await tx`update worker_state set pending = ${Math.max(0, pendingAfter)} where repo_id = ${repoId}`;
}

interface ClassificationInsert {
  id: string;
  issue_id: string | null;
  pull_id: string | null;
  repo_id: string;
  questions_version: number;
  kind: string;
  value: string;
  confidence: number | null;
  probabilities_json: ReturnType<typeof sql.json>;
  model: string;
  run_id: string;
}

export function classificationRows(
  issue: IssueForTriage,
  answers: ReturnType<typeof foldAnswers>[number],
  version: number,
  model: string,
  runId: string,
  repoId: string,
): ClassificationInsert[] {
  const d = decide(answers, issue.candidates);
  const base = {
    issue_id: issue.id,
    pull_id: null,
    repo_id: repoId,
    questions_version: version,
    model,
    run_id: runId,
  };
  const out: ClassificationInsert[] = [];
  const push = (
    kind: string,
    value: string,
    confidence: number | null,
    probabilities: Record<string, number>,
  ) =>
    out.push({
      id: newId(),
      ...base,
      kind,
      value,
      confidence,
      probabilities_json: sql.json(probabilities),
    });

  if (answers.category)
    push(
      "category",
      answers.category.choice,
      answers.category.confidence,
      answers.category.probabilities,
    );
  if (answers.area)
    push("area", answers.area.choice, answers.area.confidence, answers.area.probabilities);
  if (answers.severity && d.severity !== null)
    push(
      "severity",
      d.severity.toFixed(4),
      answers.severity.confidence,
      answers.severity.probabilities,
    );
  if (answers.urgency && d.urgency !== null)
    push(
      "urgency",
      d.urgency.toFixed(4),
      answers.urgency.confidence,
      answers.urgency.probabilities,
    );
  if (answers.action)
    push("action", answers.action.choice, answers.action.confidence, answers.action.probabilities);
  if (answers.missing)
    push(
      "missing",
      answers.missing.choice,
      answers.missing.confidence,
      answers.missing.probabilities,
    );
  if (answers.duplicate) {
    const probs: Record<string, number> = {};
    for (const [k, v] of Object.entries(answers.duplicate.probabilities)) {
      const m = /^candidate_(\d+)$/.exec(k);
      const c = m ? issue.candidates[Number(m[1])] : undefined;
      probs[c ? `#${c.number}` : k] = v;
    }
    push("duplicate", d.duplicate.of?.id ?? NONE, answers.duplicate.confidence, probs);
  }
  return out;
}

export function pullClassificationRows(
  pull: PullForTriage,
  answers: ReturnType<typeof foldPullAnswers>[number],
  version: number,
  model: string,
  runId: string,
  repoId: string,
): ClassificationInsert[] {
  const d = decidePull(answers, pull.candidates);
  const base = {
    issue_id: null,
    pull_id: pull.id,
    repo_id: repoId,
    questions_version: version,
    model,
    run_id: runId,
  };
  const out: ClassificationInsert[] = [];
  if (answers.review_effort && d.effort !== null) {
    out.push({
      id: newId(),
      ...base,
      kind: "review_effort",
      value: d.effort.toFixed(4),
      confidence: answers.review_effort.confidence,
      probabilities_json: sql.json(answers.review_effort.probabilities),
    });
  }
  if (answers.reviewer) {
    out.push({
      id: newId(),
      ...base,
      kind: "reviewer",
      value: d.reviewer.candidate?.login ?? NONE,
      confidence: answers.reviewer.confidence,
      probabilities_json: sql.json(d.reviewerProbabilities),
    });
  }
  return out;
}

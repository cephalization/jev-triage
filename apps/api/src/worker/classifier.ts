import {
  calibrateCharsPerToken,
  cut,
  itemCosts,
  NONE,
  packPrefix,
  QUESTIONS_VERSION,
} from "@triage/triage";
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
import { isRequestRejected } from "./typesafe.ts";
import type { EntryType, Questions } from "@typesafe-ai/sdk";

/**
 * Classification worker: one Scheduler per repo, one TypeSafe request per batch, several
 * batches in flight. Selection: issues flagged `reclassify`, or with no classification at the
 * repo's current questions_version; then open pull requests on the same rule. A batch is
 * claimed by setting `classifying` in the same statement that selects it, so concurrent
 * requests never share an item. Every answer is stored with that version; bumping it means
 * new rows, never edits.
 *
 * The pipeline is tuned for speed, not thrift (jev is cheap): no cadence between batches and
 * as many requests in flight as the model comfortably takes. Recalibrate here if a rate limit
 * shows up.
 */

const LABELED_EXAMPLES_MAX = 20;
const AREA_LABELS_MAX = 8;
const CANDIDATES_MAX = 5;
/** How long a poke waits for neighbours before a run starts; pages of a sync land close together. */
const COLLECT_MS = 50;
/**
 * Requests are right-sized, not text: bodies go whole, and a batch takes as many items as fit
 * a token budget measured on the serialized request. jev's window is 64K tokens per request
 * and 32K for the state plus one question (docs.typesafe.ai/models), and its accuracy falls as
 * unrelated state grows, so the target sits well under both. Characters become tokens through
 * a ratio calibrated from the usage every response reports.
 */
const REQUEST_TOKEN_TARGET = 28_000;
/** An item too large to fit a request on its own has its body cut to this many tokens. */
const ITEM_TOKEN_HARD = 24_000;
/** Ceilings on items per request; the budget usually binds first. */
const ISSUES_PER_REQUEST_MAX = 20;
const PULLS_PER_REQUEST_MAX = 8;
/** Rows claimed per run, before packing; the ones that do not fit are released at once. */
const ISSUE_CLAIM = 40;
const PULL_CLAIM = 16;
/** Concurrent TypeSafe requests per repository. Smaller, right-sized batches mean more of them. */
const MAX_IN_FLIGHT = 6;

interface RepoRow {
  id: string;
  owner: string;
  name: string;
  description: string | null;
  questions_version: number;
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

/** What one request needs beyond its items; issues and pulls differ only here. */
interface RequestShape<T extends { id: string; body: string }> {
  what: "issues" | "pulls";
  table: "issue" | "pull";
  runKind: "classify" | "classify_pulls";
  build: (items: readonly T[]) => { state: EntryType; questions: Questions };
  toRows: (
    items: readonly T[],
    answers: Record<string, AnyAnswer>,
    model: string,
    runId: string,
  ) => ClassificationInsert[];
}

export class ClassifierWorker {
  readonly #schedulers = new Map<string, Scheduler>();
  readonly #systemOne: SystemOne | null;
  /** Serialized characters per input token, calibrated from every response; starts at a guess. */
  #charsPerToken = 4;
  /** Items the model refused even alone and cut; skipped until restart rather than retried forever. */
  readonly #poison = new Set<string>();

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
        MAX_IN_FLIGHT,
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
        values (${repoId}, ${stats.inFlight > 0}, ${stats.dirty}, ${stats.dropped}, ${stats.coalesced}, ${stats.runs}, now())
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
    const version = Math.max(repo.questions_version, QUESTIONS_VERSION);
    if (repo.questions_version < version) {
      // The code's questions changed: bump the repo so every client reads rows at this version.
      await sql`update repo set questions_version = ${version} where id = ${repoId} and questions_version < ${version}`;
    }

    const poison = [...this.#poison];
    const notPoisonIssue = poison.length ? sql`and i.id <> all(${sql.array(poison)})` : sql``;
    const notPoisonPull = poison.length ? sql`and p.id <> all(${sql.array(poison)})` : sql``;
    const issueFilter = sql`
      i.repo_id = ${repoId} and not i.classifying ${notPoisonIssue} and (i.reclassify or not exists (
        select 1 from classification c where c.issue_id = i.id and c.kind = 'category' and c.questions_version = ${version}))`;
    const pullFilter = sql`
      p.repo_id = ${repoId} and p.state = 'open' and not p.classifying ${notPoisonPull} and (p.reclassify or not exists (
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

    // Claim and select in one statement: concurrent runs skip each other's rows.
    if (pendingIssues > 0) {
      const batch = await sql<IssueRow[]>`
        update issue set classifying = true where id in (
          select i.id from issue i where ${issueFilter}
          order by i.reclassify desc, (i.state = 'open') desc, i.updated_at desc
          limit ${ISSUE_CLAIM} for update skip locked)
        returning id, number, title, body, state, labels_json, comments, reactions, created_at, author_association`;
      if (batch.length > 0) {
        const done = await this.#classifyIssues(repo, repoInfo, version, batch, pending);
        return done ? { more: pending > batch.length, cadenceMs: 0 } : none;
      }
    }
    if (pendingPulls > 0) {
      const batch = await sql<PullRow[]>`
        update pull set classifying = true where id in (
          select p.id from pull p where ${pullFilter}
          order by p.reclassify desc, p.updated_at desc limit ${PULL_CLAIM} for update skip locked)
        returning id, number, title, body, state, draft, author, labels_json, additions, deletions,
          changed_files, files_json, base_ref, created_at, requested_reviewers_json, review_decision`;
      if (batch.length > 0) {
        const done = await this.#classifyPulls(repo, repoInfo, version, batch, pending);
        return done ? { more: pending > batch.length, cadenceMs: 0 } : none;
      }
    }
    return none;
  }

  /** Returns true when the request succeeded (rows written); false after a recorded error. */
  /** Builds, packs and sends a batch of claimed issues; rows that do not fit are released. */
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
    const shape: RequestShape<IssueForTriage> = {
      what: "issues",
      table: "issue",
      runKind: "classify",
      build: (items) => ({
        state: buildState(repoInfo, examples, items),
        questions: buildQuestions(items, repoInfo),
      }),
      toRows: (items, answers, model, runId) => {
        const folded = foldAnswers(answers, items.length);
        return items.flatMap((issue, idx) =>
          classificationRows(issue, folded[idx] ?? {}, version, model, runId, repoId),
        );
      },
    };
    const kept = await this.#pack(shape, issues, ISSUES_PER_REQUEST_MAX);
    return this.#request(repo, version, shape, kept, pending);
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
    const shape: RequestShape<PullForTriage> = {
      what: "pulls",
      table: "pull",
      runKind: "classify_pulls",
      build: (items) => ({
        state: buildPullState(repoInfo, items),
        questions: buildPullQuestions(items, repoInfo),
      }),
      toRows: (items, answers, model, runId) => {
        const folded = foldPullAnswers(
          answers as Parameters<typeof foldPullAnswers>[0],
          items.length,
        );
        return items.flatMap((pull, idx) =>
          pullClassificationRows(pull, folded[idx] ?? {}, version, model, runId, repoId),
        );
      },
    };
    const kept = await this.#pack(shape, pulls, PULLS_PER_REQUEST_MAX);
    return this.#request(repo, version, shape, kept, pending);
  }

  /** Serialized size of a request, the unit the token budget is measured in. */
  #measure<T extends { id: string; body: string }>(shape: RequestShape<T>, items: readonly T[]) {
    const { state, questions } = shape.build(items);
    return JSON.stringify(state).length + JSON.stringify(questions).length;
  }

  /** The leading items that fit the budget; the rest are released for another run to claim. */
  async #pack<T extends { id: string; body: string }>(
    shape: RequestShape<T>,
    items: T[],
    maxItems: number,
  ): Promise<T[]> {
    const { base, costs } = itemCosts(items, (subset) => this.#measure(shape, subset));
    const keep = packPrefix(costs, base, REQUEST_TOKEN_TARGET * this.#charsPerToken, maxItems);
    const rest = items.slice(keep).map((i) => i.id);
    if (rest.length > 0)
      await sql`update ${sql(shape.table)} set classifying = false where id in ${sql(rest)}`;
    return items.slice(0, keep);
  }

  /**
   * One request for `items`, already claimed. Returns true when its rows were written. A
   * request the API refuses for size is split in half and each half sent again; a single item
   * refused on its own has its body cut once, and if that still fails it is set aside.
   */
  async #request<T extends { id: string; body: string }>(
    repo: RepoRow,
    version: number,
    shape: RequestShape<T>,
    items: T[],
    pending: number,
    cutOnce = false,
  ): Promise<boolean> {
    if (items.length === 0) return true;
    const repoId = repo.id;
    const ids = items.map((i) => i.id);
    const { state, questions } = shape.build(items);
    const questionCount = countQuestions(questions);
    const runId = newId();
    await sql`insert into run (id, repo_id, kind, status, issues, questions) values (${runId}, ${repoId}, ${shape.runKind}, 'running', ${items.length}, ${questionCount})`;
    const t0 = Date.now();
    try {
      const result = await this.#systemOne!.ask(state, questions);
      const ms = Date.now() - t0;
      this.#charsPerToken = calibrateCharsPerToken(
        this.#charsPerToken,
        this.#measure(shape, items),
        result.usage.input_tokens,
      );
      this.#log(
        repoId,
        version,
        shape.what,
        items.length,
        questionCount,
        result.usage,
        ms,
        result.model,
      );
      const rows = shape.toRows(
        items,
        result.answers as Record<string, AnyAnswer>,
        result.model,
        runId,
      );
      await sql.begin(async (tx) => {
        await insertRows(tx, rows);
        await tx`update ${tx(shape.table)} set reclassify = false, classifying = false where id in ${tx(ids)}`;
        await finishRun(tx, repoId, runId, result.usage, ms, result.model, pending - items.length);
      });
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await sql`update run set finished_at = now(), status = 'error', error = ${message}, latency_ms = ${Date.now() - t0} where id = ${runId}`;
      if (isRequestRejected(e)) {
        if (items.length > 1) {
          const mid = Math.ceil(items.length / 2);
          console.warn(
            `[worker] ${repoId}: request for ${items.length} ${shape.what} refused (${message}); sending it as two`,
          );
          const first = await this.#request(repo, version, shape, items.slice(0, mid), pending);
          const second = await this.#request(repo, version, shape, items.slice(mid), pending);
          return first && second;
        }
        const only = items[0]!;
        if (!cutOnce) {
          const max = Math.floor(ITEM_TOKEN_HARD * this.#charsPerToken);
          console.warn(
            `[worker] ${repoId}: ${shape.what.slice(0, -1)} ${only.id} refused alone (${message}); cutting its body to ${max} characters`,
          );
          return this.#request(
            repo,
            version,
            shape,
            [{ ...only, body: cut(only.body, max) }],
            pending,
            true,
          );
        }
        this.#poison.add(only.id);
        console.error(
          `[worker] ${repoId}: ${shape.what.slice(0, -1)} ${only.id} refused even cut; set aside until restart`,
        );
      } else {
        console.error(`[worker] ${repoId} request failed: ${message}`);
      }
      await sql`update ${sql(shape.table)} set classifying = false where id in ${sql(ids)}`;
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
      `[worker] ${repoId} v${version}: ${n} ${what}, ${questions} questions, ${usage.input_tokens} in / ${usage.output_tokens} out tokens, ${ms} ms, model ${model}${cost === null ? "" : `, $${cost.toFixed(4)}`}, ~${this.#charsPerToken.toFixed(1)} chars/token`,
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
        excerpt: cut(r.body, 300),
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

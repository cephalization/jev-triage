import {
  boolean,
  createBuilder,
  createSchema,
  json,
  number,
  relationships,
  string,
  table,
} from "@rocicorp/zero";

/** Shape of `ctx` in queries and mutators. Derived from the verified JWT on the server. */
export type ZeroContext = {
  userID: string;
  name: string;
  color: string;
  /** GitHub login, as GitHub spells it. */
  login: string;
  role: Role;
  avatarUrl: string | null;
};

export const ROLES = ["member", "admin"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Families asked about issues (questions v2). `action` is the maintainer's next step and
 * `missing` what a reply should ask for; both are choices. Older rows of retired kinds
 * (needs_info, actionable) stay in the table as history and are simply not read.
 */
export const CLASSIFICATION_KINDS = [
  "category",
  "area",
  "severity",
  "urgency",
  "duplicate",
  "action",
  "missing",
] as const;
export type ClassificationKind = (typeof CLASSIFICATION_KINDS)[number];

/** Families asked about pull requests; stored in the same classification/feedback tables. */
export const PULL_KINDS = ["review_effort", "reviewer"] as const;
export type PullKind = (typeof PULL_KINDS)[number];

export const CATEGORIES = ["bug", "feature", "question", "docs", "chore", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Model providers an admin can configure for guided reviews; keys live server-side only. */
export const PROVIDER_KINDS = ["anthropic", "openai", "openrouter", "openai-compatible"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];
export type ProviderModel = { id: string; label: string; enabled: boolean };

/** Triage queue state of an issue. `done` leaves the queue; claiming names who is on it. */
export const TRIAGE_STATUSES = ["open", "done"] as const;
export type TriageStatus = (typeof TRIAGE_STATUSES)[number];

const user = table("user")
  .columns({
    id: string(),
    name: string(),
    color: string(),
    login: string().optional(),
    github_id: number().optional(),
    avatar_url: string().optional(),
    role: string(),
    last_login_at: number().optional(),
    revoked_at: number().optional(),
    created_at: number(),
  })
  .primaryKey("id");

/** Allowlist: a GitHub login that may sign in, and the role it gets. Lowercased. */
const invite = table("invite")
  .columns({
    login: string(),
    role: string(),
    invited_by: string().optional(),
    note: string().optional(),
    created_at: number(),
    accepted_at: number().optional(),
    accepted_by: string().optional(),
  })
  .primaryKey("login");

const repo = table("repo")
  .columns({
    id: string(),
    owner: string(),
    name: string(),
    description: string().optional(),
    default_branch: string(),
    open_issues: number(),
    last_synced_at: number().optional(),
    sync_cursor: string().optional(),
    sync_status: string(),
    sync_error: string().optional(),
    sync_phase: string(),
    sync_fetched: number(),
    sync_pages: number(),
    sync_rate_remaining: number().optional(),
    sync_started_at: number().optional(),
    sync_message: string().optional(),
    sync_limit: number(),
    history_complete: boolean(),
    history_cursor: string().optional(),
    pull_limit: number(),
    pull_history_limit: number(),
    pull_synced_at: number().optional(),
    questions_version: number(),
    batch_size: number(),
    cadence_ms: number(),
    budget_tokens: number(),
    tokens_used: number(),
    input_tokens_used: number(),
    output_tokens_used: number(),
    paused: boolean(),
    review_provider_id: string().optional(),
    review_model: string().optional(),
    review_budget_tokens: number(),
    created_at: number(),
  })
  .primaryKey("id");

/** Replicated half of a provider: everything but the key, which stays in a private schema. */
const provider = table("provider")
  .columns({
    id: string(),
    kind: string(),
    label: string(),
    base_url: string(),
    key_hint: string().optional(),
    /** Who set the key; the owner every cost row is charged to. */
    key_set_by: string().optional(),
    models_json: json<ProviderModel[]>(),
    created_by: string().optional(),
    created_at: number(),
    updated_at: number(),
  })
  .primaryKey("id");

const label = table("label")
  .columns({
    id: string(),
    repo_id: string(),
    name: string(),
    color: string(),
    description: string().optional(),
  })
  .primaryKey("id");

const issue = table("issue")
  .columns({
    id: string(),
    repo_id: string(),
    number: number(),
    title: string(),
    body: string(),
    state: string(),
    author: string(),
    author_association: string(),
    labels_json: json<string[]>(),
    comments: number(),
    reactions: number(),
    created_at: number(),
    updated_at: number(),
    closed_at: number().optional(),
    url: string(),
    reclassify: boolean(),
    classifying: boolean(),
  })
  .primaryKey("id");

const issueLabel = table("issue_label")
  .columns({
    issue_id: string(),
    label_id: string(),
  })
  .primaryKey("issue_id", "label_id");

/** One row per issue once anyone claims it or marks it done; absent means open and unclaimed. */
const triage = table("triage")
  .columns({
    issue_id: string(),
    repo_id: string(),
    status: string(),
    claimed_by: string().optional(),
    claimed_at: number().optional(),
    done_by: string().optional(),
    done_at: number().optional(),
    updated_at: number(),
  })
  .primaryKey("issue_id");

const pull = table("pull")
  .columns({
    id: string(),
    repo_id: string(),
    number: number(),
    title: string(),
    body: string(),
    state: string(),
    draft: boolean(),
    author: string(),
    author_association: string(),
    head_ref: string(),
    head_sha: string().optional(),
    base_ref: string(),
    additions: number(),
    deletions: number(),
    changed_files: number(),
    files_json: json<string[]>(),
    labels_json: json<string[]>(),
    requested_reviewers_json: json<string[]>(),
    review_decision: string().optional(),
    mergeable: string().optional(),
    comments: number(),
    created_at: number(),
    updated_at: number(),
    closed_at: number().optional(),
    merged_at: number().optional(),
    merged_by: string().optional(),
    url: string(),
    reclassify: boolean(),
    classifying: boolean(),
  })
  .primaryKey("id");

export type ReviewAnnotationJson = {
  path: string;
  /** `new` numbers for added and unchanged lines, `old` for removed; line 0 is the whole file. */
  side: "old" | "new";
  line: number;
  kind: "bug" | "question" | "consideration" | "nit";
  text: string;
};

export type ReviewGroupJson = {
  name: string;
  summary: string;
  files: string[];
  annotations?: ReviewAnnotationJson[];
  /** Older reviews were written with these instead of annotations; rows are history. */
  impact?: string;
  findings?: { severity: "blocker" | "concern" | "note"; text: string }[];
};

/** One generated walkthrough of a pull request; the patch it used stays server-side. */
const guidedReview = table("guided_review")
  .columns({
    id: string(),
    pull_id: string(),
    repo_id: string(),
    head_sha: string().optional(),
    status: string(),
    provider_id: string().optional(),
    model: string(),
    groups_json: json<ReviewGroupJson[]>(),
    file_count: number(),
    error: string().optional(),
    input_tokens: number(),
    output_tokens: number(),
    created_by: string().optional(),
    created_at: number(),
    started_at: number().optional(),
    finished_at: number().optional(),
    /** 'agent' for model-written steps, 'seed' when the file classification stood in. */
    source: string(),
    /** While running: snapshot | classify | skeleton | assign | narrate. */
    phase: string().optional(),
    tool_calls: number(),
    reused_steps: number(),
    /** Provider spend for this generation, from pi's catalog; priced=false means unknown. */
    cost_usd: number(),
    priced: boolean(),
  })
  .primaryKey("id");

/** One agent call at the provider: tokens, money, and who is charged. */
const llmCost = table("llm_cost")
  .columns({
    id: string(),
    repo_id: string(),
    review_id: string().optional(),
    provider_id: string().optional(),
    provider_kind: string(),
    model: string(),
    key_owner: string().optional(),
    requested_by: string().optional(),
    stage: string(),
    input_tokens: number(),
    output_tokens: number(),
    cache_read_tokens: number(),
    cache_write_tokens: number(),
    cost_usd: number(),
    priced: boolean(),
    created_at: number(),
  })
  .primaryKey("id");

/** jev's answers about one changed file of one review; the reason a file sits where it does. */
const guidedReviewFile = table("guided_review_file")
  .columns({
    review_id: string(),
    path: string(),
    status: string(),
    added: number(),
    removed: number(),
    role: string(),
    role_confidence: number().optional(),
    risk: number().optional(),
    attention: number().optional(),
    entry: number().optional(),
    probabilities_json: json<Record<string, Record<string, number>>>(),
    questions_version: number(),
  })
  .primaryKey("review_id", "path");

/** One person's mark on one step of a pull request's review. */
const reviewProgress = table("review_progress")
  .columns({
    pull_id: string(),
    user_id: string(),
    step_name: string(),
    review_id: string().optional(),
    reviewed_at: number(),
  })
  .primaryKey("pull_id", "user_id", "step_name");

const pullReview = table("pull_review")
  .columns({
    id: string(),
    pull_id: string(),
    repo_id: string(),
    reviewer: string(),
    state: string(),
    submitted_at: number(),
  })
  .primaryKey("id");

export type ReviewerDir = { dir: string; count: number };

const reviewer = table("reviewer")
  .columns({
    repo_id: string(),
    login: string(),
    reviews: number(),
    approvals: number(),
    changes_requested: number(),
    last_review_at: number().optional(),
    median_response_hours: number().optional(),
    dirs_json: json<ReviewerDir[]>(),
    recent_titles_json: json<string[]>(),
    open_load: number(),
  })
  .primaryKey("repo_id", "login");

const run = table("run")
  .columns({
    id: string(),
    repo_id: string(),
    kind: string(),
    started_at: number(),
    finished_at: number().optional(),
    issues: number(),
    questions: number(),
    input_tokens: number(),
    output_tokens: number(),
    latency_ms: number(),
    model: string().optional(),
    status: string(),
    error: string().optional(),
  })
  .primaryKey("id");

const classification = table("classification")
  .columns({
    id: string(),
    issue_id: string().optional(),
    pull_id: string().optional(),
    repo_id: string(),
    questions_version: number(),
    kind: string(),
    value: string(),
    confidence: number().optional(),
    probabilities_json: json<Record<string, number>>(),
    model: string(),
    run_id: string().optional(),
    created_at: number(),
  })
  .primaryKey("id");

const feedback = table("feedback")
  .columns({
    id: string(),
    issue_id: string().optional(),
    pull_id: string().optional(),
    repo_id: string(),
    user_id: string(),
    kind: string(),
    value: string(),
    note: string().optional(),
    created_at: number(),
  })
  .primaryKey("id");

/** One row per browser tab (client_id lives in sessionStorage); group by user_id in the UI. */
const presence = table("presence")
  .columns({
    client_id: string(),
    user_id: string(),
    name: string(),
    color: string(),
    repo_id: string().optional(),
    issue_id: string().optional(),
    updated_at: number(),
  })
  .primaryKey("client_id");

const workerState = table("worker_state")
  .columns({
    repo_id: string(),
    in_flight: boolean(),
    dirty: boolean(),
    pending: number(),
    dropped_triggers: number(),
    coalesced_triggers: number(),
    requests: number(),
    last_error: string().optional(),
    updated_at: number(),
  })
  .primaryKey("repo_id");

const repoRelationships = relationships(repo, ({ many, one }) => ({
  issues: many({ sourceField: ["id"], destSchema: issue, destField: ["repo_id"] }),
  pulls: many({ sourceField: ["id"], destSchema: pull, destField: ["repo_id"] }),
  reviewers: many({ sourceField: ["id"], destSchema: reviewer, destField: ["repo_id"] }),
  labels: many({ sourceField: ["id"], destSchema: label, destField: ["repo_id"] }),
  runs: many({ sourceField: ["id"], destSchema: run, destField: ["repo_id"] }),
  workerState: one({ sourceField: ["id"], destSchema: workerState, destField: ["repo_id"] }),
}));

const issueRelationships = relationships(issue, ({ many, one }) => ({
  repo: one({ sourceField: ["repo_id"], destSchema: repo, destField: ["id"] }),
  classifications: many({
    sourceField: ["id"],
    destSchema: classification,
    destField: ["issue_id"],
  }),
  feedback: many({ sourceField: ["id"], destSchema: feedback, destField: ["issue_id"] }),
  presence: many({ sourceField: ["id"], destSchema: presence, destField: ["issue_id"] }),
  triage: one({ sourceField: ["id"], destSchema: triage, destField: ["issue_id"] }),
  labels: many(
    { sourceField: ["id"], destSchema: issueLabel, destField: ["issue_id"] },
    { sourceField: ["label_id"], destSchema: label, destField: ["id"] },
  ),
}));

const inviteRelationships = relationships(invite, ({ one }) => ({
  inviter: one({ sourceField: ["invited_by"], destSchema: user, destField: ["id"] }),
}));

const triageRelationships = relationships(triage, ({ one }) => ({
  issue: one({ sourceField: ["issue_id"], destSchema: issue, destField: ["id"] }),
  claimer: one({ sourceField: ["claimed_by"], destSchema: user, destField: ["id"] }),
}));

const pullRelationships = relationships(pull, ({ many, one }) => ({
  repo: one({ sourceField: ["repo_id"], destSchema: repo, destField: ["id"] }),
  classifications: many({
    sourceField: ["id"],
    destSchema: classification,
    destField: ["pull_id"],
  }),
  feedback: many({ sourceField: ["id"], destSchema: feedback, destField: ["pull_id"] }),
  reviews: many({ sourceField: ["id"], destSchema: pullReview, destField: ["pull_id"] }),
  guidedReviews: many({ sourceField: ["id"], destSchema: guidedReview, destField: ["pull_id"] }),
  reviewProgress: many({ sourceField: ["id"], destSchema: reviewProgress, destField: ["pull_id"] }),
}));

const guidedReviewRelationships = relationships(guidedReview, ({ many, one }) => ({
  pull: one({ sourceField: ["pull_id"], destSchema: pull, destField: ["id"] }),
  creator: one({ sourceField: ["created_by"], destSchema: user, destField: ["id"] }),
  files: many({ sourceField: ["id"], destSchema: guidedReviewFile, destField: ["review_id"] }),
}));

const llmCostRelationships = relationships(llmCost, ({ one }) => ({
  provider: one({ sourceField: ["provider_id"], destSchema: provider, destField: ["id"] }),
  keyOwner: one({ sourceField: ["key_owner"], destSchema: user, destField: ["id"] }),
  requester: one({ sourceField: ["requested_by"], destSchema: user, destField: ["id"] }),
}));

const reviewProgressRelationships = relationships(reviewProgress, ({ one }) => ({
  user: one({ sourceField: ["user_id"], destSchema: user, destField: ["id"] }),
}));

const feedbackRelationships = relationships(feedback, ({ one }) => ({
  user: one({ sourceField: ["user_id"], destSchema: user, destField: ["id"] }),
  issue: one({ sourceField: ["issue_id"], destSchema: issue, destField: ["id"] }),
  pull: one({ sourceField: ["pull_id"], destSchema: pull, destField: ["id"] }),
}));

const classificationRelationships = relationships(classification, ({ one }) => ({
  run: one({ sourceField: ["run_id"], destSchema: run, destField: ["id"] }),
}));

const presenceRelationships = relationships(presence, ({ one }) => ({
  issue: one({ sourceField: ["issue_id"], destSchema: issue, destField: ["id"] }),
}));

export const schema = createSchema({
  tables: [
    user,
    invite,
    repo,
    provider,
    label,
    issue,
    issueLabel,
    triage,
    pull,
    pullReview,
    guidedReview,
    guidedReviewFile,
    reviewProgress,
    llmCost,
    reviewer,
    run,
    classification,
    feedback,
    presence,
    workerState,
  ],
  relationships: [
    repoRelationships,
    inviteRelationships,
    issueRelationships,
    triageRelationships,
    pullRelationships,
    guidedReviewRelationships,
    reviewProgressRelationships,
    llmCostRelationships,
    feedbackRelationships,
    classificationRelationships,
    presenceRelationships,
  ],
});

export type Schema = typeof schema;

export const zql = createBuilder(schema);

declare module "@rocicorp/zero" {
  interface DefaultTypes {
    schema: Schema;
    context: ZeroContext | undefined;
  }
}

export type IssueRow = Schema["tables"]["issue"] extends { columns: infer C }
  ? { [K in keyof C]: C[K] extends { type: infer T } ? T : never }
  : never;

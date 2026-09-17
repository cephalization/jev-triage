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
};

export const CLASSIFICATION_KINDS = [
  "category",
  "area",
  "severity",
  "needs_info",
  "actionable",
  "duplicate",
  "urgency",
] as const;
export type ClassificationKind = (typeof CLASSIFICATION_KINDS)[number];

export const CATEGORIES = ["bug", "feature", "question", "docs", "chore", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

const user = table("user")
  .columns({
    id: string(),
    name: string(),
    color: string(),
    created_at: number(),
  })
  .primaryKey("id");

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
    questions_version: number(),
    batch_size: number(),
    cadence_ms: number(),
    budget_tokens: number(),
    tokens_used: number(),
    paused: boolean(),
    created_at: number(),
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
    issue_id: string(),
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
    issue_id: string(),
    repo_id: string(),
    user_id: string(),
    kind: string(),
    value: string(),
    note: string().optional(),
    created_at: number(),
  })
  .primaryKey("id");

const presence = table("presence")
  .columns({
    user_id: string(),
    name: string(),
    color: string(),
    repo_id: string().optional(),
    issue_id: string().optional(),
    updated_at: number(),
  })
  .primaryKey("user_id");

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
  labels: many(
    { sourceField: ["id"], destSchema: issueLabel, destField: ["issue_id"] },
    { sourceField: ["label_id"], destSchema: label, destField: ["id"] },
  ),
}));

const feedbackRelationships = relationships(feedback, ({ one }) => ({
  user: one({ sourceField: ["user_id"], destSchema: user, destField: ["id"] }),
  issue: one({ sourceField: ["issue_id"], destSchema: issue, destField: ["id"] }),
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
    repo,
    label,
    issue,
    issueLabel,
    run,
    classification,
    feedback,
    presence,
    workerState,
  ],
  relationships: [
    repoRelationships,
    issueRelationships,
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

-- typeful-triage initial schema. Timestamps are timestamptz; Zero syncs them as epoch ms numbers.
create extension if not exists pg_trgm;

create table if not exists "user" (
  id text primary key,
  name text not null,
  color text not null,
  created_at timestamptz not null default now()
);

create table if not exists repo (
  id text primary key,                 -- "owner/name"
  owner text not null,
  name text not null,
  description text,
  default_branch text not null default 'main',
  open_issues integer not null default 0,
  last_synced_at timestamptz,
  sync_cursor text,                    -- newest updated_at stored; re-syncs walk newest-first down to it
  sync_status text not null default 'idle',   -- idle | running | error
  sync_error text,
  sync_phase text not null default 'idle',    -- idle | recent | history | capped | done | error
  sync_fetched integer not null default 0,    -- issues stored by the current/last run
  sync_pages integer not null default 0,
  sync_rate_remaining integer,
  sync_started_at timestamptz,
  sync_message text,
  sync_limit integer not null default 100,    -- max issues to keep while testing
  history_complete boolean not null default false,
  history_cursor text,                        -- oldest updated_at stored so far
  questions_version integer not null default 1,
  batch_size integer not null default 20,
  cadence_ms integer not null default 2000,
  budget_tokens bigint not null default 0,     -- 0 = unlimited
  tokens_used bigint not null default 0,
  paused boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists label (
  id text primary key,
  repo_id text not null references repo(id) on delete cascade,
  name text not null,
  color text not null default '',
  description text
);
create index if not exists label_repo_idx on label(repo_id);

create table if not exists issue (
  id text primary key,                 -- GitHub node id
  repo_id text not null references repo(id) on delete cascade,
  number integer not null,
  title text not null,
  body text not null default '',
  state text not null,                 -- open | closed
  author text not null default '',
  author_association text not null default '',
  labels_json jsonb not null default '[]'::jsonb,
  comments integer not null default 0,
  reactions integer not null default 0,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  closed_at timestamptz,
  url text not null default '',
  reclassify boolean not null default false,
  classifying boolean not null default false  -- in the batch currently in flight
);
create index if not exists issue_repo_updated_idx on issue(repo_id, updated_at desc);
create index if not exists issue_title_trgm_idx on issue using gin (title gin_trgm_ops);

create table if not exists issue_label (
  issue_id text not null references issue(id) on delete cascade,
  label_id text not null references label(id) on delete cascade,
  primary key (issue_id, label_id)
);

create table if not exists run (
  id text primary key,
  repo_id text not null references repo(id) on delete cascade,
  kind text not null,                  -- classify | sync
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  issues integer not null default 0,
  questions integer not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  latency_ms integer not null default 0,
  model text,
  status text not null default 'running',   -- running | ok | error
  error text
);
create index if not exists run_repo_started_idx on run(repo_id, started_at desc);

create table if not exists classification (
  id text primary key,
  issue_id text not null references issue(id) on delete cascade,
  repo_id text not null references repo(id) on delete cascade,
  questions_version integer not null,
  kind text not null,                  -- category | area | severity | needs_info | actionable | duplicate | urgency
  value text not null,
  confidence real,
  probabilities_json jsonb not null default '{}'::jsonb,
  model text not null,
  run_id text references run(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists classification_issue_idx on classification(issue_id, kind, created_at desc);
create index if not exists classification_repo_idx on classification(repo_id, questions_version);

create table if not exists feedback (
  id text primary key,
  issue_id text not null references issue(id) on delete cascade,
  repo_id text not null references repo(id) on delete cascade,
  user_id text not null references "user"(id),
  kind text not null,
  value text not null,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists feedback_issue_idx on feedback(issue_id, kind, created_at desc);
create index if not exists feedback_repo_idx on feedback(repo_id, created_at desc);

create table if not exists presence (
  user_id text primary key references "user"(id),
  name text not null,
  color text not null,
  repo_id text,
  issue_id text,
  updated_at timestamptz not null default now()
);

create table if not exists worker_state (
  repo_id text primary key references repo(id) on delete cascade,
  in_flight boolean not null default false,
  dirty boolean not null default false,
  pending integer not null default 0,        -- issues still waiting for classification
  dropped_triggers integer not null default 0,
  coalesced_triggers integer not null default 0,
  requests integer not null default 0,
  last_error text,
  updated_at timestamptz not null default now()
);

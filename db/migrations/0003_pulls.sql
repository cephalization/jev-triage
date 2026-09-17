-- Pull requests, their reviews, a derived reviewer roster, and pull-aware classification/feedback.

alter table repo add column if not exists pull_limit integer not null default 200;         -- open PRs to keep
alter table repo add column if not exists pull_history_limit integer not null default 300; -- closed PRs to keep (reviewer stats)
alter table repo add column if not exists pull_synced_at timestamptz;

create table if not exists pull (
  id text primary key,                 -- GitHub node id
  repo_id text not null references repo(id) on delete cascade,
  number integer not null,
  title text not null,
  body text not null default '',
  state text not null,                 -- open | merged | closed
  draft boolean not null default false,
  author text not null default '',
  author_association text not null default '',
  head_ref text not null default '',
  base_ref text not null default '',
  additions integer not null default 0,
  deletions integer not null default 0,
  changed_files integer not null default 0,
  files_json jsonb not null default '[]'::jsonb,               -- changed paths (first 100)
  labels_json jsonb not null default '[]'::jsonb,
  requested_reviewers_json jsonb not null default '[]'::jsonb, -- logins currently requested
  review_decision text,                -- APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
  mergeable text,                      -- MERGEABLE | CONFLICTING | UNKNOWN
  comments integer not null default 0,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  closed_at timestamptz,
  merged_at timestamptz,
  merged_by text,
  url text not null default '',
  reclassify boolean not null default false,
  classifying boolean not null default false
);
create index if not exists pull_repo_updated_idx on pull(repo_id, updated_at desc);
create index if not exists pull_repo_state_idx on pull(repo_id, state);

create table if not exists pull_review (
  id text primary key,                 -- GitHub review node id
  pull_id text not null references pull(id) on delete cascade,
  repo_id text not null references repo(id) on delete cascade,
  reviewer text not null,
  state text not null,                 -- APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
  submitted_at timestamptz not null
);
create index if not exists pull_review_pull_idx on pull_review(pull_id);
create index if not exists pull_review_repo_reviewer_idx on pull_review(repo_id, reviewer);

-- Derived in code from pull_review + pull files after every pull sync page; rewritten whole.
create table if not exists reviewer (
  repo_id text not null references repo(id) on delete cascade,
  login text not null,
  reviews integer not null default 0,
  approvals integer not null default 0,
  changes_requested integer not null default 0,
  last_review_at timestamptz,
  median_response_hours real,
  dirs_json jsonb not null default '[]'::jsonb,   -- [{ dir, count }] top directories reviewed
  recent_titles_json jsonb not null default '[]'::jsonb, -- a few recently approved PR titles
  open_load integer not null default 0,           -- open PRs where requested or already reviewing
  primary key (repo_id, login)
);

-- Classification and feedback now point at exactly one subject: an issue or a pull.
alter table classification alter column issue_id drop not null;
alter table classification add column if not exists pull_id text references pull(id) on delete cascade;
alter table classification drop constraint if exists classification_subject;
alter table classification add constraint classification_subject
  check ((issue_id is null) <> (pull_id is null));
create index if not exists classification_pull_idx on classification(pull_id, kind, created_at desc);

alter table feedback alter column issue_id drop not null;
alter table feedback add column if not exists pull_id text references pull(id) on delete cascade;
alter table feedback drop constraint if exists feedback_subject;
alter table feedback add constraint feedback_subject
  check ((issue_id is null) <> (pull_id is null));
create index if not exists feedback_pull_idx on feedback(pull_id, kind, created_at desc);

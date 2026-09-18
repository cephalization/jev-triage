-- Guided reviews: one generated walkthrough per run over a pull request, shared by everyone.
-- The patch it was generated from is kept in the private schema and served by the API; the
-- steps replicate with the row.

create table if not exists guided_review (
  id text primary key,
  pull_id text not null references pull(id) on delete cascade,
  repo_id text not null references repo(id) on delete cascade,
  head_sha text,                               -- commit the patch was taken at
  status text not null default 'queued',       -- queued | running | ready | failed
  provider_id text references provider(id) on delete set null,
  model text not null,
  groups_json jsonb not null default '[]'::jsonb,   -- [{ name, summary, files }]
  file_count integer not null default 0,
  error text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  created_by text references "user"(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists guided_review_pull_idx on guided_review(pull_id, created_at desc);

create table if not exists private.review_patch (
  review_id text primary key references guided_review(id) on delete cascade,
  patch text not null
);

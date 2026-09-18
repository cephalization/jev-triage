-- Phase 4 and 5 of guided reviews: jev's per-file answers, where each review came from, and
-- each person's progress through the steps.

-- 'agent' when the model wrote the steps; 'seed' when the agent failed and the code-produced
-- order from the file classification was served instead (error then says why).
alter table guided_review add column if not exists source text not null default 'agent';

create table if not exists guided_review_file (
  review_id text not null references guided_review(id) on delete cascade,
  path text not null,
  status text not null,                      -- A | M | D
  added integer not null default 0,
  removed integer not null default 0,
  role text not null,                        -- core | supporting | tests | docs | config | generated | formatting
  role_confidence real,
  risk real,                                 -- 0..1 over the risk rubric
  attention real,                            -- 0..1 over the attention rubric
  entry real,                                -- probability the review starts here
  probabilities_json jsonb not null default '{}'::jsonb,
  questions_version integer not null,
  primary key (review_id, path)
);

-- Shared review, personal progress. Keyed by step name within a pull request so a regeneration
-- that keeps a step's name keeps everyone's mark on it.
create table if not exists review_progress (
  pull_id text not null references pull(id) on delete cascade,
  user_id text not null references "user"(id) on delete cascade,
  step_name text not null,
  review_id text references guided_review(id) on delete set null,
  reviewed_at timestamptz not null default now(),
  primary key (pull_id, user_id, step_name)
);
create index if not exists review_progress_pull_idx on review_progress(pull_id);

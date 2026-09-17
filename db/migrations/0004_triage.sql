-- Triage queue state per issue: who has it, and whether it has left the queue.
-- Questions v2 also retires the needs_info/actionable classification kinds in favour of
-- action (next step) and missing (what to ask for); old rows stay as history.

create table if not exists triage (
  issue_id text primary key references issue(id) on delete cascade,
  repo_id text not null references repo(id) on delete cascade,
  status text not null default 'open',            -- open | done
  claimed_by text references "user"(id) on delete set null,
  claimed_at timestamptz,
  done_by text references "user"(id) on delete set null,
  done_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists triage_repo_status_idx on triage(repo_id, status);
create index if not exists triage_claimed_idx on triage(repo_id, claimed_by);

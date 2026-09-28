-- Personal dispositions, separate from the team's triage state. A newer GitHub
-- update reopens handled work; snoozes expire or can be restored manually.
create table work_queue_state (
  user_id text not null references "user"(id) on delete cascade,
  repo_id text not null references repo(id) on delete cascade,
  subject_kind text not null check (subject_kind in ('issue', 'pull')),
  subject_id text not null,
  status text not null check (status in ('handled', 'snoozed')),
  subject_updated_at timestamptz not null,
  snoozed_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, subject_kind, subject_id)
);
create index work_queue_state_repo_user_idx on work_queue_state(repo_id, user_id);

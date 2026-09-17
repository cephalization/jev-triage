-- One presence row per browser tab instead of per user. Two tabs of the same user used to
-- fight over a single row (each heartbeat overwrote issue_id), which made avatars flicker.
-- The UI groups rows by user_id; the heartbeat mutator prunes rows older than 10 minutes.
drop table if exists presence;
create table presence (
  client_id text primary key,
  user_id text not null references "user"(id),
  name text not null,
  color text not null,
  repo_id text,
  issue_id text,
  updated_at timestamptz not null default now()
);
create index if not exists presence_user_idx on presence(user_id);
create index if not exists presence_issue_idx on presence(issue_id);

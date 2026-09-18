-- Real accounts: a user is a GitHub account. Admins come from ADMIN_GITHUB_LOGINS; everyone
-- else needs an invite row. Older u_… rows from the removed dev login stay as history.

alter table "user" add column if not exists login text;            -- GitHub login, as GitHub spells it
alter table "user" add column if not exists github_id bigint;
alter table "user" add column if not exists avatar_url text;
alter table "user" add column if not exists role text not null default 'member';  -- admin | member
alter table "user" add column if not exists last_login_at timestamptz;
create unique index if not exists user_login_idx on "user"(lower(login)) where login is not null;
create unique index if not exists user_github_id_idx on "user"(github_id) where github_id is not null;

create table if not exists invite (
  login text primary key,                 -- lowercased GitHub login
  role text not null default 'member',    -- role granted on first sign-in
  invited_by text references "user"(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by text references "user"(id) on delete set null
);

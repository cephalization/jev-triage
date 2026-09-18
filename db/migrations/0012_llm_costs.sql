-- What review generation costs at the model provider: one row per agent call, priced by the
-- pi SDK's catalog when it knows the model, with the key's owner at the time of the call so a
-- rotation later does not rewrite history.

alter table provider add column if not exists key_set_by text references "user"(id) on delete set null;
alter table guided_review add column if not exists cost_usd double precision not null default 0;
alter table guided_review add column if not exists priced boolean not null default true;

create table if not exists llm_cost (
  id text primary key,
  repo_id text not null references repo(id) on delete cascade,
  review_id text references guided_review(id) on delete set null,
  provider_id text references provider(id) on delete set null,
  provider_kind text not null,
  model text not null,
  key_owner text references "user"(id) on delete set null,
  requested_by text references "user"(id) on delete set null,
  stage text not null,                       -- skeleton | narrative | single
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost_usd double precision not null default 0,
  priced boolean not null default false,     -- false when the model's price is unknown; cost_usd is 0 then
  created_at timestamptz not null default now()
);
create index if not exists llm_cost_repo_created_idx on llm_cost(repo_id, created_at desc);
-- historical rows read as unknown cost, not $0
update guided_review set priced = false where cost_usd = 0 and status = 'ready' and not exists (select 1 from llm_cost c where c.review_id = guided_review.id);

-- Shared model providers for guided reviews. The provider row is replicated to every client;
-- the API key is sealed (AES-256-GCM under CONFIG_SECRET) in a schema that Zero does not
-- publish, so it never leaves the server.

create table if not exists provider (
  id text primary key,
  kind text not null,                       -- anthropic | openai | openrouter | openai-compatible
  label text not null,
  base_url text not null,
  key_hint text,                            -- "…abcd" when a key is set, null otherwise
  models_json jsonb not null default '[]'::jsonb,  -- [{ id, label, enabled }]
  created_by text references "user"(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create schema if not exists private;
create table if not exists private.provider_key (
  provider_id text primary key references provider(id) on delete cascade,
  sealed text not null,
  updated_at timestamptz not null default now()
);

-- Per-repo default for generating reviews; a run may still override it.
alter table repo add column if not exists review_provider_id text references provider(id) on delete set null;
alter table repo add column if not exists review_model text;

-- Phase 6 of guided reviews: know when a review is stale, cap what reviews may spend, and let an
-- admin end someone's access.

-- The head commit GitHub reports for the pull; a review whose head_sha differs is stale.
alter table pull add column if not exists head_sha text;

-- Provider tokens (input + output across this repo's reviews) allowed before generation is
-- refused; 0 means unlimited. TypeSafe tokens have their own budget (budget_tokens).
alter table repo add column if not exists review_budget_tokens integer not null default 0;

-- Set when an admin removes the person's invite; their tokens stop working at once and a
-- fresh invite clears it. The row and everything it authored stay.
alter table "user" add column if not exists revoked_at timestamptz;

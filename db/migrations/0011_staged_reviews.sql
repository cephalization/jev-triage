-- Staged generation: the row says which stage a running review is in, and how much the agent
-- read beyond the diff. Steps kept from the previous review are counted so cost is honest.

alter table guided_review add column if not exists phase text;                         -- snapshot | classify | skeleton | assign | narrate | null when done
alter table guided_review add column if not exists tool_calls integer not null default 0;
alter table guided_review add column if not exists reused_steps integer not null default 0;

-- Input and output tokens separately per repo, so a to-date cost can be shown live from the
-- repo row (prices differ per direction). Backfilled from completed runs.
alter table repo add column if not exists input_tokens_used bigint not null default 0;
alter table repo add column if not exists output_tokens_used bigint not null default 0;
update repo r set
  input_tokens_used = coalesce((select sum(input_tokens) from run where run.repo_id = r.id and run.status = 'ok'), 0),
  output_tokens_used = coalesce((select sum(output_tokens) from run where run.repo_id = r.id and run.status = 'ok'), 0);

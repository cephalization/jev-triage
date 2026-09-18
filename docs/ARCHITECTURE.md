# Architecture

How the pieces fit, what the model is asked, and the rules that keep it honest. For setup see
the [README](../README.md).

## Stack and roles

| Piece                            | Role                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------- |
| Postgres (`wal_level=logical`)   | Source of truth                                                              |
| `zero-cache`                     | Replicates Postgres to every client; realtime and multiplayer come from this |
| Hono on Node (`apps/api`)        | Zero mutate and query endpoints, GitHub sync, TypeSafe worker, dev auth      |
| React (`apps/web`)               | Dashboard; reads the local replica, writes through mutators                  |
| `@typesafe-ai/sdk` (server only) | Classification and duplicate reranking                                       |
| celld cell (`apps/reviewer`)     | Guided reviews: one Durable Object per run drives the pi SDK; optional       |

Clients never talk to GitHub or TypeSafe. They read Zero rows and call mutators; the server
side of a mutator is where classification work is enqueued.

## Data model

```
repo            id ("owner/name"), sync state and cursors, questions_version, knobs
                (batch_size, cadence_ms, budget_tokens, sync_limit, pull_limit,
                pull_history_limit, paused), token counters
issue           GitHub node id, number, title, body, state, author, labels, counts,
                timestamps, reclassify, classifying
label           per repo
issue_label     join
pull            like issue, plus draft, refs, diff stats, files, requested reviewers,
                review_decision, mergeable
pull_review     one row per review (reviewer, state, submitted_at)
reviewer        derived roster per repo: reviews, approvals, directories, median
                first-response hours, open load; rebuilt in code after each history page
classification  one row per (subject, kind, questions_version, run): value, confidence,
                probabilities_json, model
feedback        append-only human answers: (subject, kind, value, user, note)
triage          queue state per issue: status (open | done), claimed_by, done_by
run             one row per TypeSafe request: counts, tokens, latency, model, status
presence        one row per browser tab: user, repo, issue being viewed, updated_at
worker_state    per repo: in_flight, dirty, pending, counters, last_error
user            dev accounts: id, name, color
```

**Effective value** of a field for an issue = the latest `feedback` row for that kind, else the
latest `classification` row for that kind at the repo's current `questions_version`. Human rows
never overwrite model rows; the two are reconciled at read time
(`packages/schema/src/effective.ts`). Disagreement between them is visible and feeds
calibration.

## Flows

### Sync

`POST /api/sync {owner, name}` answers 202 and streams progress through the `repo` row. Issues
are walked newest first, one page per transaction, so recent work lands and gets classified
first. A recent phase covers the last year (or down to the previous high-water mark on a
re-sync); a slower history phase backfills older pages and is resumable. `sync_limit` caps how
many new issues are kept; updates to stored issues always apply.

With a `GITHUB_TOKEN`, a GraphQL walk fetches open pull requests (files, reviews, requested
reviewers) and a second walk fetches merged and closed ones for reviewer history. After every
history page the reviewer roster is rebuilt in pure code; bots and AI review accounts are
excluded.

### Classify

One scheduler per repo in `apps/api/src/worker`. A poke while a request is in flight only sets a
dirty flag; pokes inside a short collect window share one run; a finished batch re-runs after
`cadence_ms` while work remains. Every request is one shared state plus an independent matrix
of questions, and every answer is stored with the `questions_version` it was asked under.

Per issue, questions v2 asks:

| Family      | Primitive | Outcomes                                                                         |
| ----------- | --------- | -------------------------------------------------------------------------------- |
| `category`  | Choice    | bug, feature, question, docs, chore, other                                       |
| `area`      | Choice    | the repo's most-used labels + none (skipped when there are no labels)            |
| `severity`  | Score     | cosmetic, degraded, blocks a workflow, data loss or outage                       |
| `urgency`   | Score     | no hurry, this week, now                                                         |
| `duplicate` | Choice    | up to five candidates found by title similarity in code + none                   |
| `action`    | Choice    | ask_author, answer, investigate, decide, accept, close, wait                     |
| `missing`   | Choice    | repro steps, versions, expected vs actual, minimal example, logs, proposal, none |

`action` is the single next step a maintainer should take and drives the Triage grouping;
`wait` is its no-match outcome. `missing` is asked speculatively for every issue and read only
when the next step is to ask the author. The shared state carries the repository, its area
labels, and up to twenty recent human-labelled examples (category, area, next step) so the
model follows the team's conventions.

Per open pull request, in batches of at most eight: `review_effort` (a Score over four rubric
levels) and `reviewer` (a Choice over up to five candidates the code shortlisted by directory
overlap, recency and volume, plus none). The model judges expertise only; spreading suggestions
across people by load happens in the browser over the stored probabilities and never re-asks.

### Policy

`decide()` in `packages/triage/src/decide.ts` turns answers into decisions with named thresholds
from `policy.ts`: category and area auto-apply at 0.6, the next step at 0.45, duplicates
surface at 0.7 and are never auto-closed. Below a threshold the issue lands in Unsure with a
reason. Confidence is the concentration of the model's distribution, not correctness.

Priority is a user-weighted sum of severity, urgency, reactions, comments and age; changing the
weights changes only the view. Pull requests use a fixed attention order.

### Feedback and the queue

`feedback.set` appends a row and, by default, flags the subject for reclassification so the
model's rows refresh with the new example in state. A confirmation passes `reclassify: false`.
`triage.claim`, `triage.setStatus` and `triage.accept` manage the queue; `accept` records the
model's next step, category, area and duplicate as human feedback and marks the issue done in
one step.

Feedback is append-only and keyed by a client-generated id, so concurrent edits never conflict:
the newest row wins for display and every row stays in the history. Repo knobs are
last-writer-wins through Zero's rebase.

### Recalculate

"Re-ask" flags the issues in view. "Recalculate everything" bumps `questions_version` so every
issue gets new rows; old rows stay for comparison. The worker also bumps the repo's version to
the code's `QUESTIONS_VERSION` when the code moves ahead.

### Guided review

`POST /api/reviews` queues a `guided_review` row and `runReviewJob` drives it: the diff comes
from GitHub, jev answers four questions per changed file (`packages/triage/src/review/files.ts`,
stored in `guided_review_file`, one `run` row per batch), `groupSeed()` turns the answers into an
ordered proposal, and the agent (the reviewer cell, or the in-process runner) writes the steps
with the proposal as `<classification>`. If the agent fails, the proposal is served as the
review with `source = 'seed'`. The screen at `/pulls/$pullId/review` reads the row, its file
rows and everyone's `review_progress` marks through Zero, and fetches the patch from
`/api/reviews/:id/patch`.

### Presence

A heartbeat mutator every 15 seconds records which issue each tab has open. Rows older than 45
seconds are ignored; rows quiet for ten minutes are swept.

## Cost

Roughly 200 input tokens per question including the amortised state; issue bodies are the
bulk. Twenty issues with seven questions each is about 40K input tokens in one request. Pull
batches are capped at eight because files and candidate histories are heavier. Every request
writes a `run` row, and per-repo token counters feed the spend shown in the UI when prices are
configured. A per-repo `budget_tokens` stops the worker when reached.

## Guardrails

- Secrets and the TypeSafe SDK live only in `apps/api`. Provider keys are sealed at rest and
  reach the reviewer cell only inside a request; the cell never stores them.
- One in-flight request per repo; triggers during flight set a flag, never enqueue.
- Every model answer is stored with its `questions_version`; changing a question means a new
  version, never editing old rows.
- `decide()` and the question builders are pure and covered by canned-answer tests; the only
  network code is the worker and the sync.

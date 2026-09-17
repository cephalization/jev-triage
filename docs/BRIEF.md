# Brief: GitHub issue triage dashboard (Vite+ · React · shadcn/ui · Zero · Hono · TypeSafe)

Written 2026-09-16 after building `typeful-game` (three.js + celld + TypeSafe). Part 1 records what
that project taught about the shared stack. Part 2 is the plan for the new project. Copy this file
into the new repo as `docs/BRIEF.md` and point `CLAUDE.md` at it.

---

## Part 1 — Learnings from the previous project

### Vite+ (`vp`) on this machine

- The global `vp` is 0.1.22; the project package `vite-plus` is 0.3.2. Project commands use the
  local one. Run `vp upgrade` once to stop the old template generator from biting.
- `vp create vite:application` on this Mac produced a broken install three ways. After scaffolding
  and BEFORE `vp install`:
  1. `packageManager` was `pnpm@12.4.2`, which the global pnpm 10 cannot spawn (ENOEXEC). Pin
     `pnpm@11.18.0` (cached and working under `~/Library/pnpm/.tools`).
  2. `pnpm-workspace.yaml` aliased `vitest -> @voidzero-dev/vite-plus-test@latest` and
     `vite -> @voidzero-dev/vite-plus-core@latest`; that drags in an old core without its native
     binding ("Cannot find native binding"). Delete the catalog and overrides. `vite-plus@^0.3.2`
     bundles vite and vitest itself; do not depend on `vite` or `vitest` directly.
  3. pnpm 11 errors on esbuild's ignored build script. Put `allowBuilds:\n  esbuild: false` in
     `pnpm-workspace.yaml`. Do NOT allow it: the postinstall swaps `bin/esbuild` for a native binary
     that pnpm's node shim then runs through node (SyntaxError). The JS launcher works as-is.
     Also check `@rocicorp/zero-sqlite3` needs `pnpm rebuild @rocicorp/zero-sqlite3` (Zero docs); that
     one DOES need its build script allowed.
- Tests import from `vite-plus/test`, not `vitest`. Test config lives in `vite.config.ts` under
  `test`. `vp test` runs once; `vp test watch` watches. Tasks with caching go in
  `vite.config.ts` under `run.tasks`; `vp run <name>` runs them, `vp <builtin>` ignores scripts.
- `vp check` = fmt + lint + type-aware lint. The formatter (oxfmt) rewrites to double quotes and
  re-wraps long lines. Consequences for an agent: write new files in double quotes; after any
  batch of writes run `vp check --fix`; and prefer whole-file rewrites over regex patches, because
  a patch written against pre-format text will silently miss after the formatter runs. If you
  must patch, match whitespace-tolerantly and assert the match count.
- Multiple runtimes in one repo (browser + server) need separate tsconfigs (DOM lib vs
  `@types/node` or Workers types) joined by a solution-style root `tsconfig.json` with
  `references` and `files: []`; typecheck with `tsc -b`. Shared code must not touch either set of
  globals. `erasableSyntaxOnly` is on in the template: no constructor parameter properties.
- The lint rule `vite-plus/prefer-vite-plus-imports` is on; keep imports on `vite-plus/*`.

### TypeSafe / System One (`@typesafe-ai/sdk` 0.6.0)

- One request = one `state` + many independent `questions`. Everything is evaluated in parallel
  with no cross-talk, so the natural unit is a _matrix_: entity × question family. Key questions
  as `entity__family__field` and fold answers back by splitting the key.
- Measured cost (jev-1.13.0): ~100 input tokens and ~23 output tokens per question, with the
  shared state paid once per request. 190 questions ≈ 19k in / 4.6k out, 350–800 ms. 56 questions
  ≈ 6.8k / 1.3k, 200–500 ms. Log `result.usage` on every request and show it in the UI.
- Helpers: `choice(instructions, {label: description})`, `noul(instructions, {true, false})`,
  `score(instructions, [level0, level1, ...])`. Instructions can be objects (`{question, notes}`).
  Reference nested state with backticked paths (`` `issues[3].title` ``). Include a `none` /
  no-match outcome in every Choice. Score answers come back as an expected value across levels;
  divide by (levels − 1) to normalise.
- Keep policy in code: a pure `decide(answers)` with named thresholds, tested with canned answers
  through a fake `SystemOne` interface (`ask(state, questions)`). Thresholds change without
  touching questions. Confidence is distribution concentration, not correctness.
- Backpressure: one request in flight per scope, a short collect window so simultaneous triggers
  share a request, drop or coalesce what arrives meanwhile, and count drops. A feedback loop that
  re-triggers itself on completion caused a 2 req/s storm; guard every "on done" trigger.
- Batch by _shared state_: reviewing everything together every N seconds was far cheaper per
  question than per-entity requests, because the state is amortised.
- The SDK must never run in the browser. Construct it server-side with `apiKey` from env. In
  workerd it needed a buffering `fetch` (cannot clone a streaming Response); Node does not.
- Use the installed `typesafe@typesafe-ai` skill and read the live docs (`docs.typesafe.ai/llms.txt`)
  before designing questions; do not invent SDK details.

### Multiplayer and realtime

- Server-authoritative state with clients sending intent worked well. In the new project Zero
  replaces the hand-rolled WebSocket layer entirely: clients read from the local replica and write
  through mutators; the server side of a mutator is where TypeSafe work gets enqueued.

---

## Part 2 — Plan: issue triage dashboard

### Goal

Sync a public GitHub repo's issues into a locally synced database, classify them with TypeSafe,
show the results in a live multi-user dashboard, and let users correct or augment classifications
so the results persist and can be recalculated with that feedback.

### Stack and roles

| Piece                                     | Role                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| Postgres 18 (Docker, `wal_level=logical`) | Source of truth                                                                   |
| `zero-cache` (`npx zero-cache-dev`)       | Replicates Postgres to every client; realtime and multiplayer for free            |
| Hono on Node (`apps/api`)                 | Zero mutate and query endpoints, GitHub sync, TypeSafe worker, auth token minting |
| Vite+ React (`apps/web`)                  | Dashboard; shadcn/ui components; `@rocicorp/zero/react` for data                  |
| `@typesafe-ai/sdk` (server only)          | Classification and duplicate reranking                                            |

Docs to read first: https://zero.rocicorp.dev/docs/install, /docs/schema, /docs/queries,
/docs/mutators, /docs/auth, /docs/react, /docs/zero-cache-config; https://hono.dev/docs;
https://ui.shadcn.com/docs/installation/vite; https://docs.typesafe.ai/llms.txt.

### Repo layout

```
apps/web/        Vite+ React app (shadcn, Tailwind, Zero client)
apps/api/        Hono server: /api/mutate, /api/query, /api/sync, /api/auth, worker loop
packages/schema/ Zero schema (tables, relationships), mutators (client-safe), zod types
packages/triage/ TypeSafe question builders + pure decide() + tests (no network)
db/              SQL migrations (plain .sql, applied by a tiny node script or drizzle-kit)
docker-compose.yml  Postgres with wal_level=logical
vite.config.ts   workspace root config; run.tasks for dev/typecheck/test
```

Start as a Vite+ monorepo (`vp create vite:monorepo`), then apply the Part 1 install fixes before
`vp install`.

### Data model (Postgres tables ⇄ Zero tables)

```
repo            id, owner, name, default_branch, last_synced_at, sync_cursor (ISO since), open_issues
issue           id (gh node id), repo_id, number, title, body, state, author, labels_json,
                comments, reactions, created_at, updated_at, closed_at, url
label           id, repo_id, name, color, description
issue_label     issue_id, label_id
classification  id, issue_id, questions_version, kind ('category'|'area'|'severity'|'needs_info'|
                'actionable'|'duplicate'|'urgency'), value, confidence, probabilities_json,
                model, run_id, created_at
feedback        id, issue_id, user_id, kind, value, note, created_at      (append-only)
run             id, repo_id, started_at, finished_at, issues, questions, input_tokens,
                output_tokens, latency_ms, model, status, error
presence        user_id, name, color, issue_id (viewing), updated_at
user            id, name, color
```

Effective value of a field for an issue = latest `feedback` row for that kind, else latest
`classification` row for that kind and current `questions_version`. Compute that in a Zero query
(join + order + limit) or a small client helper; never overwrite model rows with human ones.

### Flows

1. **Sync** (`POST /api/sync {owner, name}`): Octokit REST `issues.listForRepo` with `state=all`,
   `since=repo.sync_cursor`, `per_page=100`, paginated; skip pull requests; upsert `repo`, `label`,
   `issue`, `issue_label` in one transaction per page so clients see progress live. Respect
   rate-limit headers; back off on 403. Store `updated_at` as the cursor. Optional token in env
   for higher limits. A `sync_runs`-style row is not needed; reuse `run` with kind if you like.
2. **Classify** (server worker in `apps/api`): select issues with no classification at the current
   `questions_version`, or with a `reclassify` flag, batch 20 at a time, one request per batch.
   Write `classification` rows and a `run` row with usage. One in-flight request per repo; a
   trigger while in flight only sets a "dirty" flag, it never queues a second request.
3. **Feedback** (client mutator `feedback.set({issueId, kind, value, note})`): inserts a row;
   the server-side override of the same mutator also marks the issue `reclassify` and appends an
   async task that pokes the worker. Feedback wins immediately in the UI through optimistic
   mutation; the recalculation only refreshes the model's rows.
4. **Recalculate** (button per repo or per filter): bumps `questions_version` or sets
   `reclassify` on the selection. Recent human corrections for the same repo go into the request
   state as `labeled_examples` (title, body excerpt, human category), capped at ~20 and chosen by
   recency, so the model sees the team's conventions. Keep the examples out of the per-issue
   questions; they are shared state.
5. **Presence**: `presence.heartbeat({issueId})` mutator every 15 s; clients query `presence`
   where `updated_at > now − 45 s` and show avatars on the issue row and detail view.

### TypeSafe design (packages/triage)

State per batch:

```
{ repo: {owner, name, description, top_labels: [...]},
  labeled_examples: [{number, title, excerpt, category, area}],
  issues: { "<id>": { number, title, body_excerpt (≤1500 chars), labels, comments, reactions,
                      age_days, author_association, candidates_for_duplicate: [{id, number, title}] } } }
```

Questions per issue (keys `i<id>__<family>`), all independent:

- `category`: choice({question over `issues.<id>`}, {bug, feature, question, docs, chore, other})
- `area`: choice over the repo's top-level component labels + `none` (speculative: ask always)
- `severity`: score(["Cosmetic or trivial", "Degraded but workable", "Blocks a common workflow",
  "Data loss, security, or outage"]) → normalise /3
- `needs_info`: noul("Is the report missing what a maintainer needs to reproduce or act?")
- `actionable`: noul("Could a maintainer start work on this today without asking questions?")
- `urgency`: score(["No hurry", "Should be looked at this week", "Needs attention now"])
- `duplicate`: choice over `candidates_for_duplicate` (top 5 by pg_trgm title similarity, found in
  code) + `none` (rerank pattern: code finds candidates, the model picks)

Roughly 7 questions per issue; 20 issues ≈ 140 questions ≈ 15k input tokens per request. Log it.

Policy (`decide()`, pure, tested with canned answers): auto-apply category at confidence ≥ 0.6,
route to a "needs review" queue below; duplicate only at ≥ 0.7 and never auto-close; composite
priority = weights · [severity, urgency, reactions_norm, comments_norm, age_norm] where the
weights are user-adjustable sliders in the UI and change NO inference (reusable-judgment pattern).
Show a calibration panel: model confidence vs. agreement with human feedback, bucketed.

### Dashboard (apps/web)

- Repo bar: pick/sync a repo, sync progress, last cursor, run stats (issues, tokens, latency, $ if
  prices configured).
- Triage table (shadcn `DataTable`): number, title, category chip with confidence ring, area,
  severity, priority, needs-info badge, duplicate-of link, assignees of feedback, presence avatars.
  Filters and sort are ZQL queries; everything is live.
- Issue drawer: body, labels, model answers with probabilities as small bars, feedback controls
  (correct category/area/severity, mark duplicate, note), history of feedback by user.
- Review queue: low-confidence and disagreement items first.
- Stats tiles and charts: use the `dataviz` skill before drawing anything.
- Presence: who is online and which issue they have open.

### Auth (keep it small)

Dev: `POST /api/auth/dev {name}` mints a JWT signed with `ZERO_AUTH_SECRET` carrying `sub` and
`name`; the client stores it and passes it to `ZeroProvider auth`. Mutators read `ctx.userID`.
Permissions: everyone can read; `feedback`/`presence` rows are only writable by their `user_id`.
Real GitHub OAuth can replace the dev endpoint later without touching the schema.

### Milestones (each ends with a verification you actually run)

- **M0 Toolchain.** `vp create vite:monorepo`; apply Part 1 fixes; `vp check`, `vp test` green on an
  empty workspace; `docker compose up` Postgres; `npx zero-cache-dev` connects. Commit.
- **M1 Schema + hello sync.** Zero schema for `user`, `repo`, `issue`; migrations; Hono serves
  `/api/mutate` and `/api/query`; a React page lists issues from the replica; inserting a row with
  `psql` appears in two browser tabs without reload.
- **M2 GitHub sync.** `/api/sync` pulls a small public repo end to end; re-running is incremental;
  rate-limit handling tested against a large repo with a token.
- **M3 Classification.** `packages/triage` questions + `decide()` with tests; worker classifies a
  batch, writes `classification` and `run` rows; the table shows chips live; usage logged.
- **M4 Dashboard.** shadcn table, drawer, filters, review queue, stats tiles.
- **M5 Feedback + recalculation.** Feedback mutator with server override; effective-value logic;
  labeled examples in state; recalculate button; calibration panel.
- **M6 Multiplayer polish.** Presence, per-user colors, optimistic edits visible across tabs,
  conflict rule documented (feedback is append-only, so there are none).
- **M7 Cost controls.** Batch size and cadence knobs in UI, per-repo budget, drop/coalesce stats.

### Guardrails

- TypeSafe key and GitHub token live only in `apps/api` env. Never import the SDK in `apps/web`.
- One in-flight TypeSafe request per repo; triggers during flight set a flag, never enqueue.
- Store every model answer with `questions_version`; changing a question means a new version,
  never editing old rows.
- Keep `decide()` and question builders pure and covered by canned-answer tests; the only network
  code is the worker and the sync.
- After writing files, run `vp check --fix` then `vp test`; do not hand-patch formatted files with
  fragile string replacement.
- Use the `typesafe` skill for anything touching questions or policy; use `dataviz` for charts.

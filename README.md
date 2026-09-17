# typeful-triage

Multiplayer GitHub triage dashboard. Issues and pull requests sync from GitHub into Postgres,
Rocicorp Zero replicates them to every browser, a Hono API classifies them with TypeSafe System
One, and users correct the model; corrections persist and feed the next recalculation.

See `docs/BRIEF.md` for the plan and `CLAUDE.md` for working rules.

## Run it

```sh
cp .env.example .env          # add TYPESAFE_API_KEY and (optionally) GITHUB_TOKEN
vp install
pnpm dev                      # postgres (docker) + migrations + api + zero-cache + web
```

Open http://localhost:5173, sign in with any name, paste `owner/name`, press Add. Keys: j/k move,
Esc closes the panel, 1–6 set the category, / focuses search.

## Layout

| Path              | What                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `apps/web`        | Vite+ React dashboard (shadcn/ui, Zero client)                                            |
| `apps/api`        | Hono: `/api/query`, `/api/mutate`, `/api/sync`, `/api/auth/dev`, classifier worker        |
| `packages/schema` | Zero schema, client-safe mutators, synced queries, effective-value helper                 |
| `packages/triage` | TypeSafe question builders + pure `decide()` + priority + calibration, all tested offline |
| `db/migrations`   | Plain SQL, applied by `pnpm --filter @triage/api migrate`                                 |

## Checks

```sh
vp check --fix      # fmt + lint + types
vp run -r test      # unit tests in every package
```

## How the pieces fit

- **Sync** (`POST /api/sync {owner, name, paused?, limit?}`, answers 202 immediately): walks
  `issues.listForRepo` sorted by `updated` descending, one page per transaction, so the most
  recently touched issues land and get classified first. Recent phase = last year (or down to the
  previous high-water mark `repo.sync_cursor` on a re-sync); history phase = older pages, one every
  4 s, resumable via `repo.history_cursor`. `repo.sync_limit` (default 100, Settings → Sync cap)
  caps _new_ issues; updates to stored issues always apply. Progress is on the repo row
  (`sync_phase`, `sync_fetched`, `sync_pages`, `sync_rate_remaining`, `sync_message`).
- **Pull requests** (`apps/api/src/github/pulls.ts`, needs `GITHUB_TOKEN`): once the recent issue
  phase ends, one GraphQL walk fetches open pulls (files, reviews, requested reviewers; cap
  `repo.pull_limit`, default 200) and a second, slower walk fetches merged/closed pulls
  (`repo.pull_history_limit`, default 300). After every history page the `reviewer` roster is
  rebuilt in pure code (`packages/triage/src/reviewers.ts`): reviews, approvals, directories
  reviewed, median first-response time, open load. Bots and AI review accounts are excluded.
- **Classify** (`apps/api/src/worker`): one `Scheduler` per repo. A poke while a request is in
  flight only sets `dirty` (counted as a dropped trigger); pokes inside the 300 ms collect window
  share one run (coalesced); a finished batch re-runs after `cadence_ms` only while issues remain.
  Each batch is one TypeSafe request: shared state (repo, area labels, up to 20 human-labelled
  examples, ≤ 1500-char excerpts) × 6–7 questions per issue. Usage is written to `run` and logged.
  Open pull requests follow in batches of ≤ 8 with two questions each: **review effort** (a Score
  over four rubric levels, judged from files, diff shape and description) and **reviewer** (a
  Choice over ≤ 5 candidates the code shortlisted by directory overlap, recency and volume, plus
  `none`). The model judges expertise only; load balancing runs in the browser
  (`assignReviewers`) over the stored probabilities, so it changes no inference.
- **Feedback** (`mutators.feedback.set`): append-only rows; the effective value of a field is the
  latest human row, else the latest model row at the current `questions_version`. The server
  override of the mutator pokes the worker; the model's rows are refreshed, never overwritten.
- **Recalculate**: "flag" marks the filtered issues; "version" bumps `questions_version` so every
  issue gets new rows (old ones stay for comparison).
- **Priority** = user-weighted sum of severity, urgency, reactions, comments and age; sliders
  change no inference. Pull requests use a fixed attention policy (`pullAttention`): approved and
  mergeable first, then awaiting review (older and quicker first), then changes requested, drafts
  last.
- **Presence**: heartbeat mutator every 15 s; rows older than 45 s are ignored by clients.

### Conflict rule

Feedback is append-only and keyed by a client-generated id, so concurrent edits never conflict:
the newest row wins for display and every row stays in the history. Repo knobs are last-writer-wins
through Zero's rebase.

### Measured cost (jev-1.13.0, voidzero-dev/vite-plus)

| Batch     | Questions | Input tokens | Output tokens | Latency    |
| --------- | --------- | ------------ | ------------- | ---------- |
| 20 issues | 124–128   | 25.0K–27.5K  | 4.8K–5.0K     | 350–810 ms |

| 8 pulls | 16 | 16.5K–17.2K | ~2K | 255–275 ms |

About 205 input tokens per question including the amortised state (issue bodies are the bulk).
Pull batches are capped at 8 because a 20-pull request (files plus candidate histories) exceeded
the model's window.
Set `TYPESAFE_PRICE_INPUT_PER_MTOK` / `TYPESAFE_PRICE_OUTPUT_PER_MTOK` to see dollars in the UI.
Per-repo `budget_tokens` stops the worker; raise it in Settings to continue.

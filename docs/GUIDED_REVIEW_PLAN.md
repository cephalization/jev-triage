# Guided review: plan

Open a pull request from the Pull requests view and generate a guided review: an ordered
walkthrough of the change, core logic first, glue and churn last, each step with a short
narrative and its files. The review is generated once and shared; every viewer sees the same
steps and tracks their own progress. Inspired by Linear Diffs; the generation approach is lifted
from the `overfactor` daemon, with two additions it did not have: a jev classification pass over
the diff to seed the groupings, and server-side provider and model configuration shared by the
team.

Nothing is written back to GitHub in any phase.

## Phases

| Phase | Deliverable                                                               | Status   |
| ----- | ------------------------------------------------------------------------- | -------- |
| 1     | Real authentication: GitHub sign-in, admin from env, allowlist invites    | done     |
| 2     | Providers and models: shared, server-side, keys encrypted, chosen per run | building |
| 3     | Review environment: fetch the PR, run a headless agent, store the result  |          |
| 4     | jev pass over the diff: per-file role, risk and attention, seeds grouping |          |
| 5     | Review UI: step rail, per-step diffs, shared review, personal progress    |          |
| 6     | Regeneration on new commits, cost accounting, hardening                   |          |

Each phase ends with something a person can use, and each keeps the standing rules: secrets
only in `apps/api`, state streams through Zero rows, policy in code, tests offline.

## Phase 1: authentication

**Goal.** Only invited GitHub accounts can use the app. One or more admins come from env; admins
invite others by GitHub login. Agents and tests can sign in without a browser or a real GitHub
account.

**Identity.** A user is a GitHub account. `user.id` becomes `gh_<github numeric id>`; the row
also stores `login`, `avatar_url`, `role` (`admin` | `member`) and `last_login_at`. Existing
`u_…` rows from the removed dev login stay as history behind old feedback.

**Two ways in, one resolver.**

1. GitHub OAuth web flow: `GET /api/auth/github/start` redirects to authorize; the callback
   exchanges the code, fetches `/user`, resolves the account, and redirects back to the app
   with the session token in the URL fragment.
2. Token sign-in: `POST /api/auth/token {token}` fetches `/user` with that token and resolves
   the same way. This is how a coding agent, a test, or a person with a personal access token
   signs in. The login page offers it behind a disclosure.

Both call `resolveAccount(login, githubId)`: allowed if the login is in `ADMIN_GITHUB_LOGINS`
(role admin) or has an `invite` row (role from the invite); otherwise denied with a clear
message. On first sign-in the invite is marked accepted and the user row is created.

**Allowlist.** `invite(login primary key, role, invited_by, created_at, accepted_at)`. Admins
manage it from System → People through two mutators (`invite.add`, `invite.remove`) whose
server side checks the caller's role. The invites query returns rows only to admins.

**Sessions.** Unchanged shape: a 30-day HS256 JWT minted by the API and passed to Zero, now
carrying `login`, `role` and `avatar`. The API stays stateless. Removing an invite does not
revoke a live session; that is a phase 6 item if it matters.

**GitHub without GitHub.** `GITHUB_API_URL` and `GITHUB_OAUTH_URL` default to github.com and can
point at the emulate.dev GitHub emulator (`npx emulate start --service github --port 4001`,
seeded from `emulate.config.yaml`). The emulator issues a seeded token per user, so token
sign-in works with no browser and no real account; the OAuth flow also resolves against it.
The API integration tests use the emulator programmatically.

**Not in this phase.** GitHub App installation, org membership checks, per-repo access, and the
existing dev name login, which is removed.

## Phase 2: providers and models

Shared configuration, edited in System by admins, readable by everyone, keys never leaving the
server.

- `provider(id, kind, label, base_url, key_hint, models_json, …)` is replicated like any other
  row; the key is sealed with AES-256-GCM under `CONFIG_SECRET` into `private.provider_key`, a
  schema Zero does not publish, so it never reaches zero-cache or a browser. Kinds:
  `anthropic`, `openai`, `openrouter`, `openai-compatible` (custom base URL).
- Provider rows are edited through admin-only mutators; the key goes through
  `PUT /api/providers/:id/key` and is shown only as its last characters. Removing a provider
  drops the key too.
- Models are fetched from the provider's `/models` endpoint with the stored key
  (`POST /api/providers/:id/models`) and kept in `models_json` with an enabled flag, so admins
  can hide the long tail. They can also be typed by hand for proxies that list nothing.
- A per-repo default provider and model (`repo.review_provider_id`, `repo.review_model`) that
  anyone can set from System → Guided reviews; a run may override it.
- `resolveProvider(id)` on the server hands a runner the base URL, the env var its CLI expects
  and the plaintext key, and nothing else ever sees it.

## Phase 3: review environment

A `review` job fetches the pull request at its head commit and runs a headless agent over it.

- **Runner interface.** `ReviewRunner.run({repo, headSha, patch, prompt, provider, model})` →
  JSON. The first runner is a subprocess in a temporary checkout on the API host: shallow
  fetch of the PR head with the repo's GitHub token, then `pi -p --no-session --no-tools` (or
  `--tools` limited to read-only file access) with the provider key injected into the child's
  environment only. Ten-minute timeout, one run in flight per pull request.
- **Sandboxing.** The subprocess runner is the phase 3 deliverable. A container-backed runner
  (Docker) is the intended second implementation behind the same interface. celld runs Workers
  and Durable Objects, not processes; unless it grows an exec surface it is not the sandbox for
  git plus a CLI agent, so the plan does not depend on it. Revisit when choosing the second
  runner.
- **Prompt.** Port `buildReviewPrompt` and `renderPatchForReview` from overfactor: a complete
  file manifest, diff bodies under a character budget with stub lines for what is omitted,
  intent from the PR title and body, previous groups for stable regeneration, Simplified
  Technical English, two to ten ordered steps, core first, churn last. Validate with zod and
  retry once with the error folded in.
- **Storage.** `review(id, pull_id, repo_id, head_sha, status, provider, model, groups_json,
patch, error, input_tokens, output_tokens, created_by, started_at, finished_at)`. Progress is
  streamed through the row (status, step) so every viewer watches the same generation.

## Phase 4: jev over the diff

The agent writes narrative; jev supplies structure it can rely on, cheaply and reproducibly.

- Code splits the patch into files and hunks. Per file, one TypeSafe request per pull asks:
  `role` (Choice: core logic, supporting change, tests, configuration or build, generated or
  vendored, documentation, formatting only), `risk` (Score over four levels), `attention`
  (Score: how much a reviewer needs to read this), and `entry_point` (Noul: does understanding
  the change start here).
- `groupSeed()` in `packages/triage` turns those answers into an ordered proposal: entry points
  and core logic first, supporting changes next, tests, then configuration, generated and
  formatting last. The proposal goes into the agent prompt as `<classification>`; the agent may
  merge or reorder but must place every file. If the agent fails, the proposal alone is served
  as a review with generic step titles, so a review always exists.
- Answers are stored as `classification` rows against the pull with kind prefixes, versioned
  like everything else, and shown in the review UI as the reason a file sits where it does.

## Phase 5: review UI

- From the pull panel: "Generate guided review" (or "Regenerate" when the head moved), with the
  provider and model picker defaulting to the repo's choice.
- A review route inside the app: left rail with step counter, title and narrative, file chips,
  previous and next, "Mark reviewed"; right pane with that step's diffs, low-signal files
  collapsed. Diff rendering with a proven component rather than a hand-rolled one.
- Shared review, personal progress: `review_progress(review_id, user_id, group_key,
reviewed_at)`. Everyone sees the same steps; each person's checkmarks are their own, and the
  rail shows who has finished which steps.
- Files changed since generation appear as a synthetic final step until someone regenerates.

## Phase 6: regeneration, cost, hardening

- Regenerate when the PR head changes; keep prior reviews for comparison, like classification
  versions.
- Per-review token accounting into `run` rows and the System spend tile; a per-repo review
  budget.
- Session revocation on invite removal; rate limits on generation; audit of who generated what.

## Testing

- Pure functions (`resolveAccount`, prompt rendering, `groupSeed`, group normalisation) get
  canned-input tests in their packages.
- The API's auth routes are tested against the emulate.dev GitHub emulator started in-process
  from the test file, so no network or real account is needed.
- Runners are tested with a fake `pi` on `PATH` that echoes a fixture; the real CLI is exercised
  manually.

# typeful-triage

A multiplayer triage dashboard for public GitHub repositories. Issues and pull requests sync
into Postgres, [Rocicorp Zero](https://zero.rocicorp.dev) replicates them live to every
browser, and a [TypeSafe System One](https://docs.typesafe.ai) model answers a fixed set of
typed questions about each one: what kind of issue it is, how severe, how urgent, whether it
duplicates another, and above all **what a maintainer should do next**. People confirm or
correct those answers, claim issues, and mark them done; every correction is kept and shown
to the model on later runs.

Nothing is written back to GitHub. The app is a shared view over a repository, not a bot.

## What you see

- **Triage** groups open issues by the suggested next step: ask the author, reply with an
  answer, investigate, needs a decision, accept into the backlog, close, or waiting. Marking an
  issue done clears it from the queue. Claiming it shows who is on it.
- **Unsure** lists issues the model was not confident about, or where a person disagreed with
  it, least confident first.
- **Pull requests** are ordered by attention (approved and mergeable first, drafts last), with
  an estimated review effort and a suggested reviewer drawn from the repository's review history
  and balanced across people.
- **Repo** shows maintainer-facing health: queue size, who has what, next steps, categories,
  severity, reviewer load.
- **System** holds the operator side: token spend, cost controls, worker state, and model
  calibration against human feedback.

Keyboard: `j`/`k` or arrows move, `Esc` closes the panel, `a` accepts the suggestion and marks
the issue done, `c` claims, `x` toggles done, `1`–`6` set the category, `/` searches,
`g` then `t`/`u`/`p`/`r`/`s` switches views.

## Requirements

- [Vite+](https://viteplus.dev): `curl -fsSL https://vite.plus | bash` (Windows:
  `irm https://vite.plus/ps1 | iex`). Node and the package manager are pinned in `package.json`
  and fetched by Vite+ on first use, so nothing else needs to be installed.
- A Docker-compatible CLI that provides `docker compose` (Docker Desktop, OrbStack, Podman with
  the docker shim), for Postgres and for Arize Phoenix, which traces every guided review.
- A TypeSafe API key ([docs.typesafe.ai](https://docs.typesafe.ai)).
- Optionally a GitHub token, for pull request sync and higher API rate limits.
- Optionally [celld](https://celld.dev) (`curl -fsSL celld.dev/install.sh | sh`). When it is on
  the PATH, `vp run dev` also starts the guided-review environment (`apps/reviewer`); without
  it, reviews run inside the API process.

## Quick start

```sh
git clone https://github.com/cephalization/jev-triage
cd jev-triage
cp .env.example .env     # set TYPESAFE_API_KEY, and GITHUB_TOKEN if you want pull requests
vp install
vp run dev               # postgres (docker) + migrations + api + zero-cache + web
```

Open http://localhost:5173, sign in with GitHub, open the repository switcher and add
`owner/name`. Issues sync newest first and get their suggestions within a few seconds.

## Signing in

Access is invite only. Set `ADMIN_GITHUB_LOGINS` in `.env` to your GitHub login; admins listed
there can always sign in and can invite other GitHub accounts from System → People, choosing a
role for each. Two ways in:

- **Continue with GitHub**: create a GitHub OAuth app whose callback is
  `APP_URL/api/auth/github/callback` (`http://localhost:5173/api/auth/github/callback` locally)
  and put its id and secret in `.env`.
- **A GitHub token**: paste a personal access token on the login page. It is used once to look
  up your login and is not stored. This is also how agents and scripts sign in
  (`POST /api/auth/token {"token"}`).

### Without a GitHub account

For offline or agent-driven development, start everything with sign-in pointed at the
emulate.dev GitHub emulator instead of github.com:

```sh
vp run dev:emulate
```

That runs the normal stack plus the emulator (seeded from `emulate.config.yaml` on port 4001)
and makes `admin` an admin. Sign in with the token `gho_test_token_admin`, or through
"Continue with GitHub", which shows a user picker instead of a password. Repository sync still
uses real GitHub, so real repositories work as usual. The API's auth tests start the emulator
in-process. The pieces are also available separately: `vp run emulate` starts only the emulator,
and the `GITHUB_*_URL` variables in `.env.example` do the pointing by hand.

The Postgres container listens on port 5433 so it does not clash with a local install. Change
`ZERO_UPSTREAM_DB` in `.env` and the port mapping in `docker-compose.yml` together if you need
another.

## Configuration

Everything lives in `.env`, which is never committed. See `.env.example` for the full list.

| Variable                         | Purpose                                                        |
| -------------------------------- | -------------------------------------------------------------- |
| `TYPESAFE_API_KEY`               | Classification. Without it the app syncs but never classifies. |
| `GITHUB_TOKEN`                   | Server token for pull request sync and higher rate limits.     |
| `AUTH_SECRET`                    | Signs session tokens.                                          |
| `CONFIG_SECRET`                  | Seals provider API keys at rest. Defaults to `AUTH_SECRET`.    |
| `ADMIN_GITHUB_LOGINS`            | Comma-separated GitHub logins that are always admins.          |
| `GITHUB_CLIENT_ID` / `_SECRET`   | The GitHub OAuth app for "Continue with GitHub".               |
| `APP_URL`                        | Where the browser reaches the app; builds the OAuth callback.  |
| `GITHUB_API_URL` / `_OAUTH_URL`  | Default github.com; point both at an emulator for offline use. |
| `TYPESAFE_PRICE_INPUT_PER_MTOK`  | Price per million input tokens, shown as spend. Preset.        |
| `TYPESAFE_PRICE_OUTPUT_PER_MTOK` | Price per million output tokens. Preset.                       |

Per-repository knobs live in the System view and are shared by everyone: pause, batch size,
cadence, sync caps, and a token budget that stops the worker when reached. Defaults are
deliberately small (100 issues) so trying a large repository costs cents, not dollars.

## Layout

| Path              | What                                                                           |
| ----------------- | ------------------------------------------------------------------------------ |
| `apps/web`        | React dashboard (Vite+, shadcn/ui, Zero client)                                |
| `apps/api`        | Hono server: Zero query and mutate endpoints, GitHub sync, classifier worker   |
| `apps/reviewer`   | Guided-review environment: a celld cell running the pi SDK against a provider  |
| `packages/schema` | Zero schema, client-safe mutators, synced queries, effective-value helper      |
| `packages/triage` | TypeSafe question builders, the pure `decide()` policy, priority, calibration  |
| `db/migrations`   | Plain SQL, applied in order by `vp run migrate` (and on every `vp run dev`)    |
| `docs`            | `ARCHITECTURE.md`: data model, flows, question design, and the rules behind it |

## Development

```sh
vp check --fix   # format, lint, type-check
vp run -r test   # unit tests in every package
vp run migrate   # apply new SQL migrations to the running database
```

The API restarts on every save; the web app hot-reloads. Question builders and policy are pure
and tested with canned answers, so no network is needed for the test suite.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how sync, classification, feedback and the
triage queue fit together, and `CLAUDE.md` for the working rules if you use a coding agent.

## Traces

`vp run dev` also starts [Arize Phoenix](https://arize.com/docs/phoenix) from the compose file
on http://localhost:7006. Every guided review is one trace there, following the OpenInference
conventions: the review, each stage, every jev request with its state and answers, every model
turn with its messages, tokens and cost, and every tool call with what it read. Set
`PHOENIX_COLLECTOR_ENDPOINT` to send traces elsewhere, or leave it unset to send none.

## Guided reviews

Open a pull request, press "Generate guided review", then "Open review". jev classifies every
changed file (role, risk, how carefully to read it, whether the change starts there), the
configured model writes an ordered walkthrough on top of that proposal, and the review screen
walks you through it step by step with the diffs. The review is shared; the checkmarks are
yours. Providers, keys and the default model live under System, for admins.

## License

[MIT](LICENSE).

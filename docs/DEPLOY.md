# Deploying

`vp run dev` is the local stack. This is the same app as a set of containers, on Railway or
anywhere Docker runs. Nothing in the code knows which it is: every address comes from the
environment with local defaults (`apps/api/src/urls.ts`), the web app asks the API where
zero-cache is at boot, and on Railway the platform's own variables fill in the public and
private addresses so a deployment types only secrets and the names of its other services.

## Pieces

| Service           | Runs                                                         | Reachable from   | Keeps state in          |
| ----------------- | ------------------------------------------------------------ | ---------------- | ----------------------- |
| `triage-postgres` | Postgres 18 with `wal_level = logical`                       | private network  | its volume              |
| `triage-api`      | `apps/api/Dockerfile`: the API, serving the built web app    | public: the app  | Postgres                |
| `triage-zero`     | image `rocicorp/zero:1.9.0`, the version in `pnpm-lock.yaml` | public: browsers | volume for the replica  |
| `triage-reviewer` | `apps/reviewer/Dockerfile`: the celld cell                   | private network  | volume at `/app/.celld` |
| Phoenix           | optional, any instance; traces of guided reviews             | private network  | its own database        |

The API image runs one process on one origin: `/api/*` is the API and everything else is the
web build, so there is no CORS story and `APP_URL` is the only public address to name. Zero
needs its own public address because browsers open a WebSocket to it; the API hands that
address to the web app through `/api/health`, so the web build is the same everywhere.

Both Dockerfiles build from the repository root:

```sh
docker build -f apps/api/Dockerfile -t typeful-api .
docker build -f apps/reviewer/Dockerfile -t typeful-reviewer .
```

Run `node src/db/migrate.ts` from `/app/apps/api` inside the API image before its first
start and after every upgrade; on Railway that is the pre-deploy command in
`apps/api/railway.json`.

## Railway

One project, one environment, the five services above. The CLI does all of it once the
project is linked (`railway link`); service IDs come from `railway status --json`. Two
platform details matter: Railway health checks probe the port named by a `PORT` variable, so
every service sets one, and the builder refuses a Dockerfile with a `VOLUME` instruction, so
volumes are attached on the platform only.

### 1. Postgres

`railway add --database postgres`, then rename it `triage-postgres` (the CLI cannot rename;
`serviceUpdate` in the GraphQL API can). Zero replicates through logical decoding, so before
zero-cache first connects, on the database:

```sql
ALTER SYSTEM SET wal_level = 'logical';
```

Run it from the service's query tab in the dashboard, or with `railway ssh --service
triage-postgres -- psql -U postgres -c "..."` once `railway ssh keys add` has registered a
key, then `railway restart --service triage-postgres --yes`. Keep the TCP proxy off; nothing
outside the project needs the database.

### 2. Shared secrets

Generate three values and keep them as shared variables so two services can reference them:

```sh
openssl rand -base64 32   # AUTH_SECRET: signs sessions; rotating signs everyone out
openssl rand -base64 32   # CONFIG_SECRET: seals provider keys at rest; keep separate from AUTH_SECRET
openssl rand -hex 32      # REVIEWER_TOKEN: the API ↔ cell link; required off-machine
```

### 3. The reviewer cell

`railway add --service triage-reviewer`, a volume with
`railway volume --service <id> add --mount-path /app/.celld`, no public domain, and the
build and deploy settings from `apps/reviewer/railway.json` (either name that file as the
service's config path in the dashboard, or patch the same keys with
`railway environment edit --json`). Variables:

| Variable         | Value                        |
| ---------------- | ---------------------------- |
| `REVIEWER_TOKEN` | `${{shared.REVIEWER_TOKEN}}` |
| `PORT`           | `9876`                       |

The image runs celld's single-node mode on the volume: one node, no bucket. It listens on
every interface because Railway's private network is IPv6 only, and it refuses every request
without the token. `CELLD_HANDLER_BUDGET_S` and `CELLD_FETCH_TIMEOUT_S` are set in the image
to 1800 as in the compose file.

### 4. zero-cache

`railway add --service triage-zero` with no image yet, a volume at `/data`, a public domain
from `railway domain --service triage-zero --port 4848`, the variables below, and only then
`railway environment edit --service-config triage-zero source.image rocicorp/zero:1.9.0`, so
the first start already has its configuration and Postgres already has `wal_level` set:

| Variable                | Value                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `ZERO_UPSTREAM_DB`      | `${{triage-postgres.DATABASE_URL}}`                                                                        |
| `ZERO_REPLICA_FILE`     | `/data/zero.db`                                                                                            |
| `ZERO_PORT`, `PORT`     | `4848`                                                                                                     |
| `ZERO_QUERY_URL`        | `http://triage-api.railway.internal:3939/api/query`                                                        |
| `ZERO_MUTATE_URL`       | `http://triage-api.railway.internal:3939/api/mutate`                                                       |
| `ZERO_ADMIN_PASSWORD`   | a random value; guards the inspector and `/statz`                                                          |
| `ZERO_NUM_SYNC_WORKERS` | `2`; the default is the host's core count, which on Railway exceeds the upstream pool and aborts the start |
| `ZERO_LOG_LEVEL`        | `warn`                                                                                                     |

Use `/keepalive` as the health check with a long timeout: the first start copies every table
into the replica. Keep it at one replica; a second instance would fight for the replication
slot. Zero forwards each client's session token to the API, which verifies it; zero-cache
itself needs no secret.

### 5. The API

`railway add --service triage-api`, a public domain from
`railway domain --service triage-api --port 3939`, and the build and deploy settings from
`apps/api/railway.json` (config path or `environment edit`, as for the cell). Deploy with
`railway up --service triage-api` from the repository root. Variables:

| Variable                                                          | Value                                                             |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| `API_PORT`, `PORT`                                                | `3939`                                                            |
| `ZERO_UPSTREAM_DB`                                                | `${{triage-postgres.DATABASE_URL}}`                               |
| `ZERO_CACHE_URL`                                                  | `https://${{triage-zero.RAILWAY_PUBLIC_DOMAIN}}`                  |
| `AUTH_SECRET`                                                     | `${{shared.AUTH_SECRET}}`                                         |
| `CONFIG_SECRET`                                                   | `${{shared.CONFIG_SECRET}}`                                       |
| `ADMIN_GITHUB_LOGINS`                                             | your GitHub login; admins need no invite                          |
| `GITHUB_CLIENT_ID` / `_SECRET`                                    | a GitHub OAuth app, see below                                     |
| `GITHUB_TOKEN`                                                    | a fine-grained token with read-only access to public repositories |
| `TYPESAFE_API_KEY`                                                | from docs.typesafe.ai                                             |
| `TYPESAFE_PRICE_INPUT_PER_MTOK`, `TYPESAFE_PRICE_OUTPUT_PER_MTOK` | as in `.env.example`                                              |
| `REVIEW_CELL_URL`                                                 | `http://triage-reviewer.railway.internal:9876`                    |
| `REVIEWER_TOKEN`                                                  | `${{shared.REVIEWER_TOKEN}}`                                      |
| `PHOENIX_COLLECTOR_ENDPOINT`                                      | optional, see Phoenix below                                       |
| `PHOENIX_API_KEY`                                                 | optional, see Phoenix below                                       |

Left unset, `APP_URL` becomes `https://` plus the service's `RAILWAY_PUBLIC_DOMAIN`, and the
cell's address for this API becomes the service's `RAILWAY_PRIVATE_DOMAIN` on `API_PORT`.
Set `APP_URL` yourself only for a custom domain. The API refuses to start when
`REVIEW_CELL_URL` is off-machine and `REVIEWER_TOKEN` is missing.

The pre-deploy command runs the migrations; the health check is `/api/health`, which also
answers with a Postgres round trip.

### 6. GitHub sign-in

In GitHub, Settings → Developer settings → OAuth apps → New: the homepage is the API's public
URL and the callback is that URL plus `/api/auth/github/callback`. Put the id and secret on
the API service. Until then, the login page's token field works with a personal access token.

Sign in, open System → People: your login from `ADMIN_GITHUB_LOGINS` is an admin, and every
other account needs an invite from there.

### 7. Phoenix

Any Phoenix reachable from the API and the cell works, including one another project in the
workspace already runs. With authentication on, create an API key in its settings and set on
the API service:

| Variable                     | Value                                  |
| ---------------------------- | -------------------------------------- |
| `PHOENIX_COLLECTOR_ENDPOINT` | `http://phoenix.railway.internal:6006` |
| `PHOENIX_API_KEY`            | the key                                |

Both the API and the cell send the key as a bearer token; the cell's collector address defaults
to the same endpoint because it is not a loopback address. Traces hold diffs, file contents and
model messages, so keep the instance authenticated or off the public internet.

Phoenix prices only models it knows. Once, from anywhere that reaches it:

```sh
PHOENIX_COLLECTOR_ENDPOINT=https://<phoenix domain> PHOENIX_API_KEY=<key> \
TYPESAFE_PRICE_INPUT_PER_MTOK=0.042 TYPESAFE_PRICE_OUTPUT_PER_MTOK=0 \
node scripts/phoenix-seed.mjs
```

### Order and checks

Postgres and `wal_level` first, then the cell, then zero-cache, then the API. Confirm with:

```sh
curl https://<api domain>/api/health          # ok, typesafe, github, auth.github
railway logs --service triage-zero --lines 50  # "replication ... ready" after the initial copy
```

Every deploy of the API restarts its worker: whatever was syncing, classifying or reviewing is
marked "interrupted by a server restart" and picked up again, as on every local restart.

## Elsewhere

The same images run under any orchestrator: give the API `ZERO_UPSTREAM_DB`, `APP_URL`,
`ZERO_CACHE_URL`, the secrets and `REVIEW_CELL_URL` plus `REVIEWER_TOKEN`; give zero-cache the
upstream, a volume and the API's `/api/query` and `/api/mutate`; give the cell the token and a
volume. Only `APP_URL` and the cell's `REVIEW_CELL_API_URL` need naming by hand when there is
no Railway to derive them from.

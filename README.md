# Multi-Chats

**English** · [简体中文](README_zh.md)

A self-hosted workspace for configuring AI Employees, organizing them into Groups, and collaborating on Tasks in Conversations.

![The Conversation Center: a conversation with mentioned Employees, each replying in the thread, and its Tasks, Artifacts, and Run timeline alongside.](docs/images/conversation.png)

## Screenshots

| Discussions | Employees |
| --- | --- |
| ![A Discussion in review: Participants with their roles, per-Round phase progress, the token and cost budget, and the versioned Brief with its recommended option and evidence index.](docs/images/discussion.png) | ![Employees: each Employee binds a model configuration and a set of Skills, with ordered fallback targets.](docs/images/employees.png) |
| **Groups** | **Skills** |
| ![Groups: reusable member templates that new Conversations copy their membership from.](docs/images/groups.png) | ![Skills: declarative instructions and Tool allowlists, built-in or operator-authored.](docs/images/skills.png) |
| **Tools** | **Providers** |
| ![Tools: the registry every external action must exist in before a Skill can call it, showing built-in and registered Tools with their risk, approval, and replay posture.](docs/images/tools.png) | ![Providers: stored credentials for the model Providers that Employees run on.](docs/images/providers.png) |

## Development

Requirements:

- Node 22 (`nvm use`)
- Docker only when running the PostgreSQL-backed stack

Local development defaults to SQLite at `.data/multi-chats.sqlite`.

```bash
npm install
npm run db:migrate
npm run dev
```

Run the worker in a second terminal:

```bash
npm run worker
```

Set `MODEL_MODE=fake` to use deterministic test responses instead of a model provider.

The UI supports English and Chinese. The initial language comes from the `locale` cookie or the browser's `Accept-Language` header, and can be changed from the sidebar.

## PostgreSQL

Set `DATABASE_URL` to switch the same application and worker to PostgreSQL:

```bash
DATABASE_URL=postgres://multi_chats:multi_chats@localhost:5432/multi_chats npm run db:migrate
DATABASE_URL=postgres://multi_chats:multi_chats@localhost:5432/multi_chats npm run worker
```

## Deployment

Deploy the self-hosted stack with Docker Compose. It starts three services —
PostgreSQL, the web process, and the worker — and both application services run
migrations before they start.

### Requirements

- Docker with Compose v2
- A persistent `APP_ENCRYPTION_KEY`

`APP_ENCRYPTION_KEY` encrypts the Provider credentials stored in the Workspace.
It is never baked into the image, so the same key must be present on every
start: rotate or lose it and the stored credentials can no longer be decrypted.

### 1. Get the code

```bash
git clone https://github.com/sihuayin/multi-chats.git
cd multi-chats
```

### 2. Set the encryption key

Either export it for the Compose invocation:

```bash
export APP_ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

or persist it in `.env` beside `docker-compose.yml`, which Compose reads for
variable substitution and `.dockerignore` keeps out of the image:

```bash
printf 'APP_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)" >> .env
```

Compose falls back to a development placeholder when the key is unset. That
placeholder is public, so set a real key for anything other than a local trial.

### 3. Build and start

```bash
docker compose up --build -d
```

### 4. Check that it is up

```bash
docker compose ps
curl -s http://localhost:3000/api/health
```

The health response reports both processes:

```json
{"status":"ok","database":"ok","worker":"ok","workspaceId":"..."}
```

`status` is `ok` only while the worker heartbeat is under 15 seconds old, so a
stopped worker turns the web container unhealthy instead of failing silently.
The Compose health check reads the same endpoint.

Then open <http://localhost:3000> and add the model Providers the Employees run
on under **Providers**.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEB_PORT` | `3000` | Host port for the web UI |
| `POSTGRES_PORT` | `5432` | Host port for PostgreSQL |
| `MODEL_MODE` | `pi` | Set to `fake` for deterministic responses that call no Provider |
| `WORKER_POLL_INTERVAL_MS` | `1000` | How often the worker polls for work |
| `APP_ENCRYPTION_KEY` | development placeholder | Required in production; see step 2 |

Set these in the shell or in `.env` beside `docker-compose.yml`.

Compose publishes PostgreSQL on the host port by default so that the backup
commands below work from the checkout. Remove the `ports` mapping from the
`postgres` service if the database should not be reachable from outside the
Compose network.

### Logs and shutdown

```bash
docker compose logs -f web worker
docker compose down
```

`docker compose down` keeps the `postgres-data` volume. `docker compose down -v`
deletes it, along with every Conversation, Source, and stored credential.

### Upgrading

```bash
git pull
docker compose up --build -d
```

Both application services migrate on start, so no separate migration step is
needed. Keep `APP_ENCRYPTION_KEY` unchanged across the upgrade, or stored
credentials stop decrypting.

### Backup and restore

All state lives in the `postgres-data` volume. Back up and restore from the
checkout, pointing `DATABASE_URL` at the published PostgreSQL port:

```bash
DATABASE_URL=postgres://multi_chats:multi_chats@localhost:5432/multi_chats npm run db:backup -- backup.json
DATABASE_URL=postgres://multi_chats:multi_chats@localhost:5432/multi_chats npm run db:restore -- backup.json
```

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

Run the complete acceptance sequence with:

```bash
VERIFY_BASE_URL=http://localhost:3000 \
VERIFY_COMPOSE_PROJECT=multi-chats \
npm run verify:acceptance
```

`verify:deployment` checks health, the one-active-Run invariant, backup and
restore, service restarts, and deployment logs. Set `VERIFY_COMPOSE_START=1` to
build and start the Compose project as part of the run. Without
`VERIFY_COMPOSE_PROJECT`, only the HTTP health and active-Run checks run.

The unified real-Provider release gate is opt-in and never part of the default
commands. It runs the production-adapter smoke matrix and evaluates the
Discussion-quality report in one command:

```bash
PROVIDER_SMOKE=1 \
RELEASE_GATE_PROFILE=network_constrained \
DEEPSEEK_API_KEY=... \
SMOKE_EVIDENCE_LINK=artifact://release-gate/42 \
npm run verify:release-gate
```

`network_constrained` is the default profile and fixes primary/fallback to
`deepseek-v4-flash` and `deepseek-v4-pro`. Its report records
`crossFamilyFailoverVerified: false`, marks Anthropic and Google as unverified,
and cannot be represented as equivalent to the standard profile.
The command runs the Discussion-quality corpus automatically: four modes,
three repeats each. Set `SMOKE_QUALITY_REPORT_PATH` only to evaluate an
operator-produced report instead; that report must contain exactly three
deterministic runs covering all four corpus modes.

The standard profile requires explicit targets and a fallback covering both the
OpenAI-compatible and Anthropic families:

```bash
PROVIDER_SMOKE=1 \
RELEASE_GATE_PROFILE=standard \
SMOKE_PRIMARY_PROVIDER=openai \
SMOKE_PRIMARY_MODEL=gpt-4o-mini \
SMOKE_PRIMARY_API_KEY=... \
SMOKE_FALLBACK_PROVIDER=anthropic \
SMOKE_FALLBACK_MODEL=claude-3-5-haiku \
SMOKE_FALLBACK_API_KEY=... \
SMOKE_EVIDENCE_LINK=artifact://release-gate/42 \
npm run verify:release-gate
```

Set `SMOKE_MAX_TOTAL_TOKENS`, `SMOKE_MAX_COST_MICROS`, and
`SMOKE_PROVIDER_TIMEOUT_MS` to bound spend; the matrix stops scheduling
scenarios once a cap is reached. The cost cap needs rates to bind, so set
`SMOKE_INPUT_MICROS_PER_MILLION_TOKENS` and
`SMOKE_OUTPUT_MICROS_PER_MILLION_TOKENS` to the target's real rates instead of
leaving the conservative defaults. A single target proves every contract except
failover, which is reported as skipped, and a fallback target must cover the
OpenAI-compatible and Anthropic families so one Provider outage cannot hide a
broken adapter.

When a proxy is required, set the standard `HTTPS_PROXY`/`HTTP_PROXY`
variables for the process: the smoke matrix drives the same production
adapters as the app, so it needs no smoke-specific proxy setting.

`verify:provider-smoke` and `verify:discussion-quality` remain available for
focused diagnostics. Normal CI never sets `PROVIDER_SMOKE`, so both the unified
gate and its network calls remain skipped by default.

Backup and restore work for either storage backend:

```bash
npm run db:backup -- backup.json
npm run db:restore -- backup.json
```

The restore command validates the required Workspace collections, entity
fields, references, statuses, and supported Artifact types before replacing
the current state. The end-to-end browser test uses SQLite, `MODEL_MODE=fake`,
and deterministic Tool responses, so it requires no provider credentials or
external network side effects.

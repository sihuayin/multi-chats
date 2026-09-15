# Multi-Chats

A self-hosted workspace for configuring AI Employees, organizing them into Groups, and collaborating on Tasks in Conversations.

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

## Self-hosted deployment

Set a persistent 32-byte base64 encryption key before starting the stack:

```bash
export APP_ENCRYPTION_KEY="$(openssl rand -base64 32)"
docker compose up --build -d
```

Compose starts PostgreSQL, the web process, and the worker together. The web
health check reads `/api/health`; both application services run migrations
before starting. Override `WEB_PORT`, `POSTGRES_PORT`, or
`MODEL_MODE` through the environment when needed.

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

`verify:provider-smoke` is opt-in and never part of the default commands. It
proves the production Provider adapters against the reliable Discussion
contracts — structured output, usage capture, context pressure, compression,
retry, failover, cancellation, and Brief generation — and prints a redacted
report with its release-gate evidence:

```bash
PROVIDER_SMOKE=1 \
SMOKE_PRIMARY_PROVIDER=openai \
SMOKE_PRIMARY_MODEL=gpt-4o-mini \
SMOKE_PRIMARY_API_KEY=... \
SMOKE_FALLBACK_PROVIDER=anthropic \
SMOKE_FALLBACK_MODEL=claude-3-5-haiku \
SMOKE_FALLBACK_API_KEY=... \
SMOKE_EVIDENCE_LINK=ci://provider-smoke/42 \
npm run verify:provider-smoke
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
adapters as the app, so it needs no smoke-specific proxy setting. Paste the
printed `gate` object into the `realProvider` field of the discussion-quality
report that `npm run verify:discussion-quality` consumes to make the smoke run
part of the release gate.

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

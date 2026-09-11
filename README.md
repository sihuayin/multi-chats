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

`docker compose up --build` runs PostgreSQL, the web process, and the worker together.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

Backup and restore work for either storage backend:

```bash
npm run db:backup -- backup.json
npm run db:restore -- backup.json
```

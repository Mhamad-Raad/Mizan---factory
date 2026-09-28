# Jiyan Management

A warehouse, sales and accounts system for one factory: materials and stock valued at what each
buy cost, orders and payments in Iraqi dinars and US dollars, the companies that buy from us,
broken goods, expenses, reports with Excel export, and a complete history of every change. It
works in Kurdish (Sorani), Arabic and English, right-to-left where the language is, on phones,
tablets and desktops.

## Deploying

**[DEPLOY.md](DEPLOY.md)** takes a fresh Linux server to a running system with HTTPS and
encrypted off-site backups, step by step. You need a server with Docker, a domain, and an
S3-compatible bucket for the backups. Day-to-day operation afterwards — updates, backups,
restores, incidents — is in **[ops/runbook/README.md](ops/runbook/README.md)**.

## How it is built

| Part | Where | What |
|---|---|---|
| Web app | `apps/web` | React single-page app (Vite), served by Caddy |
| API | `apps/api` | NestJS with plain SQL on PostgreSQL; migrations in `apps/api/prisma/migrations` |
| Shared packages | `packages/*` | money (integer minor units, two currencies), ledgers, text, translations, permissions, UI components |
| Deployment | `compose.yml`, `ops/` | Docker images, Caddy, backups, the runbook |
| Decisions | `docs/DECISIONS.md` | Why things are the way they are, numbered D-001 onwards |
| Specification | `spec/` | The original specification the system was built from |

Rules that hold everywhere: money is stored as whole dinars and whole cents with the rate that
converted them, never as floating point; the ledgers and the history are append-only, so a
correction is a reversal, never an edit; every write is recorded with who, when and what
changed.

## Developing

Requirements: Node 22 or newer, pnpm 10, PostgreSQL 15 or newer.

```sh
pnpm install
cp .env.example .env                 # local development settings
pnpm db:up                           # creates the local database and its roles
pnpm db:migrate && pnpm db:seed      # structure, then the first admin
pnpm dev                             # the API and the web app together
pnpm verify                          # lint, types, translations, contrast, all tests
```

`scripts/seed-demo.mjs` fills an empty database with demo data through the API.

# Mizan — hand-off folder

Everything an implementation agent (or a developer) needs to start building, plus the client-facing summary.

| Path | What it is |
|---|---|
| `CLAUDE.md` | Rules for every agent session: how work is organised, the ten non-negotiable rules, the definition of done. Read first. |
| `KICKOFF-PROMPT.md` | The prompt to paste into the agent to start Iteration 0 (fill in the component-library path). |
| `spec/mizan-factory-system-spec-v1.2.md` | The complete specification — the source of truth (requirements, architecture, UX direction, iteration plan, self-check). |
| `spec/0-front-matter-and-change-log.md` | Conventions, table of contents, what changed in v1.1 and v1.2. |
| `spec/1-requirements.md` | Deliverable 1: raw requirement register, FRs, NFRs, permission catalog, glossary, assumptions, open questions. |
| `spec/2-architecture.md` | Deliverable 2: domain model and ERD, money/history/stock models, authorization, auth, API, frontend, reports, tests, security, deployment, traceability matrix. |
| `spec/3-ux-ui-direction.md` | Deliverable 3: principles, identity and tokens, page map, wireframes, flows, animation, typography. |
| `spec/4-iteration-plan.md` | Deliverable 4: definition of done, iterations 0–6, dependency graph, requirements per iteration, self-check. |
| `iterations/I0-…I6-*.md` | One standalone brief per iteration: reading list, definition of done, the iteration text, working order and rules. |
| `client/mizan-client-signoff-summary.md` | The four-page summary for the client: decisions needed, defaults, extras to keep or cut. |
| `docs/DECISIONS.md`, `docs/QUESTIONS.md`, `docs/PROGRESS.md` | Living files the agent maintains. |
| `.env.example` | Environment variables to fill in. |

## Before starting the agent

1. `git init` in this folder and commit it as-is.
2. Put the palette system's component library where the agent can install it, and write its path or package name into `KICKOFF-PROMPT.md`.
3. Copy `.env.example` to `.env` and fill it in (a local PostgreSQL is enough for I0).
4. Open the agent in this folder and paste `KICKOFF-PROMPT.md`.

Iteration 0 needs nothing from the client. Iteration 1 must not start before the materials workshop (open question Q-37) and the glossary tick-off (Q-26) — see `client/mizan-client-signoff-summary.md`.

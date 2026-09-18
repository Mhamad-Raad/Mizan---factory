# Progress log

Updated at every checkpoint: iteration · checkpoint · what is done · what is next · test counts · open items.

## Checkpoints for Iteration 0

`CLAUDE.md` and `KICKOFF-PROMPT.md` refer to checkpoints A–E that no brief defines (see D-002 in
`docs/DECISIONS.md`). They are defined here for I0 and mirrored per iteration afterwards.

| # | Checkpoint | Gate | Human? |
|---|---|---|---|
| A | Repository, workspaces, toolchain, CI skeleton | lint + type-check green on an empty tree | no |
| B | Kernels: `money`, `text`, `permissions`, `i18n`, `ledger` | unit tests green | no |
| C | Database migrations + API with guards, audit log, permission matrix | API integration tests green; no undecorated route | no |
| D | Frontend: identity, tokens, shell, I0 screens, preferences | screens render in 3 languages × 2 themes | **yes — identity review on a phone** |
| E | Ops: compose, staging, backups, demo script, DoD tick-off | demo script executed | no |

## I0 · Checkpoint A — done

- Monorepo on pnpm workspaces: `packages/{money,text,permissions,i18n,ledger,ui}`, `apps/{api,web}`.
- TypeScript project references, ESLint (flat) + Stylelint with `stylelint-use-logical` (rule 5), Prettier, Vitest.
- CI workflow: lint · logical-property lint · type-check · unit · API integration (PostgreSQL service) · i18n missing-key check · undecorated-route check · bundle budget.
- **Next:** checkpoint B — the five kernels with their tests.

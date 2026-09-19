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

## I0 · Checkpoint B — done

Five kernels, **143 unit tests green**, lint and type-check clean.

| Kernel | What it holds | Tests |
|---|---|---|
| `@mizan/money` | integers in minor units with a safe-integer guard; half-away-from-zero rounding; dual-currency pairs carrying the rate that filled them; the entered-currency line-total rule; document totals as sums per currency; settle-in-full in both shapes; settlement tolerance | 26 |
| `@mizan/text` | script normalisation across Arabic/Kurdish variants (32-pair table), the fuzzy keyboard pass, phone normalisation | 46 |
| `@mizan/permissions` | the catalog of 1.5.2, the three presets, the six extras with their "partly" state, implied-key expansion, the refusal when another key still implies one | 30 |
| `@mizan/i18n` | the formatting service (no `Intl` for `ckb`), Iraqi/Kurdish month and weekday names, both numeral sets, the `ckb` plural rule, Asia/Baghdad dates, `DualAmount` parts; 247 keys × 3 languages | 25 |
| `@mizan/ledger` | append-only writer with balance before/after, exact reversals (once only), live-row detection, posting-order running balance, "as of" balances | 16 |

The money tests reproduce the specification's own figures: $3,244.27 for 850 IQD/kg × 5,000 kg
(not the $3,250 a rounded unit price gives), the wireframe order at 801,250 د.ع / $611.64, the
−$381.68 adjustment of 2.4.2 and the $3,435.11 balance of 2.3.5.

**Next:** checkpoint C — migrations, the I0 API with its guards, and the permission-matrix test.

## I0 · Checkpoint C — done

Database and API. **60 API integration tests**, 25 routes, all declared.

- Migrations 0001–0005: the enum types of 2.2.2, the seven I0 tables, the indices of 2.2.5,
  and the grants that make rule 2 physical — `mizan_app` has no UPDATE or DELETE on
  `audit_log` or `login_attempts`, which a test proves against the live database.
- Auth: opaque peppered session cookie, shared-device and personal lifetimes, lock/unlock,
  five-failure lockout, CSRF double-submit, Argon2id.
- Users: create with preset and a one-time temporary password, edit under optimistic locking,
  deactivate (never delete), reset password, the permission editor, sessions.
- Every write records who, when, old → new and the note inside its own transaction.
- History: keyset pagination, own-only scoping without `history.view_all`.
- Idempotency keys are reserved *before* the work, so a double tap cannot write twice.

## I0 · Checkpoint D — done (identity review still owed by the client)

Interface. Bundle **129 kB gzipped** against a 250 kB budget; 32 contrast pairs pass AA.

- Token sheet for both themes; the measured ratios match the specification's table.
- Pre-paint script sets language, direction, theme and text size before the first frame, with
  validated fallbacks for private mode.
- Screens: Login, Lock, forced password change, Users list, New employee, User detail
  (Details · Permissions in simple mode · Activity), History, Settings.
- Logical CSS only, enforced by lint; zero physical `left`/`right` in the compiled stylesheet.

**Stop here per `KICKOFF-PROMPT.md`.** Run `pnpm dev`, open the app on a phone in all three
languages and both themes, and compare it side by side with the palette system (FR-1311).

## I0 · Review — done

`docs/REVIEW-I0.md`: nine findings, all fixed, each with a regression test. Suite: **220 tests
green** across the five kernels, the API and the web contracts.

**Next:** checkpoint E — Docker Compose, staging deployment, the backup job and WAL archiving,
then the demo script of 4.2 run on staging.

## I0 · Checkpoint E — done

Deployment, backups and monitoring.

- `compose.yml`: Caddy (TLS, the SPA, `/api` proxy) · API · PostgreSQL with WAL archiving ·
  backup container. `compose.dev.yml` runs only the database, so development stays on
  `pnpm dev`. The browser sees one origin, which is what keeps the session cookie `SameSite=Lax`
  with no cross-site exception.
- Backups: nightly dump → **verified readable with `pg_restore --list`** → AES-256 → off-host,
  pruned to 30 daily and 12 monthly, with a dead-man's-switch ping. WAL archived continuously
  with `archive_timeout=900` (RPO 15 minutes). The whole round trip — dump, encrypt, decrypt,
  restore, count — was executed against a real database, not only written
  (`ops/runbook/restore-drills.md`).
- `ops/runbook/README.md`: first deployment, ordinary deployment, rollback, backups, restore
  (including point-in-time), monitoring table and incident steps.
- CI: lint (with the logical-property rule) · types · translations · contrast · migrations ·
  route declarations · 220 tests · build · bundle budget · Playwright screenshots.
- Demo script of 4.2 is **executable** (`scripts/demo-i0.mjs`) and passes end to end: sign-in,
  employee from a preset, the "Can void" extra, History as old set → new set, a 403 for a page
  he may not open, lock → 423 → unlock, all three events in History.

## I0 — Definition of done (section 4.1)

| # | Item | State |
|---|---|---|
| 1 | Three languages, glossary terms, build fails on a missing key | ✅ 247 keys × 3, checked in CI |
| 2 | RTL verified **on a real phone** in ckb, ar and en | ⚠️ automated at 360 px in all three; **the real-phone check is owed** |
| 3 | Permissions enforced on every endpoint | ✅ 25 routes declared; matrix generated from route metadata |
| 4 | Every change in History with old → new | ✅ asserted per write path |
| 5 | Amounts through `DualAmount` with ≈ for conversions | ✅ component and formatter done; first amounts on screen are I1 |
| 6 | Both themes, all four text sizes, no overflow, contrast | ✅ screenshots, 32 contrast pairs, overflow test at 1.25 |
| 7 | Tests for money and stock logic | ✅ 143 kernel tests |
| 8 | Skeleton, empty, error and offline states | ✅ on every I0 page |
| 9 | Accessibility basics | ✅ labels, focus order, 44 px enforced by test, reduced motion |
| 10 | Demo on staging with seeded data | ⚠️ demo script passes locally; **staging needs a host and a domain** |

**I0 is complete but for two items that need you:** the real-phone RTL and identity review
(FR-1311, item 2), and a host to deploy staging to (item 10).

**Before I1:** the materials workshop (Q-37) must be settled — catalog or batches — because the
Materials page and the Profit report are built differently for each.

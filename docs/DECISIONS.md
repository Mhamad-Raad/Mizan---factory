# Decisions taken by the implementation agent

One entry per decision: date · iteration · the question · the choice · the specification section relied on.

## D-001 · 2026-09-19 · I0 · The palette component library `@factory/ui` is not available

`KICKOFF-PROMPT.md` still contains the placeholder `<PATH OR PACKAGE NAME>`; A-01 assumes the package
exists. **Choice:** build `packages/ui` locally, exporting exactly the component names listed in 2.10.11
with the behaviour described there, consuming **semantic tokens only**. When the real package arrives,
`@mizan/ui` is replaced by a re-export of `@factory/ui` plus the Mizan-specific components; no screen
changes, because no screen imports a primitive directly. Rule 9 ("never fork a component") is honoured in
spirit: nothing is forked, because there is nothing to fork yet. Blocker recorded as Q-A-01.
Relied on: 1.9 A-01, 2.10.11, NFR-12.

## D-002 · 2026-09-19 · I0 · The briefs reference checkpoints but define none

`CLAUDE.md` ("each brief has checkpoints… stop at a checkpoint marked human") and `KICKOFF-PROMPT.md`
("stop at checkpoint D (identity review)", "the plan for checkpoint A") assume named checkpoints that no
iteration brief contains. **Choice:** define A–E for I0 in `docs/PROGRESS.md`, with D as the human
identity review, matching the kickoff prompt's own description. Relied on: 4.2 acceptance criteria
(identity review with the client), CLAUDE.md.

## D-003 · 2026-09-19 · I0 · Monorepo tooling

The specification names the stack but not the workspace tool. **Choice:** pnpm workspaces with TypeScript
project references — one repository holding `apps/api`, `apps/web` and the shared kernels, so the
permission catalog, glossary and money rules are literally one source of truth shared by API and client.
Relied on: NFR-12, 2.1.

## D-004 · 2026-09-19 · I0 · Prisma schema plus hand-written SQL migrations

A-02 names Prisma. Prisma cannot express revoked privileges, sequences, partial unique indexes on
`deleted_at is null`, check constraints or the derived views. **Choice:** the Prisma schema is the typed
client; migrations are hand-written SQL under `apps/api/prisma/migrations`, which is also what lets
`mizan_app` be created without UPDATE/DELETE on the append-only tables. Relied on: 2.2.1, 2.2.5, 2.13.

## D-005 · 2026-09-19 · I0 · Money in TypeScript is `number` in minor units, not `bigint`

Rule 1 forbids floating point. Minor-unit amounts are integers; JavaScript integers are exact to 2^53,
which is 9 × 10^15 dinars — four orders of magnitude beyond the design point of NFR-13. **Choice:**
amounts are `number` in the kernel, the API and the client, guarded by `assertSafeAmount()` on every
boundary; **all arithmetic goes through `decimal.js`** and returns rounded integers, so no amount is ever
produced by floating-point division or multiplication. The database keeps `bigint`; the Prisma layer
converts with a range check. Relied on: 2.3.1, A-10, NFR-06.

## D-006 · 2026-09-19 · I0 · Identity uses the plum palette without the palette system's hex

Q-01 is unanswered, so the palette system's exact primary is unknown. **Choice:** implement the plum
token sheet of 3.2.4 verbatim; the copper fallback of 3.2.6 stays as a second token file that can be
swapped by changing one import if the palette turns out to be violet-blue. Relied on: 3.2.4, 3.2.6, A-06.

## D-007 · 2026-09-19 · I0 · Session cookie and CSRF in development over http

2.13 requires `Secure` cookies. On `localhost` over http a `Secure` cookie is dropped. **Choice:**
`Secure` is set from `NODE_ENV !== 'development'`; every other attribute (httpOnly, SameSite=Lax, path,
the double-submit CSRF header) is identical in all environments, so the production behaviour is the one
that is tested in CI (which runs with `NODE_ENV=test` over http on a loopback interface and asserts the
flag in production mode). Relied on: 2.8, 2.13.

## D-008 · 2026-09-19 · I0 · `pg` with a thin repository layer instead of Prisma

A-02 names Prisma, so this is a **deviation, not a gap**, and it is recorded as one.

The data layer this system actually needs is SQL that Prisma would carry as raw strings anyway:
the derived views of 2.2.6 (running balances over a window function, `bool_and` completeness flags,
the oldest-first purchase allocation), `SELECT … FOR UPDATE` on the counterparty row before every
ledger write (2.9.5), partial unique indexes on `deleted_at IS NULL` (2.2.1), the check constraints
of 2.2.5, and a database role that lacks UPDATE and DELETE on the append-only tables (2.13). With
Prisma, all of those live in `$queryRaw` and in hand-written migrations, and the ORM's own schema
file becomes a second description of the truth that has to be kept in step with the first.

**Choice:** `pg` with one repository class per aggregate; every SQL statement is parameterised
(2.13) and lives only in a repository, so the scope rules of 2.6.4 cannot be forgotten by a caller.
A-02's own reversal note says "any Node framework works; the ledger/money module is plain
TypeScript", and the kernels are indeed framework-free. Reversing this decision means rewriting the
repositories and nothing else — no service, controller, guard or screen imports the driver.

**Cost accepted:** no generated types for rows, so every repository maps columns to a typed
interface by hand and the API integration tests cover the mapping.

## D-009 · 2026-09-19 · I0 · Idempotency keys are reserved before the work, and that table is not history

2.2.1 lists `idempotency_keys` among the append-only tables. Storing the response only *after*
the handler ran leaves a window exactly as wide as the write itself: two copies of the same
request — a double tap on a flaky connection, which is the case FR-1305 exists for — both pass
the "have I seen this key?" check and both write. A test reproduces it.

**Choice:** reserve the key with an INSERT *before* the handler runs (the primary key decides the
race), complete it with the response afterwards, and release it if the request failed so a
corrected retry is allowed. That needs UPDATE and DELETE on this one table, granted in migration
0003. The table is a 24-hour cache of responses, not history: the tables that hold history —
`audit_log`, `login_attempts` and the three ledgers — keep their INSERT-only grants, which a test
asserts against the live database. A duplicate that arrives while the first copy is still running
waits up to five seconds for its answer and is otherwise told to try again shortly.

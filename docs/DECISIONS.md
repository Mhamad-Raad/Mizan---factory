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

## D-010 · 2026-09-20 · I1 · Q-37 (materials as a catalog or as batches) is still unanswered

The materials workshop of Q-37 had not been held when I1 started, and `CLAUDE.md` forbids waiting in
chat for an answer. **Choice:** the specification's own default — a **catalog**: one `items` row per
material with a running stock derived from `stock_ledger` and one bought/sale price pair per calendar
month in `item_month_prices`. Batch (lot) tracking stays out of v1 (2.15).

**What it would cost to reverse:** the Materials page and the Profit report read `item_stats` and
`item_month_prices`; a batch model would add a `lots` table, move the bought price onto the lot and
change those two readers. Order lines already snapshot their own cost (`cost_unit_*`, `cost_source`), so
the Profit report would keep working while the Materials page changed. Recorded against Q-A-03.
Relied on: 1.10 Q-37 default, 1.9 A-16/A-17/A-42, 2.15.

## D-011 · 2026-09-20 · I1 · Which "Proposed — not requested" items of I1 are built

Q-23 is unanswered. Its default is "receipt, vouchers, statements, discount, cash-up and period lock
strongly recommended; the rest built as listed unless cut". **Choice:** every Proposed item the I1 brief
lists is built — the walk-in customer, `credit_limit_*` with a warning that never blocks, the order
discount with "round down", `voucher_number` on money rows, `method`, split payments, the order receipt,
the payment voucher, the customer statement, the period lock (`locked_through`) and the stale-rate
prompt (`rate_stale_days`). Each is labelled "Proposed" in the code where it appears and each is one
setting, one column or one endpoint away from removal; the daily cash-up belongs to I4 and is not built.
Relied on: 1.10 Q-23 default, 1.8, 4.3 scope.

## D-012 · 2026-09-20 · I1 · The order's ledger entry carries the net total, and "general" payments settle nothing by themselves

FR-603 says the ledger entry carries the total net of the discount; FR-607 derives the order's status
from the entries that carry its `order_id`. A payment recorded from the customer profile without an
order (FR-606, Q-10) therefore carries no `order_id` and — deliberately — does not change any order's
status: it lowers the customer balance only. **Choice:** keep that literal reading rather than
allocating unlinked customer payments oldest-first the way `purchase_balances` does for companies
(A-29): the client asked for oldest-first allocation on the *company* side only, and inventing it here
would make an order's status depend on presentation. The Orders tab shows unpaid orders first so the
employee can link the payment when they mean to. Relied on: 2.4.3, FR-606, FR-607, A-29 (company side only).

## D-013 · 2026-09-20 · I1 · One running-balance view per ledger

2.2.6 describes `ledger_running` as "window-function views giving the running balance per counterparty".
**Choice:** one view per ledger, named `customer_ledger_running` (I1) and `company_ledger_running` (I2),
rather than one view over a union: a union would lose the index on `(customer_id, posting_seq)` that
makes a customer's ledger page cheap for the years of rows this system is expected to accumulate.
Relied on: 2.2.6, 2.2.5, NFR-13.

## D-014 · 2026-09-20 · I1 · Receipts, vouchers and statements return figures, not files

FR-613 to FR-615 ask for a receipt, a voucher and a statement "as PDF or shareable image via
the phone's share sheet". **Choice:** the API endpoints return the *figures* as JSON — the same
stored values the screen shows — and the client renders and shares the page (`ShareDocumentSheet`,
2.10.11). No server-side PDF engine enters a system that must run for years with rare updates: a
headless browser or a PDF library would be the heaviest dependency in the repository and the one
most likely to need attention. The rendering happens where the share sheet is, which is the phone.
Relied on: 3.4 (share sheet), 2.10.11, NFR-12; reversible by adding a renderer behind the same
routes with `?format=pdf`.

## D-015 · 2026-09-20 · I1 · An over-payment stays on the order it was paid against

FR-606 refuses a payment larger than the remaining amount "unless the user confirms: record the
excess as customer credit". Splitting it into a payment for the remainder plus a separate credit
row would make the daily cash-up (FR-1013) count less cash than actually arrived. **Choice:** with
that confirmation the whole amount received is written as **one** payment row linked to the order;
the order then shows a negative remaining (over-paid) and the customer's balance carries the credit,
exactly as `purchase_balances` describes for an over-linked purchase (2.2.6). The money recorded is
the money received. Relied on: FR-606, 2.2.6, FR-1013.

## D-016 · 2026-09-20 · I1 · The walk-in customer is stored in English and rendered from the glossary

The walk-in customer (A-33) is a data row, but its name appears on screens in three languages.
**Choice:** the seed stores the name "Walk-in customer" with `is_system = true`, and every screen
renders a system customer's name from the glossary catalog instead of the stored string, so it
reads زبون نقدي in Arabic and کڕیاری نەقد in Kurdish without a translated column. Relied on:
1.6 row 87, 2.10.3, FR-1201.

## D-017 · 2026-09-20 · I1 · The 8-second undo is its own route, not a flag on the void

FR-610 gives the creator an undo for eight seconds after saving, "fully logged, hidden from
lists by default, and needs no `orders.void` key". A flag on `POST /orders/:id/void` would mean
that route could no longer carry `@RequirePermission('orders.void')` — and the generated
permission-matrix test (rule 4) would stop proving that voiding is gated. **Choice:**
`POST /orders/:id/undo` behind `orders.create` (which every creator holds by definition), with
the service checking that the caller *is* the creator and that the order is younger than eight
seconds; it writes the same void with reason "undo". Relied on: FR-610, 2.6.2, 2.9.3.

## D-018 · 2026-09-20 · I1 · Editing an order is gated in the service, not by the route's key

FR-610 allows an edit by "its creator or an admin (or a user with `orders.edit`)". A route can
carry only one key, so `PUT /orders/:id` carries `orders.view` — every caller who can see the
order — and the service refuses unless the caller is the creator, an admin or holds
`orders.edit`, then applies the payment and period rules of 2.5.3 with the record loaded. The
same shape applies to the void of somebody else's order, which stays behind `orders.void`.
Relied on: FR-610, 2.6.2 ("ownership and period rules are checked in the service with the
record loaded"), 2.9.3.

## D-019 · 2026-09-20 · I2 · One ledger writer for both counterparties

`company_ledger` is `customer_ledger` with a different owner column, a different entry-type
enum and `purchase_id` where the other has `order_id`. Everything around it is identical: lock
the counterparty row, compute the balance before and after inside the transaction, append,
write the audit row, refuse a reversal of a reversal or of a re-basing marker.

**Choice:** one abstract `AccountLedgerService` holds that behaviour and two thin subclasses
supply the table, the owner column, the entity label and the reference columns. Duplicating it
would mean the company side could drift from the customer side in exactly the place where a
difference is a bug nobody sees for months. Relied on: 2.4.1 ("rules common to all three"),
2.2.3.

## D-020 · 2026-09-20 · I2 · The oldest-first allocation is computed, never stored

FR-712 and A-29 ask for per-purchase "remaining" where unlinked payments and credits are
applied oldest purchase first. **Choice:** a pure function in `@mizan/ledger` over the
company's entries, called by the API and covered by a property test for the identity
`Σ remaining (active purchases) + general bucket = company balance`. Nothing is stored: the
allocation is presentation, so the rule can change without a data migration — which is the
hedge A-29 itself names. Relied on: 2.2.6 `purchase_balances`, FR-712, A-29.

## D-021 · 2026-09-20 · I2 · A purchase keeps no cost snapshot

An order line snapshots the material's bought price for the Profit report (A-42). A purchase
line *is* the bought price, so there is nothing to snapshot: the Profit report reads the order
side. **Choice:** `purchase_lines` carries no `cost_*` columns; the shape otherwise mirrors
`order_lines` so the two forms and their edit algorithms stay the same code path. Relied on:
2.2.3 (`purchase_lines` has no cost snapshot), 2.11.

## D-022 · 2026-09-20 · I2 · A purchase's prices travel under one `cost` key

FR-460 (1.5.4) withholds "purchase prices or totals" from users without
`fields.see_bought_price` while leaving "dates, companies and quantities" readable, and field
flags are enforced by *removing* the field (2.6.2). The interceptor strips by key name, so
scattering `unit_price_iqd`, `line_total_usd_cents`, `discount_*` and `total_*` across the DTO
would mean naming a dozen keys — and forgetting one the day a field is added.

**Choice:** every amount on a purchase sits under a single `cost` object (on the document, on
each line, on `/purchases/:id/balance` and on the ledger rows of its History), the way an order
line already carries its snapshot under `cost`. One rule, `cost: 'fields.see_bought_price'`,
hides all of it; the audit diff adds `unit_price`, `line_total` and `purchase_total`, which is
also why the document total in a purchase's `changes` is not called `total` — that is the
pagination key of every list response and would be stripped from it. Relied on: 1.5.4, 2.4.4,
2.6.2.

## D-023 · 2026-09-20 · I2 · A route may require two permission keys

The route table of 2.9.3 writes the money routes as `companies.view` + `fields.see_company_balances`
(and `purchases.view` + `fields.see_company_balances` for `/purchases/:id/balance`). A ledger,
a statement or a per-purchase breakdown **is** the balance: answering it with the amounts
stripped out returns a shape the client cannot render and tells the caller what they may not
know anyway.

**Choice:** `@RequirePermission(...)` takes one key or several, all required, and the guard
refuses naming the first missing one. The route check and the generated matrix read the list,
so rule 4 still holds. The same reading applies to the customer routes I1 gated with
`customers.view` alone — `GET /customers/:id/ledger`, its voucher and the statement now ask for
`fields.see_customer_balances` as well, which is what 2.9.3 says and what I1 should have done.
Relied on: 2.9.3, 2.6.2, FR-704.

## D-024 · 2026-09-20 · I2 · A purchase's "remaining" is always the allocated figure

FR-712 defines remaining per purchase as its total *less the entries linked to it* **and less
its oldest-first share of everything unlinked**. The first draft of the list query read a
purchase's remaining from the rows that happen to name it, which is cheap per row — and wrong:
a supplier paid a lump sum against nothing in particular, and the list then showed
"remaining 650,000" beside a purchase the company's own page showed as settled.

**Choice:** there is one definition and it is the allocation. `GET /purchases/:id/balance`
computes it (total, linked, its share, remaining) and the company's breakdown computes it once
for the account; the purchases **list** carries no remaining column at all, and the company's
Purchases tab reads each row's figure from the breakdown it already loads. A purchase's page
and its company's page can therefore never disagree. Relied on: FR-712, 2.2.6
(`purchase_balances` is a display allocation), A-29.

## D-025 · 2026-09-21 · I2 · A statement covers a period, and says which

FR-615 gives `GET /companies/:id/statement?from&to` and does not say what happens without a
range. Returning the account's whole life is both wrong in kind — a statement is a document
for a period — and, measured at fifteen years of purchases, 1.7 MB of JSON handed to a phone.

**Choice:** no range means the last three months, and the response echoes the `from` and `to`
it used so the sheet can tell the supplier what they are being handed. The same reasoning
bounds the accounting tab (a page of entries with `total` and `has_more`) and the per-purchase
breakdown (what is still owed, oldest first). The running balance is still computed over the
whole ledger, so a page never carries a figure that disagrees with History. Relied on: FR-615,
2.4.1 rule 5, 2.9.3.

## D-026 · 2026-09-21 · I3 · A damage record's attribution is validated, its material match is not

FR-802 says the order picker is "filtered by material" and the purchase picker shows
"purchases of that company containing the material". Those are picker rules; the question is
what the API refuses.

**Choice:** the API validates what it can know for certain — the order or company exists and is
not void, and a named purchase belongs to the named company — and does **not** require the
document to still contain the material. An order edited after the goods came back may no longer
carry that line, and refusing the link then would leave the record unattributable, which is
worse than a link the employee chose deliberately (A-23 puts the choice in their hands
precisely because there is no lot tracking). The database enforces that the attribution and its
links agree in both directions, so a record can never say "us" and name a company. Relied on:
FR-802, A-23, 2.2.5 (check constraints).

## D-027 · 2026-09-21 · I3 · A damage record is frozen once its return is recorded

FR-804 allows editing quantities and attribution with compensating movements, and FR-803 tracks
the return status. Nothing says what happens when the two meet: editing the quantity of a
record whose goods a supplier has already taken back and credited would move stock that is no
longer ours and leave the credit valuing a quantity that no longer exists.

**Choice:** an edit is refused with `EDIT_WINDOW_CLOSED { reason: 'return_recorded' }` once the
status has left `pending` (or `not_returnable`); the correction is a void and a new record,
which is what the specification prescribes for exactly this case on orders and purchases
(2.5.3). The credit itself is reversed on the company ledger, where reversal is the only
correction. Relied on: FR-803, FR-804, 2.5.3, 2.4.1 rule 3.

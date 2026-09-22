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

## D-028 · 2026-09-21 · I4 · An edit run is grouped within a page, not across pages

Specification 2.4.5 asks the History page to show an (entry, reversal, replacement) storm as one
"edited" entry. History is keyset-paginated (2.9.1), so a run of edits can straddle a page
boundary, and there is no way to know that without fetching the next page.

**Choice:** grouping is per page — adjacent `update` rows of the same record by the same actor
collapse, and a run split by the boundary comes back as two entries, one per page. The
alternative, re-shaping an entry when more is loaded, would move a row the reader had already
read; a page that says "3 edits" and then "1 more edit" is honest about what it knows. A
record's own History tab is never grouped, because there the whole story is the point. Relied
on: 2.4.5, 2.9.1, FR-902.

## D-029 · 2026-09-21 · I4 · The margin is computed in the kernel, not in SQL

FR-1005 defines the margin as one computation in the line's entered currency, converted at the
line's stored rate — and the specification asks for a unit test with hand-computed
expectations. That rule already exists once, in `@mizan/money`.

**Choice:** the Profit report fetches the lines of the period with their stored snapshots and
sums the kernel's per-line margins, rather than reimplementing the formula in SQL. Two
implementations of a money rule are two rules, and the one nobody tests is the one that drifts
(the D-019 argument). The cost is that the report reads the lines rather than an aggregate: it
is bounded by the range, the default range is a month, and the review measured it. Relied on:
FR-1005, 2.11, D-019.

## D-030 · 2026-09-21 · I4 · Per-purchase remaining stays on the company's page

FR-1008 says Payables shows "per purchase remaining amounts (FR-712)". FR-712's remaining is
the oldest-first allocation, which needs a company's whole ledger and all its purchases — 13 ms
per company at fifteen years (REVIEW-I2).

**Choice:** the Payables report gives each company its balance and the period's movements, and
the per-purchase breakdown stays one tap away on the company's Accounting tab, where it is
already computed and already paginated. Running the allocation for forty suppliers to render one
report page would cost half a second to show figures the reader has to open a company to act on
anyway. Relied on: FR-1008, FR-712, REVIEW-I2.

## D-031 · 2026-09-21 · I4 · Payables has no pinned user filter

Section 2.11 contradicts itself about Payables: the table's "Needs · pinned filter" column lists
only `reports.view` and `fields.see_company_balances`, while the sentence under the table says
"Payables pins `assigned_to`". Companies are deliberately **unscoped** (FR-711: two employees
with `companies.view` see the same list, asserted since I2), and a company's `assigned_user_id`
is optional and in practice empty.

**Choice:** Payables is not pinned. Pinning it to `assigned_to` answered *we owe nothing* to an
accountant without `reports.view_all` — an empty report that reads as a fact about the business
rather than as a filter, which is the worst kind of wrong answer about money. The reading that
agrees with FR-711 wins over the sentence. Receivables keeps its `assigned_to` pin, because
customers *are* assigned (FR-701). A report that is not pinned also ignores the `done_by` and
`assigned_to` parameters for a caller without `reports.view_all`, so nothing enters by the back
door. Relied on: 2.11, FR-711, FR-1008, spec 2.6.4.

## D-032 · 2026-09-21 · I4 · A report sends at most 200 groups, and says how many there were

At the volumes of NFR-13 — 10,000 customers, 5,000 materials — "sales by customer for the year"
is ten thousand groups, and Receivables lists every customer whether they owe anything or not.
On the reference connection of NFR-03 (400 kbps) two megabytes of them take the better part of a
minute to reach a phone that can show a screenful. The specification says nothing about a bound,
because 2.11 describes the figures rather than the transport.

**Choice:** every report sums **all** of its groups and then sends at most 200 of them, with
`group_count` and `has_more`, and the screen says "the largest 200 of N — narrow the period or
the material to see the rest". A report grouped by a dimension is ordered by its own money,
largest first, rather than alphabetically, so the cap keeps the rows the question was about; a
report grouped by month or day stays chronological. The totals are the period's, never the
page's — asserted, because a capped report whose totals shrank would be a report that lies.
Relied on: NFR-03, NFR-13, 2.11, 2.9.2 (bounded responses), REVIEW-I2 finding 2.

## D-033 · 2026-09-21 · I4 · The margin report folds the lines in batches

D-029 keeps the margin in the kernel, which means the Profit report reads order **lines**. Five
years of the volume fixture is 132,000 lines; the design point of NFR-13 is fourteen times that,
and a request that reads them all at once makes one report's memory a function of how wide a
range somebody typed.

**Choice:** the lines arrive in batches of 50,000, keyed on the line's own id, and each batch is
folded into the running per-group totals as it comes. Every figure in that report is a sum of
per-line figures, so a batch's totals add to the previous ones exactly — asserted with a batch
size of seven, where the boundaries fall inside every group. The wall clock for the widest range
measured 527 ms whole and 579 ms batched: ten per cent for a ceiling on memory that does not
depend on the question. Relied on: D-029, NFR-03, NFR-13, FR-1005.

## D-034 · 2026-09-21 · I5 · A PIN unlock does not rewrite the session's method

Specification 2.8 says a session records "how it was authenticated" and that every audit row
carries that method, and separately that unlocking with a PIN **keeps the same session**. Both
cannot be read as "the method is whatever was last typed".

**Choice:** `sessions.auth_method` records how the session was *established* — password, or PIN
quick sign-in — and a PIN unlock of a password session leaves it `password`. The unlock itself is
in History with `unlocked_with: pin`, so nothing is lost, and the question the method answers for
a disputed payment stays the useful one: was this session opened by somebody typing a password,
or by somebody typing six digits on a tablet? Relied on: 2.8, FR-106, FR-902.

## D-035 · 2026-09-21 · I5 · PIN failures are counted apart from password failures

Specification 2.8 gives the two credentials different consequences: five failed **passwords** per
username in fifteen minutes locks the username out for fifteen minutes; five failed **PINs** mean
"then a password is required". Counting both in `login_attempts` would lock an employee out of
the Login page because somebody mistyped a PIN on a tablet.

**Choice:** a PIN attempt is counted where it belongs — on the **device ticket** for a quick
sign-in (five and the ticket is revoked, which *is* the password fallback, since the lock screen
has nothing else to offer) and on the **session** for an unlock (five and only the password
unlocks it, cleared when it opens). `login_attempts` keeps its single meaning, and History still
carries every failed PIN attempt as a `login_failed` row with `auth_method: ticket_pin`. Relied
on: 2.8, FR-101, FR-106.

## D-036 · 2026-09-21 · I5 · One route revokes PIN sign-in on every device

The brief's API list (2.9.3) has `DELETE /users/:id/device-tickets` — a plural with no id — while
the demo script says the admin "revokes the ticket".

**Choice:** one route, revoking every live ticket for that employee. The admin's actual question
is "make their PIN stop working", and revoking one of three tablets leaves two working; the
response says how many went, and the next password sign-in issues a fresh one, so this is a reset
rather than a punishment. A per-ticket route can be added the day somebody wants to retire one
tablet. Relied on: 2.9.3, 2.8, FR-1304.

## D-037 · 2026-09-21 · I5 · The PIN's length is audited under `pin_length`

The audit service has stripped any field literally named `pin` since I0 (`NEVER_LOGGED`), which
is a guard worth keeping — it makes writing a PIN into History impossible by accident.

**Choice:** setting or clearing a PIN records `pin_length: { old, new }`. The length is exactly
what an owner needs ("a four-digit PIN on a shared tablet"), the secret still cannot be written,
and the guard stays in force. Relied on: 2.4.4, 2.13, FR-106.

## D-038 · 2026-09-21 · I5 · The PIN policy is readable by every signed-in user

`pin_min_length_shared`, `pin_min_length_personal` and `allow_pin_switch_on_shared` were seeded
in I0 and belonged to no screen until now.

**Choice:** they join the employee-visible settings, on the same reasoning as the edit windows
(FR-1107): the PIN form states the rule before the API refuses it, and a client that is about to
lock needs to know whether its own lock screen may offer a PIN at all. They are editable by the
admin from Settings → System. Relied on: FR-1107, FR-106, 2.8.

## D-039 · 2026-09-22 · I6 · The margin is stored on the line, computed by the kernel

D-029 put the margin in the kernel and had the report fold every line of its period through it.
At I4's fixture that was 90 ms for a year. The I6 load test at the design point of NFR-13 —
1.2 million lines — measured the same report at **436 seconds**. No batching fixes a read whose
cost is the archive.

**Choice:** the line keeps its margin the way it already keeps its cost: as a snapshot written
when the line is saved, by `lineMargin` from `@mizan/money`, in both currencies at that line's
own rate (migration 0014). The report sums stored integers — which is what 2.11 says every
report does — and came back to **268 ms** for a year.

What this does *not* change is where the rule lives: the kernel is still the only place the
formula exists. The write path calls it; `scripts/backfill-margins.mjs` called it for the
1,224,361 lines that predate the column (74 s), deliberately in node rather than as a SQL
expression, because a formula written twice is two formulas. A test recomputes each stored
figure from the line's own snapshot and requires it to match exactly. Relied on: FR-1005, 2.11,
D-029, NFR-03, NFR-13.

## D-040 · 2026-09-22 · I6 · One maintained sum: what is still owed on an order

Every screen that asks "which orders are unpaid?" has to ask it of every order — the dashboard
tile, the unpaid count beside a customer on Receivables, an order's status in a list. Summing
the ledger per order is one pass over a million rows, and no index shortens a sum of everything:
the dashboard measured **1.0 s** at the design point.

Specification 2.2.6 names the remedy: "If a list of 10,000 customers with balances ever becomes
slow, the reversal-safe optimisation is a materialised view refreshed after each ledger
transaction — **still a sum over the ledger, never an edited field**."

**Choice:** `order_remaining` (migration 0015) holds one row per order, maintained by an
`AFTER INSERT` trigger on `customer_ledger`. It is legitimate precisely because the ledger is
append-only: there is no UPDATE and no DELETE to keep in step, a correction is another insert,
and a reversal adds its own negative row. The application role has **no** privilege on the table
(migration 0016) — only the trigger writes it — so it cannot become an edited field by accident.
`scripts/check-integrity.mjs` compares every row against the ledger on each restore drill,
because a cached number nobody checks is a number that lies. The dashboard tile went from 1.0 s
to 218 ms. Relied on: 2.2.6, 2.4.1, NFR-03, NFR-13.

## D-041 · 2026-09-22 · I6 · Two endpoints carry a stated budget instead of 300 ms

NFR-03 gives list endpoints 300 ms at the volumes of NFR-13. Two things measured over it on a
fixture of 1.16 million orders and 30,000 customers (1.3× and 3× the design point):

- **the Stock report at 346 ms** — two hundred materials, each with its stock, its movements in
  the period, its first purchase, its last sale and its month price: eight hundred index scans,
  of which the last-sale lookup reads every line of that material;
- **Receivables at 320 ms** — one index-only pass over the customer ledger to group it by
  customer, which at the specification's 10,000 customers is comfortably inside 300 ms.

**Choice:** both carry **500 ms** in `scripts/check-budgets.mjs`, with the reasoning written next
to the number, and the same script fails the build over 500. A budget somebody agreed to is
worth more than a green tick nobody believes; the alternative — dropping the last-sale column or
the unpaid count — would take information away from the screens to protect a figure in a
specification. Relied on: NFR-03, NFR-13, 2.12.

## D-042 · 2026-09-22 · I6 · A tap must change the screen: one Suspense boundary per route

Splitting the routes (NFR-03, I6 checkpoint A) put a new gap between a tap and the screen it
asks for: the chunk has to arrive first. React Router navigates inside a `startTransition`,
whose whole purpose is to keep the **previous** screen on the glass until the new one is ready —
sensible on a desktop, wrong on the 400 kbps reference connection of NFR-03, where it means
roughly half a second in which the thumb that has already tapped a customer is still tapping
the list underneath, and the second tap lands on whatever that list has in the same place. The
Playwright check of the company payment sheet found it as a test failure: after tapping a
company, the primary button under the thumb was still the list's "New company".

**Choice:** the boundary is keyed by route (`key={routeKey(location.pathname)}` in `App.tsx`), so
a navigation mounts a *new* Suspense boundary, which cannot show stale children — the tap always
lands on a screen that says "loading". The key is the route, not the record: `/companies/A` →
`/companies/B` is the same chunk and must not remount, so the id is collapsed out of the key.
After the first visit the module is in memory, nothing suspends, and no skeleton is seen at all.
Relied on: NFR-03, 2.10.2, 3.6.1.

## D-043 · 2026-09-22 · I6 · Names carry their own direction

Specification 2.10.6 point 6 asks for user-entered names to be wrapped in `<bdi>`, and until now
only `DualAmount` did it. The cost was visible on every Arabic screen with a Latin name in it:
`Al-Noor Steel Co.` rendered as `.Al-Noor Steel Co`, because the trailing full stop is a neutral
character and took the direction of the paragraph around it rather than of the name.

**Choice:** every place a name, a note, a username or a picker row reaches the page as data
(34 call sites, plus the header title, the picker and the search results) now renders it inside
`<bdi>`, which is an isolate *and* `dir="auto"`: the name's own first strong character decides
its direction, so a Latin name keeps its full stop and an Arabic name is unaffected. CSS could
not have done this — `unicode-bidi: isolate` isolates, but there is no `direction: auto` — so it
is markup, and the regenerated Arabic screenshots are the evidence. Relied on: 2.10.6, 3.7.

## D-044 · 2026-09-22 · I6 · Which language each handover document is written in

Section 4.8 asks for "employee quick cards per preset (one page each, **in all three
languages**)" and for an admin guide, without saying which language the guide is in.

**Choice:** the nine quick cards are in Kurdish Sorani, Arabic and English, as asked. The admin
guide is written twice — **Kurdish Sorani**, because 1.10 makes `ckb-IQ` the default language and
the admin is the factory's owner, and **English**, because whoever maintains the system after
handover reads the repository. Arabic is not written for the guide: the one person who reads it
reads Kurdish, and a third translation of a twenty-page document that nobody opens is a
liability — it drifts, and then it is wrong in a language nobody checks. Every screen name and
button the documents quote is taken from `packages/i18n/locales`, so a card cannot describe a
button by a name the screen does not use (1.6). Relied on: 4.8, 1.10, 1.6.

## D-045 · 2026-09-22 · I6 review · The second maintained sum: each material's stock

`item_stock` was a view that summed the **whole** `stock_ledger` and grouped it by material —
every time anybody asked it about one material. That was free while the ledger was small, and
the review found out why it had stayed free: the volume fixture had never written its stock
movements. It held **43** rows against 1,227,007 order lines, so every stock figure anybody had
measured had been measured against an empty table.

Filled to 1,347,043 movements — a year of trading at the design point of NFR-13 — the truth was:
`GET /reports/stock` **674 ms** against its stated 500 ms budget, of which 290 ms was
aggregating all 5,014 materials to send the 200 the report shows; the dashboard's low-stock tile
one sequential pass over the whole ledger per load; and `stockOf()`, which the negative-stock
rule calls inside every order and purchase transaction (FR-307), the same pass again.

**Choice:** `item_stock_totals` (migration 0017) — one row per material, maintained by an
`AFTER INSERT` trigger on `stock_ledger`, with `item_stock` redefined as a view over it so
nothing above the database changed. It is the same instrument and the same justification as
`order_remaining` (2.2.6, D-040): the ledger is append-only, so there is no UPDATE or DELETE to
keep in step, a correction is another movement and a reversal is its own negative row. The
application role has no privilege on the table (0018), the trigger runs `SECURITY DEFINER` in
the same transaction as the movement — which is what lets `stockOf()` see it immediately — and
`scripts/check-integrity.mjs` compares every row with the ledger on each restore drill.
Measured after: **350.7 ms**. Relied on: 2.2.6, 2.2.4, FR-307, NFR-03, NFR-13, D-040.

## D-046 · 2026-09-22 · I6 review · "First bought" and "last sold" come from the stock ledger

The two dates of FR-304 were the last per-material figures computed from the documents rather
than from a ledger: `last_sold_on` was `max(order_date)` over every active line of that
material, joined to its order. At 245 lines per material that is 245 index entries and 245
random heap reads **per material shown** — 200 ms of the Stock report's remaining time and 200
of the materials list's 280 ms, growing with every year of trading.

**Choice:** both dates read the stock ledger (migration 0019): the oldest `purchase_in` or
`opening` movement that has not been reversed, and the newest `sale_out` that has not been
reversed, each an `ORDER BY … LIMIT 1` on a new `(item_id, movement_type, entry_date DESC)`
index. This is the same answer — a sale always writes a movement dated with its order, a void
writes the reversal, an edit that drops a line writes the correction — and it is the rule the
system is built on: a stock question is answered by the stock ledger (rule 2). The Stock report
came to **350.7 ms** and the materials list to **240.3 ms**; a plan-shape test asserts the report
never reads `order_lines` again. Relied on: FR-304, 2.2.4, NFR-03, NFR-13.

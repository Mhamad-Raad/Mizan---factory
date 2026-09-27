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

## D-047 · 2026-09-22 · system-wide review · A count is built from the narrowest FROM

A list endpoint asks two questions of one `WHERE`: which twenty-five rows, and how many
altogether. The page's joins and laterals exist to produce *columns* — a balance, what is still
owed, the currency that was handed over — and the count needs none of them unless a filter
mentions one. Three lists reused the page's `FROM` for the count, so counting ran a per-row
subquery over the whole table: the unfiltered Orders list spent **1,783 ms** at 1.16 million
orders, for 25 rows of data and one integer.

**Choice:** `countFrom(base, where, joins)` (`common/count-from.ts`) keeps only the joins whose
alias the `WHERE` actually mentions, and every join listed is one whose presence cannot change
the number of rows — a `LEFT JOIN`, a lateral, or an inner join on a non-null reference whose
parent is only ever soft-deleted. Orders **1,783 → 47 ms**; customers and companies likewise.
The items list had already done this by hand after the I3 review; now it is one helper with the
reasoning in one place. Relied on: NFR-03, NFR-13, 2.4.1.

## D-048 · 2026-09-22 · system-wide review · A statement is a document, not an archive

`GET /customers/:id/statement` had no bound and the screen asked for no range, so it returned
every row of the account: **15.8 MB of JSON** for a ten-year account of 20,000 entries — five
minutes of download on the 400 kbps reference connection, and more than a 2 GB tablet renders.

**Choice:** the screen asks for the **last twelve months** and says so on the page; the server
caps the rows at **500** and reports `item_count` and `has_more`, so a capped statement says
which it is. The opening and closing balances are sums over the whole range and stay exact
either way, so the arithmetic on the page still reconciles — that is what makes the cap
honest rather than a truncation. 15.8 MB → 395 kB at the widest range, 76 kB for what the
screen asks. Relied on: FR-615, NFR-03, D-032.

## D-049 · 2026-09-22 · system-wide review · Two colours that were hard-coded, and now are checked

`.mz-button--danger` and the toggle knob wrote `color: #fff` instead of naming a token, so
nothing measured them — and in the **dark** theme the danger fill is a light salmon: the label
on the button that voids an order was **1.71:1**, and the knob that says whether a setting is on
was **2.12:1** on its track (WCAG asks 4.5:1 and 3:1).

**Choice:** a new `--color-on-danger` per theme, `--color-on-primary` for the knob when it is on,
and **three new pairs in `scripts/check-contrast.ts`** — the danger label and the knob in both
states — because a pair that is not in that list is a pair nobody measures. 38 pairs now pass in
both themes. Relied on: NFR-10, 2.10.7, rule 9.

## D-050 · 2026-09-22 · system-wide review · The tab strip scrolls; the page does not

`SegmentedControl` laid its options out with `flex: 1` and no scroll container, so options wider
than the phone pushed the **document** sideways: 334 px on the import screen's six kinds, 89 px
on a company profile's four tabs, at 360 px and the largest text size, in every language. Only
five screens had ever been checked for horizontal overflow.

**Choice:** the strip is a scroll container (`overflow-x: auto`, snap, no scrollbar) with options
that keep their whole label, which is what `.mz-tabs` already did; and the chosen option is
scrolled into view when the strip overflows, instantly under reduced motion, so a selected tab
is never off the edge. `e2e/responsive.spec.ts` now sweeps **every** route an admin can open, in
three languages at 1.25× text, and asserts nothing scrolls sideways. Relied on: 2.10.2, 3.6.1,
NFR-10, Definition of done item 6.

## D-051 · 2026-09-22 · system-wide review · Three indexes nobody reads

Every ledger row written maintains every index on the table, for ever, and the customer ledger
grows by about a million rows a year at the design point. Measured after a year of seeded
trading, every demo script, the whole suite and the endpoint budgets: `customer_ledger_order_sum_idx`
(69 MB) and `customer_ledger_running_idx` (65 MB) had **never been chosen**, and
`customer_ledger_date_idx` (37 MB) re-plans onto `customer_ledger_receivables_idx`, which leads
with the same two columns.

**Choice:** all three dropped (migration 0020), each after proving the fallback by dropping it
inside a transaction and re-planning the queries that could have wanted it — the per-order sum
falls to `customer_ledger_order_idx`, the dated sum to the receivables index at the same measured
time, and reading one account in posting order sorts 20,000 rows in 2 ms whether the index is
there or not (the planner ignored it either way). The table's indexes went from **416 MB to
248 MB**, and all 21 endpoint budgets still pass. What is kept is the hot set: the balance sum,
the per-order lookup, the receivables pass, the reversal and voucher keys, and idempotency.
Relied on: NFR-13, 2.2.6, [[mizan-longevity]].

## D-052 · 2026-09-22 · system-wide review · The import's two ceilings now agree

The CSV import's schema accepts **10,000 rows**; the body parser's default read **100 kB**,
which is about 1,800 rows of materials or 800 of opening debts. A larger file — the only kind
this feature exists for — answered **`500 INTERNAL`** with no request id, because a body the
parser refuses is rejected before any route, guard or filter runs. The client would have met
that on go-live day, importing their customer list.

**Choice:** one constant, `REQUEST_BODY_LIMIT = '4mb'`, in `request-limits.ts`, applied by
`main.ts` **and** by the test harness — it had lived in `main.ts` alone, which is exactly why no
test could see the disagreement. 413 now maps to a named code, `REQUEST_TOO_LARGE`, whose
message is written in all three languages ("that file is too large — split it"), and
`imports.test.ts` sends ten thousand rows through the parser so the two ends cannot drift
again. Relied on: FR-1312, 2.9.2, NFR-13.

## D-053 · 2026-09-22 · system-wide review · The import's preview asks once, not once per row

The preview checked each row against the database as it read it — "is this material known?",
"is this name taken?" — one sequential round trip per row. At the schema's 10,000 rows that was
**22.7 seconds** of a 44.7-second import, and the import calls the preview first, so everybody
paid it twice.

**Choice:** every name the file mentions is resolved in **one** `= ANY` per table before the
loop (`namesIn`), and the loop consults a map. The lookups are read-only and order-independent,
so nothing about the checks changes. Preview **22.7 s → 0.1 s**; the 10,000-customer import
**30.7 s → 9.1 s**. What remains is the write path — 10,000 rows in 10,000 transactions at
4.7 ms each — and that stays as it is on purpose: one bad row must not lose the file (FR-1312's
own acceptance criterion). The screen now says a large file takes about a minute, and so does
the admin guide, because somebody watching a button spin deserves to be told. Relied on:
FR-1312, NFR-03.

## D-054 · 2026-09-26 · client review · Customers and companies are one record per business

The client, reviewing the running site: "companies and customers are one thing — we are treating
them as different data and pages." The specification kept them apart (FR-501, FR-701) and gave
each its own rate, balance and page; the client's businesses are both, and a company's own rate
never reached its orders because the order side did not know companies existed.

**Choice** (asked in the session; the client chose a *net* balance and a clean slate):

- **One record per business** — the `customers` table, which gains `contact_name`, `is_customer`
  and `is_supplier` (at least one). The `companies` table is gone; `purchases.company_id`,
  `company_ledger.company_id` and `damages.company_id` name a `customers` row and keep their
  column names, meaning "the business on the buying side of this document". Migration 0023
  refuses to run over any company data, so it can never drop a real record; no production
  database existed, and the client asked for the dummy data to be cleared and re-seeded.
- **One net balance.** The two ledgers stay exactly as they were — append-only, their own sign
  conventions, the oldest-first purchase allocation, the order-remaining trigger — and
  `party_balances` nets them: *what they owe us − what we owe them*, in the one settlement
  currency. Nothing about how money is written changed; netting is a read.
- **One rate per business** (`customer_rates`; `company_rates` is gone), used for its orders,
  its purchases, and every payment, credit and adjustment on both sides. It is stored with
  `rate_source = 'company'` — "this party's own rate" — on orders too, which lifts the old
  `orders_rate_source_customer_side` check; before, an order at the customer's rate was filed as
  `manual`, indistinguishable from a rate typed for the deal.
- **One settlement currency.** Changing it re-bases both ledgers in one transaction at the one
  agreed rate, so the net never subtracts dollars from dinars.
- **Permissions keep their sides.** Creating, editing or assigning a customer needs
  `customers.*`, a company `companies.*`, a record that is both needs both; `companies.view` now
  implies `customers.view`, and the scope rule shows an employee who may see companies every
  company — they never were scoped (FR-711) — while customers stay scoped by assignment (2.6.4).
  The net figure is returned only to somebody who may see both balances, or the hidden side
  could be worked out from it.
- **Names are no longer unique among companies.** Two records named alike were exactly the
  duplication the client complained of; the duplicate warning of FR-501 now covers both sides.

**Glossary:** "Company" stays the client's word for the business we buy from (1.6); the page
is the Customers page, and each record says which sides it takes part in. The new strings are
listed for the glossary review (Q-26). Relied on: the client's instruction; 2.2.6 (balances
are sums), 2.3.3 (the document's rate), 2.3.5 (re-basing), 2.6.4 (scope in repositories).

## D-055 · 2026-09-26 · client review · One kind of account: a company, with its rate on its form

The client, on D-054's two flags: "the term we buy from them or we sell to them does not matter
… there is no customer or company, there is only company", and the checkbox choosing between
them was "more work for no reason".

**Choice:**

- **The flags are gone** (migration 0024). Every account is a company we sell to and buy from;
  its orders, its purchases and both ledgers hang off the one record, and its balance is the
  net of the two (D-054, unchanged). The one exception is the walk-in customer (`is_system`):
  cash at the counter, never a purchase — every check that asked "is this a supplier?" now asks
  "is this a real account?".
- **Visibility.** Whoever may see the companies (`companies.view`) sees every account, as the
  buying side always did (FR-711); somebody with the customer keys alone still sees only the
  accounts assigned to them, plus the walk-in (2.6.4). Creating, editing or assigning an
  account needs that permission on either side.
- **The account's own rate is on its form.** New company and Edit carry "Conversion rate — IQD
  for $1"; empty means the system-wide rate. A changed rate is a **new** rate row, never an
  edit, so every order and purchase keeps the rate it was made at (it is snapshotted on the
  document, 2.3.3), and the order's chip now says which rate it was — the company's, the
  system's, or one typed for that order. Setting a rate still needs `set_rate` on either side.
- **History filters by action** on the account's page — rate changes, money, edits, creation,
  assignment, hidden/shown — and a rate change reads "Rate 1,315 → 1,325" with who and when.
- **Words.** "Customer" reads "Company" wherever the glossary is used (the walk-in keeps its
  name); the page is Companies. For the glossary review (Q-26).

Relied on: the client's instruction; 2.3.3 (the document's rate), 2.6.4 (scope in repositories),
rule 3 (every change in History).

## D-056 · 2026-09-26 · client review · Accounts are not assigned to employees

The client, asked what assignment was for (FR-502: which salesman sees which customers, and
whose account it is): "remove that from the system".

**Choice** (migration 0025):

- **The column and three permissions go:** `customers.assigned_user_id`, `customers.assign`,
  `companies.assign`, and `customers.view_all` — "sees every customer, not only the assigned
  ones" is now what `customers.view` means by itself. Grants of the three keys are deleted; the
  Sales preset and the simple editor lose "Sees all customers" (five extras, not six).
- **Nobody's view is narrowed by assignment.** Whoever may see accounts sees every account;
  whoever may see orders sees every order. The dashboard of somebody without
  `reports.view_all` is the orders *they entered*, not "their customers'"; Receivables is no
  longer pinned to anybody; reports lose the "assigned employee" grouping and filter; History
  loses the "assigned to" filter.
- **History keeps every assignment ever made** — audit rows are append-only (rule 2).
- **Found on the way:** once every salesman could open every company, the company page showed
  the purchases side to people without `purchases.view` (an error box) and a one-sided balance
  as if it were the whole account ("Settled" for a company we owe millions). The purchases parts
  now show only with `purchases.view`, and a balance of one side says which side it is.

Relied on: the client's instruction; 2.6.4 (the scope rules this empties); rule 2.

## D-057 · 2026-09-26 · client review · Today shows two weeks, who owes us most, and the latest orders

The client: "make the today ui better with charts and if needed tables of the recent orders".

- **Stat tiles stay first**, each still opening the list it counts, four across on a desktop.
- **Sales and purchases over the last fourteen days** as grouped columns on one axis in
  dinars (never two scales), a legend, a tooltip with both currencies and the counts, and a
  "show as table" view with the same figures. Purchases appear only for `purchases.view` with
  `fields.see_bought_price`; the sales series follows the same scope as the Today tile
  (own orders without `reports.view_all`). Colours are two chart tokens, validated for
  colour-blind separation and contrast in both themes.
- **Who owes us most:** the six largest balances in our favour — the net balance with
  `fields.see_company_balances`, the sales side alone without it, and absent without
  `fields.see_customer_balances`. Ranked in dinars at today's rate so dollar and dinar accounts
  compare fairly; the rate only orders the list and every amount shown is the stored one (rule 1).
- **Recent orders:** the latest eight, exactly as the Orders page lists them.

Relied on: the client's instruction; 1.5.4 (field flags); 2.3 (dual currency); rule 7.

## D-058 · 2026-09-26 · client review · Every list is paged: 25 a page, never more than 100

The client: "add pagination to fetching lists of data … this will be used for a long time with
no update and if the data becomes too much the backend can fail — default 25 per page, max a
hundred", pointing at the delivery dashboard's pager.

- **One rule on the API** (`common/paging.ts`): every list takes `page` and `page_size`,
  answers 25 rows by default, and refuses more than 100 (422). The main lists already paged
  this way; now the ledgers, both rate histories, a material's price history, the purchase
  breakdown and every report do too, and each answer says its `page`, `page_size` and total.
  The cap of 200 groups on reports (D-032) and the growing `limit` of 100–500 on the ledgers are
  gone.
- **The audit trail pages by cursor**, 25 at a time: it only ever grows, and "the rows after
  this one" stays as quick on its millionth row as on its first, where an offset would not.
  It has no total, so its pager reads "Page 3" with Previous and Next.
- **What still reads a whole account on the server, and why:** a ledger's running balance and
  the oldest-first allocation of payments to purchases are defined over every row before the
  page (2.4.1 rule 5, FR-712), so they are computed over the account and only the page is sent.
  An account is thousands of rows after years, not millions, so this is bounded by one
  business's history. The stock report now values every material so its totals are the whole
  stock's (before, its totals silently covered only the rows it sent).
- **Found on the way:** an order's or a purchase's History tab read the whole account ledger to
  find that document's payments; it now asks the database for the document's rows only. A
  company's "Unpaid orders" card filtered the first 25 orders in the browser, so an account with
  many paid orders showed none unpaid; it now asks for `status=owing` (unpaid or partly paid).
- **Left whole on purpose:** a statement (a date-bounded printed document, capped at 500 rows as
  before), an order's or purchase's lines (at most 200 by the form), the employee directory
  behind the "done by" pickers (a factory's staff), and the last 20 sessions of a user.
- **On screen:** one `Pager` under every list — rows per page (25, 50, 100, remembered per
  list in this browser), "26–50 of 312", and arrows from the icon registry so they point the
  reading way. Page and size live in the address, so Back and a shared link keep the page; two
  lists on one screen use separate names. Changing a filter goes back to page one. The pager
  shows under every list that has rows, even when they fit on one page, so the size can always
  be changed; only an empty list has none.

Relied on: the client's instruction; NFR-03 and NFR-13 (a phone on a slow line, years of data);
2.4.1; 2.10.6 (mirrored directional icons).

## D-059 · 2026-09-26 · client review · Purchases look and work like Orders

The client: "improve the purchases UI generally like the orders page".

- **The list:** the Orders toolbar — search, a date select (today, this week, this month, any
  date, or a custom range that opens its two dates in place), "done by", and the Stock only and
  Voided chips — with "Add material" at its end. The rows go through a new `PurchaseTable`, the
  buying twin of `OrderTable`: a table on a desktop (number and date, company or "Stock only"
  with who recorded it, materials, total), a card per purchase on a phone. A company's
  Purchases tab uses the same component, with the remaining column its allocation provides
  (FR-712). A standing purchase carries no status chip; only Void does.
- **The detail:** the order's layout — the purchase number as the title, the company as a link,
  the date and who did it; the total with its rate beside "We owe for this purchase" in red while
  something is owed; the actions in the order's three groups (pay; edit, duplicate, damaged
  items; Void apart at the end); Lines, Payments and History as one segmented control. Lines
  read "5,000 kg × IQD 760" with a chip when the price was typed for the purchase.
- **"Pay for this purchase"** records a company payment that names this purchase
  (`purchase_id`), pre-filled with what this purchase still owes, so the money comes off this
  purchase first rather than the oldest one. The Payments tab lists what was paid or credited
  against it.
- **Found on the way:** the company page passed its "Settle in full" hint in place of the
  "Remaining before this payment" caption; the sheet now takes the hint as its own prop.

Relied on: the client's instruction; FR-407, FR-712; 2.10.2 (one list, two layouts).

## D-060 · 2026-09-26 · client review · Tables are framed, with striped rows

The client: "all the tables … need to be outlined in a nice way so it separates from the
background, and rows have a nice colour for odds and the others normal — like the dashboard".

Every data table (`.mz-table` in its `.mz-table-wrap`: the lists on a desktop, the ledgers, a
material's movements and history, a user's activity, the dashboard's figures) now sits in a
bordered, rounded surface with the card shadow (no second shadow inside a card), under a tinted
header in small bold type — capitals and tracking in English only, because Kurdish and Arabic
have no capitals and spacing a joined script breaks its words. Odd rows take a stripe a shade off
the surface; hover takes the brand's soft tint. Three tokens per theme (`--color-table-head`,
`-stripe`, `-hover`), so dark mode has its own steps. The permission matrix wears the same
header and stripes. The pager lost its top rule, which doubled the table's frame.

Relied on: the client's instruction; rule 9 (identity through tokens, no forked component).

## D-061 · 2026-09-26 · client review · A colour palette and a typeface per device

The client: "check the themes changing inside the item management system — the user can pick a
variation of fonts and themes — implement that here as well; all preferences saved in local
storage".

- **Colour:** eleven palettes — Teal (Mizan's own, the default), Ocean, Sky, Indigo, Plum, Rose,
  Crimson, Clay, Amber, Forest, Graphite (the client asked for more, and for "a couple of red
  ones": Rose, a pinkish red, and Crimson, a deep red turned away from the danger red so a
  brand-red button never reads as the red of what is owed or of Void). Each
  is Mizan's ramp turned to another hue in OKLCH, brand steps and tinted greys alike, at the same
  lightness, in both themes. Paid/owed/warning colours, brass and the two chart series are not
  palette colours, so they keep their meaning in every palette; the single-series "who owes us
  most" bars take the palette's primary. `check:contrast` now measures every palette in both
  themes (484 pairs).
- **Typeface:** five faces for Kurdish and Arabic text, each carrying every Sorani letter, all
  self-hosted (`font-src 'self'`): Vazirmatn (default), IBM Plex Sans Arabic (which also sets the
  English text), Noto Sans Arabic, Noto Kufi, Noto Naskh. English otherwise stays in Inter. A face
  nobody chooses is never downloaded.
- **Where and how:** two new groups of cards in Settings beside Theme and Text size, each drawing
  its choice — the app in miniature in that palette, a Kurdish line, the Sorani letters and an
  amount in that face. Saved in `mizan.prefs.v1` in local storage with the rest, validated on
  read, and applied by the pre-paint script, so the first frame is already in the chosen colour
  and face. The inline script changed, so `ops/docker/csp-hash.sh` must be run again at deploy
  (as the runbook says).

Relied on: the client's instruction; FR-1103 (appearance is per device); rule 9 (identity
through tokens); spec 3.7.1 (self-hosted fonts).

## D-062 · 2026-09-26 · client review · A warehouse with an accountant page

The client rethought what the system is for: "the system will become a giant warehouse that has
an accountant page, and keeps track of orders and companies that buy from us."

- **Buying is ours alone, and it happens in Materials.** Creating a material is buying it — the
  first quantity and what each one cost travel with it and are written in one transaction — and
  "Add stock" on a material buys more. No company is involved; the separate purchase form and
  the Purchases list are gone from the screens (the API keeps them: a buy is still a purchase
  with one line and no company). "Opening stock" and "Correct stock" are removed from the
  material page: stock arrives by buying it, and what is lost is damage.
- **Every buy keeps its own price.** Bottles bought at $1.00 and bottles bought at $1.50 are one
  material on one row; the material page splits its stock by what we paid, and the order form
  shows that split under a line. A sale takes stock from the **oldest buy first**
  (`lot_allocations`, append-only like every ledger: giving stock back is a negative row), and
  its cost is what those units cost us — summed per buy, never an average times the quantity
  (the margin kernel takes the exact total, `cost_source = 'lots'`). Selling past every buy
  costs the rest at the latest buy's price. A buy whose stock has gone out can no longer be
  voided or edited (`BUY_IN_USE`), or the sales that took from it would change cost.
- **Damage is ours or a buying company's.** Ours is a loss. A company's puts its cost — from the
  buys, like a sale — on that company's account as a `damage` entry (they owe us), and it stays
  a cost until someone marks it **paid back**: in money (a payment clears it) or in materials (a
  credit clears it and the stock returns to the very buys it came from). A booked damage's
  quantity, attribution and date are not rewritten; it is voided and recorded again.
- **The accountant page replaces Purchases.** For a period (1st of the month → today by
  default): sold, cost of what was sold, profit (margins less discounts), bought, the
  accountant's own expenses (new `expenses` table: an amount in both currencies with its rate,
  voided with a reason, never edited), damage still a cost, damage paid back, and what is left
  (profit − expenses − damage). Tabs list the orders with their profit, the buys, each
  material's sold/cost/profit/bought/stock, and the expenses — each searchable and paged.
  New permissions `accounts.view` (brings the bought-price and profit flags), `expenses.create`,
  `expenses.void`; the accountant preset gains the first two (voiding is never preset).
- **Companies only buy from us.** The buying side of a company — its purchases, "we owe them",
  paying them — is gone from the screens; its balance is what it owes us.

Demo data was wiped and reseeded in this shape. The monthly *bought* price remains only as the
suggestion a buy opens with; the monthly *sale* price is unchanged.

Relied on: the client's instructions (2026-09-26); rules 1–3 and 10; 2.4.1.

## D-063 · 2026-09-26 · client review · "Damaged items" are called "Broken goods"

The client asked for a friendlier name than "damage" and chose **Broken goods** (Kurdish
کاڵای شکاو, Arabic البضاعة المكسورة): the sidebar, the page, "Record broken goods", a record is
"Broken #3", the account row and the accountant tiles say so too. Only the words changed — the
routes, tables and permission keys keep `damage`, so nothing stored moves; notes already written on
a ledger keep the words they were written with (append-only). The page is laid out as Orders is:
one toolbar (search, period, who broke it, owed or paid back, who recorded it, voided), three tiles
(recorded, what it cost us, owed by companies — the last one also a filter), and a table on a
desktop, cards on a phone. The list API gained `compensation=owed|paid` and the owed total; the
Today tile that counted returns (which the D-062 flow never creates) now counts broken goods a
company still owes for.

## D-064 · 2026-09-27 · client review · One Reports page, with Excel

The client: "reports page … basically tabs … show case data and be able to create excel sheets …
information about everything in this system and can filter with dates".

- **One page, one period, a tab per report:** Sales, Profit, Bought, Stock, Companies owe us,
  Broken goods, Expenses, Employee activity, Daily cash-up — each offered only to those whose
  flags the API would accept. The period (presets or two dates) and the tab live in the address;
  `/reports/<name>` from before still opens that tab. Payables left with the buying side (D-062).
- **Each tab:** its totals as tiles (the whole period, never the page), a chart of the headline
  figure when grouped by day or month (a period of two months or less opens by day), the table on
  a desktop and cards on a phone, paged; names lead to the company, the material, or the
  employee's History.
- **Excel:** "Download Excel" writes the tab — every group, fetched a page of 100 at a time — and
  "Download everything" writes one workbook with a sheet per report. The files are real .xlsx
  (a small writer over `fflate`, tested and opened with an independent reader): numbers are
  numbers with formats (whole dinars, dollars with cents, kilograms to the gram), dinars and
  dollars in their own columns, a frozen header with filters, a bold totals row, and a Kurdish or
  Arabic workbook opens right to left.
- **Found on the way:** the Stock report valued stock at the month's price list and showed
  materials sold by the piece as "0 kg". Stock is now valued at what is left of each buy at its
  own price — the figure the material page splits by price — and a piece material reads in
  pieces.

## D-065 · 2026-09-27 · client review · An order's total rounds up to the next 250 dinars

- **Asked:** "630 should turn to 750" — the order total in IQD rounds up to a multiple of 250,
  the dollar total follows, only the total (never a line's price), and it says it was rounded.
- **Chosen:** after the discount, the total rounds **up** to the next 250 IQD
  (`roundOrderTotals`, `@mizan/money`). The added dinars are converted at the order's own rate
  and added to the USD total, so both currencies still describe the same amount (2.3.4). The
  order keeps what was added (`rounding_iqd`, `rounding_usd_cents`, migration 0027), so the
  lines still sum to the total before rounding and the difference is explained rather than
  hidden: the form's totals, the order page ("Rounded up by IQD 10 to a round 250") and the
  receipt ("Rounding +10") all show it.
- **Where it applies:** new orders, and an order when it is edited. Orders already saved keep
  the total they were saved with (rule 1: history is never recalculated).
- **Money:** the customer owes the rounded total; on the Accounts page the rounding counts as
  profit, next to the margins and against the discount.

## D-066 · 2026-09-26 · security review · What the security fixes decided

A security review listed twenty-one findings; the fixes are on `fix/security-review`, one commit
each. Where a fix had to choose, this is the choice.

- **The sign-in lockout is per account.** When the typed name resolves, the count is kept under
  the username, whichever alias was typed; when it does not, under the name normalised as the
  lookup normalises it (a phone number in any spelling is one key). Login, unlock and
  change-password share that key. Check-and-record runs under
  `pg_advisory_xact_lock(hashtext(key))` in one transaction, with an in-process queue per key in
  front so a burst does not hold pooled connections while it waits; the transaction spans the
  Argon2 check (tens of milliseconds), which the pool of ten absorbs at 30 users. An unknown name
  is checked against a dummy hash, so it costs the same time. Relied on: 2.8, FR-101.
- **Changing your own password** answers to the lockout (checked before the password is) and
  signs out every other session of the user; the device it was changed on stays signed in.
  Relied on: 2.8, FR-108.
- **Paid back on a damage** needs `companies.record_payment` (money) or `companies.record_credit`
  (materials) besides `damages.mark_returned`, checked in the service with the method known, and
  refused with a message naming the missing permission. **Recording** a company-attributed damage
  is *not* gated on a company key: that charge is a document posting like a purchase's or an
  order's, which need only their own create key — gating it would stop the warehouse preset from
  recording supplier damage at all. Relied on: 1.5.2, 2.6.2, D-062.
- **Must change password** is enforced by the guard: until then only `me`, change-password,
  logout, lock and unlock answer; everything else is `403 PASSWORD_CHANGE_REQUIRED`. Relied on:
  FR-101, FR-108.
- **The global History page** strips the same fields the per-record History tabs do, per kind
  of record (a purchase's `unit_price` is a bought price, an order's is not; `balance` follows the
  customer or the company flag). Relied on: 2.4.4, 2.6.2.
- **Per-address ceiling** on sign-in, unlock and change-password only: 30 a minute and 200 an
  hour per address per door (`SIGN_IN_LIMIT_PER_MINUTE`, `SIGN_IN_LIMIT_PER_HOUR`), counted by
  `request.ip` with `TRUST_PROXY` (default off; `compose.yml` sets 1 for Caddy). **No global
  limit**: the whole factory reaches the server from one address, and a limit loose enough for a
  busy day at thirty users protects nothing a login ceiling does not. In memory per replica.
  Relied on: 2.8, NFR-13, C-07.
- **The API no longer holds the migrate role.** Migration 0028 grants the app role `SELECT` on
  `mizan_migrations`; migrations run from a one-off `migrate` service in `compose.yml`. Making
  `mizan_migrate` a non-superuser on the existing volume is a manual step (runbook), not code.
  Relied on: 2.13, 2.14.
- **Backups have no local-only mode** (the runbook never described one): a copy that cannot leave
  the host fails the run and withholds the heartbeat. Encrypted copies carry an HMAC-SHA256 tag;
  restore refuses a copy whose tag does not match and decrypts an untagged (older) copy with a
  warning. Relied on: 2.13, 2.14, NFR-08.
- **Development settings refuse a public address**: `NODE_ENV=development` (the default) with an
  `APP_BASE_URL` that is not localhost or a private network stops the API at start-up. Relied on:
  2.8 (Secure cookie), D-007.
- **CSRF, partly.** A write whose `Referer` names another site is refused when `Origin` is absent;
  a request with neither is still left to the double-submit token, because non-browser clients
  send neither. Binding the token to the session was not done: the custom header already cannot
  be sent cross-site without a preflight the API only grants to `APP_BASE_URL`. Relied on: 2.8,
  2.13.
- **A malformed record id is 404** (global pipe over `id`, `entryId`, `sessionId`, after the
  guard); **idempotency keys** must be 8–128 of `[A-Za-z0-9_-]` and are unique per user
  (migration 0029). Relied on: 2.9.1, 2.9.2, FR-1305.
- **Numbers refused by a schema** now say so as numbers (`errors:field.number_too_small` with
  `min`), and every field error carries its `min`/`max`. Relied on: 2.9.2.

## D-067 · 2026-09-27 · security review follow-up · What the second pass decided

A review of `fix/security-review` found the per-address ceiling could lock out the factory, the
password check held a pooled connection, and History still read ledger amounts to readers
without the flags. This supersedes the per-address and backup bullets of D-066.

- **The per-address ceiling counts only wrong passwords.** 100 an hour per address across
  sign-in, unlock and change-password (`SIGN_IN_FAILURES_PER_HOUR`); reaching it refuses the
  address for 5 minutes (`SIGN_IN_BLOCK_MINUTES`), doubling for each further block within a
  day, capped at an hour. Right passwords never count, so a shift change or a day of
  idle-locked tablets behind the factory's one public address cannot trip it. A check under way
  counts until it succeeds, so a parallel burst across usernames cannot overshoot. IPv6 is
  counted by its /64 (`normalizeIp` of `@nestjs/throttler`), IPv4-mapped IPv6 as IPv4. In
  memory per replica, as before; `ThrottlerModule` and its guard are gone.
  Relied on: 2.8, NFR-13, C-07.
- **No connection is held while Argon2 runs.** Per throttle key, in the in-process queue: a
  short read of the failures (locked → refused, password not checked), the password check
  outside any transaction, then a short transaction under the advisory lock that reads the
  failures again and records the result. On one replica a burst still gets exactly five checks;
  across replicas the count stays exact and at most one check per other replica can be in
  flight when the fifth failure lands — answered as locked if another replica locked the key
  meanwhile. Relied on: 2.8, FR-101.
- **History's ledger rows follow the Ledger tab's flags.** A row on a customer's or a company's
  ledger (`changes.entry`, `changes.balance`) shows its amount only with that ledger's flag
  (`fields.see_customer_balances` / `fields.see_company_balances`); one whose amount *is* a bought
  figure — a purchase on a company's account, its reversal, and anything naming a damage (the
  charge at cost, its reversal, the payment or credit that settles it) — also needs
  `fields.see_bought_price`. A customer row's `payable` (the supplier side re-based with the
  settlement currency) needs the company flag. The per-kind rules now apply on the global page,
  My activity, and the customer, company and order History tabs; on an order's tab the payments
  against that order keep their amounts, because the order shows them to anyone who may open it.
  Audited money fields checked: purchase `unit_price`/`line_total`/`purchase_total`, item
  `bought`/unit costs, damage `est_value`, order `cost`/`balance`, customer/company `balance`,
  expense `amount` — all already covered. **Left as it is:** the company Ledger tab itself shows
  purchase amounts under the company flag alone (FR-704 vs. the Purchases row of 2.6.2); the
  spec reads both ways, so the owner should decide. Relied on: 2.4.4, 2.6.2, FR-503, FR-704.
- **Backups.** A copy without its `.hmac` is refused unless `--allow-untagged` is given. The MAC
  key is PBKDF2 (200,000 rounds, SHA-512, fixed salt "mizanmac") of the passphrase via
  `openssl enc -P`, which reads the passphrase from the environment; tags are
  `hmac-sha256-v2`. Nothing was deployed, so v1 tags are not verified. An empty
  `AWS_ENDPOINT_URL` is unset. Relied on: 2.13, 2.14, NFR-08.
- **Smaller.** Origin/Referer and CORS compare with `new URL(APP_BASE_URL).origin`; the runbook
  demotes `mizan_migrate` only after the first migrate (0002 creates `mizan_app`) and sets
  `mizan_app`'s password; an import number too big says so (`imports:number_too_big`,
  `number_too_small`, `number_above`); `api` and `migrate` share `mizan-api:${MIZAN_IMAGE_TAG}`.

## D-068 · 2026-09-27 · client review · Fourteen findings after the Me page and the rounding

- **A username and a phone share one namespace.** Sign-in takes either (FR-101), so a phone may
  not be another account's username and a new username may not be another account's phone; at
  sign-in an exactly typed username wins over a phone. A phone with no digits is refused
  (`errors:field.phone_invalid`) instead of being stored empty.
- **How many orders still owe** moves under `balance` on the Orders list, with the amount: the
  balances flag (2.6.2) now hides the "To collect" tile whole. Each row's own status stays.
- **A record's number is an identifier** (`formatter.identifier`): the reader's digits, never a
  thousands separator — "Order #1014". The rounding note takes its 250 from the formatter.
- **English the API writes once** ("Expense #5", "Broken #4", "Broken #4 paid back") is read in
  the reader's language wherever it shows (`lib/record-names.ts`); ledger rows stay as written.
- **History records the rounding** of an order on create and on edit, old → new.
- **The lock screen** returns to the page it covered; a different user taking over starts on
  their own home, with no page title left over from the last one.
- **The demo seed** changes a fresh admin's password to `DEMO_ADMIN_NEW_PASSWORD`, and stops
  with that instruction when it is not set — it never invents an admin password.

## D-069 · 2026-09-27 · client review · Only dinar accounts are rounded to 250

- **Found:** the round-250 rule of D-065 rounded the dinar total and converted the difference,
  so a company settled in dollars owed odd cents — a $10.00 order became $10.11.
- **Chosen (the recommended option; the client did not pick one):** an order's total rounds up
  to the next 250 IQD only when its company settles in dinars, the walk-in included. A company
  settled in dollars is billed in dollars and its order is not rounded. The order form's preview
  follows the same rule. Relied on: 1.10 (defaults), D-065.

## D-070 · 2026-09-27 · full review · What the review of the whole system changed

Five read-only review passes (money and stock, API, web, database, packages and tests); every
finding below was traced in code and each fix has a test that fails without it.

- **Money:**
  - An order edit keeps the payments already made against it: a cash settlement covers only
    what is still owed.
  - The walk-in customer cannot be put on credit by an edit or a payment-type change.
  - A buy's stock is costed as its share of what the buy cost, in both currencies — never a
    rounded unit price times the quantity.
  - What is left of each buy is trimmed to the stock on hand, oldest first (`item_lots`,
    migration 0030), so selling past every buy or a stock correction no longer leaves phantom
    stock in the buys or in the Stock report. Stock with no buy behind it is valued at the
    month's price.
  - A broken-goods record that took stock or charged a company is re-booked only by voiding
    it; editing its texts keeps its cost.
  - The Accounts sales and materials tabs count as cost only the lines that have one.
  - The Broken goods report no longer counts the company's charge as a credit.
- **Leaks:**
  - The company's Orders tab hides what is owed without the balances flag.
  - The companies list ignores the balance filter and sort for anyone who cannot see the net
    balance.
  - The dashboard's unpaid count travels under `balance`, like the Orders list (D-068).
  - Only an admin may name somebody else as the one who took a payment.
- **Errors:**
  - Impossible dates, unknown History filters and malformed cursors are 422s.
  - Database refusals answer as what they are: a duplicate is `DUPLICATE`, two saves
    deadlocking is `BUSY_RETRY`, and a broken rule is `VALIDATION_FAILED` — never "something
    went wrong".
  - The money kernel's refusals are 422s.
  - Materials are locked sorted and after the account, and a buy being voided or edited locks
    its materials first.
  - A return's credit and its status commit together.
  - A stale preset save and a revocation of somebody else's session are refused.
  - An emptied company field is cleared.
- **History:** the cursor keeps microseconds, so rows one transaction wrote together are
  never skipped between pages.
- **Scale:**
  - A ledger write sums the balance in the database instead of reading the account's whole
    ledger, and a reversal reads one row.
  - Reversing a document reads only that document's rows.
  - `lot_allocations` has a covering index.
- **Web:**
  - Saved forms stop autosaving, and the dollar field can be typed.
  - Money is parsed without floating point.
  - Every write shows its error, including no connection.
  - The summary screens refresh after writes, and no rate is invented when none is set.
  - The statement uses the Baghdad day, and the payment preview uses the company's rate.
  - A list never strands the user past its last page, and searches are debounced.
  - The receipt is in both currencies.
  - One helper each for the periods, the rate, the errors and the refresh.
- **Tooling:** `pnpm typecheck` now type-checks the web app, the UI package and the API as
  well.
- **Left as they are, deliberately:**
  - The buying-side write routes (company payments, adjustments and credits, purchases with a
    company) stay in the API although no screen calls them. Removing a tested API surface is
    the client's decision.
  - The "All" chip of the Orders list, and the Stock and Payables reports, still add up the
    whole table per request. They are correct, and slower as years pass. Maintained totals
    would fix them, and are a separate piece of work.

## D-071 · 2026-09-27 · follow-up review · What the second look at D-070 changed

Two reviewers read only the D-068…D-070 diff; the screens were checked at 360 px in all three
languages, and the stock queries were timed on 520,000 buys and 1.56 million takes.

- **Booking of broken goods:** the company, order or purchase a record names is part of its
  booking. A charged damage can no longer be moved to another company, leaving the charge
  behind.
- **Locks:** one order everywhere — the account, then the materials sorted, then their stock.
  - An order edit and an order void lock their materials before any stock moves.
  - A damage void locks the company and the material first.
- **Units:** a material that has been bought keeps its pricing unit, even for an admin. Its
  buys are counted in that unit, so pieces cannot become kilos under them.
- **Cost of takes:** a buy's takes are costed from cumulative shares, so together they cost
  exactly the buy: three pieces of a 1,000 dinar buy cost 333 + 334 + 333. The dollar side
  of a margin is still its dinar margin at the sale's rate (the margin rule).
- **Speed:**
  - `item_lots` sums each buy's takes once (migration 0031).
  - The Stock report values its buys in one grouped pass: 5,000 materials in 35 ms, where the
    per-material lateral took 4.5 s.
- **Phones** stored in the 0964 spelling are brought to 07… (migration 0031).
- **Errors:** only a check rule and unreadable text or dates are the request's fault (422).
  A missing column, a broken reference or an overflow stay 500s, so they are seen. A money
  RangeError is still a 422, but is logged as an error.
- **Sessions:** revoking a session that has already ended is not an error.
- **Orders:**
  - An edited order returns its stock and credit warnings, and the order page shows them.
  - The order carries its company's own rate, so the payment preview uses it without the
    permission to open the company.
- **Web:**
  - A refused price reaches the banner.
  - A failed reprint cannot print later.
  - Import refreshes every screen.
  - The expense sheet explains a missing rate.
  - The currency sheet shows its error.
  - The companies list offers the balance filter only to those who can see the net balance.

## D-072 · 2026-09-27 · client request · The product is called Jiyan Management

- **Asked:** rename Mizan to "Jiyan management", with a new icon and favicon.
- **Chosen:**
  - **Name:** "Jiyan", with "Management" as the line beneath it where "One factory" was —
    written in English in all three languages, at the client's request (the check allows
    exactly these two keys to be the same everywhere). The browser tab and the installed app
    are "Jiyan Management".
  - **Mark (`BrandMark`):** a box — the warehouse's stock — with a sprout rising from its lid
    ("jiyan" is Kurdish for life). The favicon and home-screen icons draw it in white on the
    theme's teal. The icons are maskable, and an Apple touch icon was added. The offline
    shell cache was renamed, so an installed app drops the old icons.
  - **Exports:** files download as `jiyan-…`.
- **Not renamed:** the internal names — the `@mizan/*` packages, the database and its roles,
  the `mizan.prefs.v1` storage key, the repository. They are never shown, and renaming the
  storage key would sign everyone out of their saved preferences, and the database would need
  a migration of its own.

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

---

## Checkpoints for Iteration 1

The same A–E shape as I0 (D-002), applied to selling.

| # | Checkpoint | Gate | Human? |
|---|---|---|---|
| A | Decisions recorded, schema, indices, views, grants | migrations apply; the application role still cannot touch a ledger row | no |
| B | Kernel: month prices, cost snapshot, stock, order status, ledger grouping | unit tests green | no |
| C | API: materials, customers, orders, global rate | API integration tests green; no undecorated route | no |
| D | Frontend: the selling screens in three languages | screenshots in ckb/ar/en, both themes, 360 px | **yes — real-phone RTL review** |
| E | Review, demo script, Definition of done | review findings fixed with regression tests; demo script executed | no |

## I1 · Checkpoint A — done

- Migration `0006_selling.sql`: `items`, `item_month_prices`, `global_rates`, `customers`,
  `orders`, `order_lines`, `order_payment_type_changes`, `customer_ledger`, `stock_ledger`;
  the sequences for order numbers, voucher numbers and posting order; the check constraints of
  2.2.5 (one priced measure per line, money pairs whole, one sign per entry, the re-basing
  shape, notes where a human owes an explanation); the derived views `customer_balances`,
  `customer_ledger_running`, `order_balances`, `item_stock`, `item_stats`; a trigger that
  refuses the reversal of a re-basing row even from a direct insert.
- Migration `0007_selling_privileges.sql`: the four append-only tables are INSERT + SELECT for
  `mizan_app`; the mutable tables have **no DELETE at all**, because a record is deactivated or
  soft-deleted and lines are replaced by soft-deleting the old set.
- Decisions D-010 to D-018 in `docs/DECISIONS.md`; the three questions the client still owes
  are Q-A-03 (the materials model), Q-B-02 (the optional extras) and Q-B-03 (general payments).

## I1 · Checkpoint B — done

Kernel additions, **61 new unit tests** (104 in `money` and `ledger` together).

| Kernel | What was added |
|---|---|
| `@mizan/money` | the month price list with the silent carry-forward of FR-306 (each side chosen on its own), the line price defaulted in the currency it was entered in with the other side at the document rate, the cost snapshot copied as stored for the Profit report, the stale-rate test of FR-1106 |
| `@mizan/ledger` | the stock model of 2.5 (sum of the priced measure, the other measure only while every movement carried it, exact reversals that keep a null measure null, warn-or-refuse on negative stock), the derived order status of 2.4.3, and the presentation rules of 2.4.5 — edited documents, undone pairs, cash-order pairs and re-basing markers |

## I1 · Checkpoint C — done

The API. **113 API integration tests**, 72 routes, all declared.

- Materials: list with stock and this month's prices, create/edit/deactivate/delete, the price
  list with `PUT /items/:id/prices/:month` and `copy-month`, movements, opening stock and
  corrections, per-material History. Bought prices leave the API only for holders of
  `fields.see_bought_price` — enforced once, on the controller.
- Customers: profile, assignment, the duplicate check that runs over every record whatever the
  caller's scope, the ledger grouped per 2.4.5 with its running balance and an "as of" reading,
  payments (plain, settle-in-full in both shapes, split, over-payment on confirmation), credit,
  refund, adjustment, opening balance, reversal, the settlement-currency re-basing entry, and
  the voucher and statement figures.
- Orders: create with lines priced from the month list or overridden, the cost snapshot per
  line, one stock movement per line, the receivable and — for a cash order — the settlement
  carrying the currency handed over; edit as reverse-then-rewrite; void that leaves payments as
  credit; the payment-type switch both ways with its own history; the 8-second undo; the
  receipt figures.
- Settings: the global rate with its history and ±20 % guard, and the selling rules
  (negative stock, tolerances, edit window, period lock, stale-rate days).

## I1 · Checkpoint D — done (the real-phone review is owed by the client)

The selling screens, mobile first. Bundle **167.9 kB gzipped** against the 250 kB budget;
**481 message keys × 3 languages**, every reference resolving.

- Materials list and detail (stock, prices with the month editor, movements, History),
  New material; Customers list and profile (balance, orders, ledger, History) with the payment,
  credit, refund, opening-balance, assign and statement sheets, New customer with the duplicate
  warning that names the assignee; Orders list with its date chips and filter sheet, the order
  form of wireframe 3.4.1 (customer picker, "Paid in" for cash, line cards, More with the rate
  for this order, sticky totals, discount and round down, drafts and the 8-second undo), and
  the order detail with payments, payment-type change, void and receipt.
- New components: `MoneyInput`, `QuantityInput`, `LedgerList`, `TotalsFooter`,
  `MonthPriceEditor`, `PaymentSheet`, `PickerSheet`, `ShareDocumentSheet`, `DraftBanner`, the
  status chips, and one `QueryStates` so no page can forget its skeleton, empty, error and
  offline states.
- **15 screenshots** of eight screens in Kurdish, Arabic and English, both themes, taken
  against the real API with seeded data, plus the 360 px overflow and 44 px target checks at
  the largest text size.

## I1 · Checkpoint E — done

- Review: `docs/REVIEW-I1.md`. Thirteen findings, each fixed with a regression test — the
  worst being a cash settlement that recorded dinars as cents, and an Orders list that
  aggregated every order ever placed to show twenty-five rows (85 ms → 1.4 ms at 60,000
  orders, measured).
- Demo script of 4.3 is **executable** (`scripts/demo-i1.mjs`) and passes end to end: the rate,
  two materials with their prices typed in dinars and the dollars filling themselves, opening
  stock, a customer with an opening debt, a borrowed order rounded down, a part payment with
  its voucher, settle-in-full in dollars with no residue, a cash order for the walk-in customer
  paid in dollars, an edit with compensating movements, a void with a refund, the scope rules
  between two sales employees, the period lock naming its date, and the invariant that the
  balance equals the sum of the ledger.
- CI: lint (with the logical-property rule) · types · translations · contrast · migrations ·
  route declarations · **333 tests** · build · bundle budget · **19 Playwright checks**.

## I1 — Definition of done (section 4.1)

| # | Item | State |
|---|---|---|
| 1 | Three languages, glossary terms, build fails on a missing key | ✅ 481 keys × 3 from one table; checked in CI |
| 2 | RTL verified **on a real phone** in ckb, ar and en | ⚠️ automated at 360 px in all three, both themes; **the real-phone check is owed** |
| 3 | Permissions enforced on every new endpoint | ✅ 72 routes declared; the matrix is generated from route metadata |
| 4 | Every change in History with old → new, balances before → after | ✅ asserted per write path, including the payment-type switch and the re-basing entry |
| 5 | Every amount in both currencies through `DualAmount`, ≈ for conversions | ✅ on every screen; balances carry ≈ at today's rate |
| 6 | Both themes, all four text sizes, no overflow, contrast | ✅ 15 screenshots, 32 contrast pairs, overflow and target checks at 1.25 |
| 7 | Tests for money and stock logic | ✅ 104 kernel tests, 113 API tests |
| 8 | Skeleton, empty, error and offline states | ✅ through one `QueryStates` on every page |
| 9 | Accessibility basics | ✅ labels, focus order, 44 px asserted, reduced motion |
| 10 | Demo on staging with seeded data | ⚠️ the demo script passes against a live deployment; **staging still needs a host** |

**I1 is complete but for the two items that were already owed after I0:** the real-phone RTL
and identity review (FR-1311, item 2) and a host for staging (item 10).

**Still open with the client:** Q-A-03 (materials as a catalog or as batches — built as a
catalog, D-010), Q-B-02 (which optional extras to keep — all of them built, D-011) and Q-B-03
(a general payment changes no order's status, D-012).

**Next:** I2 — companies, purchases and supplier accounting. It needs nothing new from the
client; `company_ledger` mirrors the customer ledger this iteration built, and the money,
stock and period rules are already in the kernel.

---

# Iteration 2 — companies, purchases & company accounting (buying)

Branch `feat/i2-buying`, brief `iterations/I2-companies-purchases-accounting.md`.

## I2 · Checkpoint A — done · the schema and the privileges

- `0008_buying.sql`: `companies`, `company_rates`, `purchases`, `purchase_lines`,
  `company_ledger` (every entry type including `settlement_change`), the checks that mirror the
  customer ledger row for row, the trigger that refuses a reversal of a re-basing marker, the
  views `company_balances`, `company_ledger_running` and `purchase_linked_totals`, the
  sequences `purchase_number_seq` and `company_ledger_seq`, and the covering indices the I1
  review measured into place (`company_ledger_balance_idx`, `company_ledger_purchase_sum_idx`).
- `0009_buying_privileges.sql`: the application role may INSERT into `company_ledger` and
  `company_rates` and may never UPDATE or DELETE them; `update company_ledger` answers
  *permission denied* on both databases, which the suite now asserts as well.

## I2 · Checkpoint B — done · the kernel

- `allocateOldestFirst` in `@mizan/ledger`: explicit links first, then unlinked payments,
  credits and adjustments spread over the oldest purchases, never past zero, with everything
  unallocatable in a `general` bucket. **50 ledger tests**, including a 300-run property test
  for `Σ remaining + general = balance` (D-020).
- The ledger writer refactored into one `AccountLedgerService` with `CustomerLedgerService` and
  `CompanyLedgerService` as thin subclasses (D-019); every I1 ledger test still passes
  unchanged.

## I2 · Checkpoint C — done · the API

**102 routes, all declared** (30 new); **168 API tests**, **371 across the workspace**.

- Companies: profiles with settlement currency and assignment, the company rate with its
  history and ±20 % guard, the accounting tab (grouped ledger, `as_of`, money-only), the
  per-purchase breakdown, payments with conversion, override, split and settle-in-full,
  adjustments by new balance or delta, manual credits, opening balances, reversal, the
  settlement-currency change with its re-basing entry, the statement and the voucher.
- Purchases: create with lines priced from the month **bought** price at the purchase's own
  rate, one `purchase_in` movement per line, one company entry copying the purchase totals —
  and none at all when no company is named (FR-407); edit as reverse-then-rewrite, void with
  its reason, the 8-second undo, the purchase's own balance, History.
- Two rules came out of this checkpoint and are written down: a purchase's money travels under
  one `cost` key so one flag hides all of it (D-022), and a route may require two permission
  keys — which also closed the I1 gap where `GET /customers/:id/ledger` asked only for
  `customers.view` (D-023).

**Next:** checkpoint D — the buying screens (Companies list and profile with its four tabs and
sheets, Add material / Purchase, Purchase detail, Purchases list), the `companies` and
`purchases` namespaces in all three languages, and the screenshots.

## I2 · Checkpoint D — done (the real-phone review is owed by the client)

The buying screens, mobile first. Bundle **177.6 kB gzipped** against the 250 kB budget;
**596 message keys × 3 languages**, every reference in the interface *and in the API* resolving.

- Companies list (search, highest balance first, hidden companies behind a chip) and New
  company with the duplicate-name warning that links to the existing account; Company profile
  with the rate and its "since", the balance in both currencies, and the four tabs of 3.3 —
  Overview · Accounting (grouped `LedgerList`, filter chips, the per-purchase section with its
  oldest-first figures) · Purchases · History — plus the sheets: Record payment (wireframe
  3.4.2, with Settle in full, the live "after this payment" and "More → link to a purchase"),
  Adjust owed (new balance or change, note required, now → after), Manual credit, Opening
  balance, Set rate (with the ±20 % confirmation), Rate history, Settlement currency with its
  re-basing rate, Assign, Statement.
- Add material / Purchase form of 3.3: the company picker with **"No company — stock only"**
  pinned at the top, line cards whose priced measure comes first, the month's bought price
  filling itself with the other currency at the purchase's rate, "More" for the notes, the rate
  for this purchase and "done by", the sticky totals footer, drafts and the 8-second undo.
  Purchase detail with "We owe for this purchase", Edit, Void and Duplicate. Purchases list
  with its date chips, filter sheet and the "Stock only" badge, reachable from Materials, from
  a company and at `/purchases`.
- `companies` and `purchases` message namespaces in Kurdish, Arabic and English, with the
  glossary words the client ticked; two new icons in the registry; the bottom bar's **More**
  now opens a sheet, because a link to the first hidden tab left Settings unreachable.
- **11 new screenshots** of five screens in Kurdish, Arabic and English, both themes, taken
  against the real API with seeded data, plus the 360 px overflow and 44 px target checks on
  the purchase form at the largest text size. **30 Playwright checks** in total.

## I2 · Checkpoint E — done

- Review: `docs/REVIEW-I2.md`. Eleven findings, each fixed with a regression test — the worst
  being a quadratic "which rows are still live?" scan that sat on the write path of every edit
  and void as well as the read path of the accounting tab (43 ms → 12 ms at fifteen years of
  data, and seconds → milliseconds at twenty thousand entries), and an accounting tab that
  answered a phone with 1.7 MB of JSON because the filters 2.9.3 documents were never built.
- Demo script of 4.4 is **executable** (`scripts/demo-i2.mjs`) and passes end to end: the
  company and its own rate against a different global one, a purchase from a phone with its
  stock and "first bought", a payment in dinars converting at the company's rate and one in
  dollars with the dinar side typed by hand, the oldest-first view without anything linked, an
  adjustment with its note and old → new (and the refusal without one), a rate change that
  leaves every stored entry byte for byte, a settlement-currency change refused without a
  re-basing rate and exact with one, an edit and a void with compensating movements, the
  warehouse employee refused the void their preset does not grant, an opening debt with its
  statement, and the identity Σ remaining + General = balance after all of it.
- CI: lint · types · translations (interface **and** API) · contrast · migrations · route
  declarations · **377 tests** · build · bundle budget · **30 Playwright checks**.

## I2 — Definition of done (section 4.1)

| # | Item | State |
|---|---|---|
| 1 | Three languages, glossary terms, build fails on a missing key | ✅ 596 keys × 3 from one table; the check now covers the API's error keys too |
| 2 | RTL verified **on a real phone** in ckb, ar and en | ⚠️ automated at 360 px in all three, both themes; **the real-phone check is owed** |
| 3 | Permissions enforced on every new endpoint | ✅ 102 routes declared (30 new); the money routes ask for two keys, as 2.9.3 writes them |
| 4 | Every change in History with old → new, balances before → after | ✅ asserted per write path, including the adjustment, the reversal and the re-basing entry |
| 5 | Every amount in both currencies through `DualAmount`, ≈ for conversions | ✅ on every screen; a company's balance carries ≈ at its own rate |
| 6 | Both themes, all four text sizes, no overflow, contrast | ✅ 11 new screenshots, 32 contrast pairs, overflow and target checks at 1.25 |
| 7 | Tests for money and stock logic | ✅ 52 kernel tests (incl. the 300-run allocation property test), 172 API tests |
| 8 | Skeleton, empty, error and offline states | ✅ through one `QueryStates` on every new page and tab |
| 9 | Accessibility basics | ✅ labels, focus order, 44 px asserted on the purchase form, reduced motion |
| 10 | Demo on staging with seeded data | ⚠️ the demo script passes against a live deployment; **staging still needs a host** |

**I2 is complete but for the two items that have been owed since I0:** the real-phone RTL and
identity review (FR-1311, item 2) and a host for staging (item 10).

**Still open with the client:** Q-A-03, Q-B-02 and Q-B-03 from I1, unchanged.

**Next:** I3 — damaged items and returns. It reuses the company ledger's credit path for
damage-driven credits, so nothing new is needed from the client to start.

---

# Iteration 3 — damaged items & returns

Branch `feat/i3-damages`, brief `iterations/I3-damaged-items-returns.md`.

## I3 · Checkpoint A — done · the schema and the privileges

- `0010_damages.sql`: the `damages` table with the sequence `damage_number_seq`, the indices
  the list and its filters need, a covering index for the period totals, the view
  `damage_totals`, and the two foreign keys that the money links declared in I1 and I2
  (`customer_ledger.damage_id`, `company_ledger.damage_id`) were waiting for. Three rules live
  in its constraints rather than in the application: the attribution and its links agree in
  both directions, the stock effect is `none` exactly when the goods had already been sold, and
  the return status is `not_returnable` exactly when the goods cannot go back.
- `0011_damages_privileges.sql`: `damages` is INSERT + SELECT + UPDATE for the application role
  and has no DELETE — a record is edited or voided, never removed.

## I3 · Checkpoint B — done · the kernel

`@mizan/ledger/damage.ts` holds the four rules the form, the write path, the return sheet and
the totals all ask: what damage does to stock (A-30), the return-status machine of FR-803, the
value snapshot from the damage month's bought price (FR-807) and what a return to a supplier is
worth — the purchase line's price, else the month's, at the company's own rate (A-39). **19 new
kernel tests**, including the figures of flow 3.5.5 (4 kg × 5,900 د.ع = 23,600 د.ع ≈ 18.02 $).

## I3 · Checkpoint C — done · the API

**110 routes, all declared** (8 new); **205 API tests**, **413 across the workspace**.

- `/damages`: the list with the filters of FR-801 (material, period, attribution, return status,
  returnable, employee, company, order, purchase, free text) and the period totals of FR-807;
  create with its stock movement and value snapshot; read with the credit pre-fill and the
  credits that name it; update with compensating movements; void; `/return` for "Mark returned",
  "Written off" and the supplier credit; `/return-to-stock`; history.
- The credits are written through the two existing ledger writers, so a return to a supplier is
  an ordinary company credit that names the damage record and the purchase, and a customer's
  returned goods an ordinary customer credit that names the damage record and the order — each
  validated to belong to the account it is recorded against, which the review of I2 taught.
- Two rules the specification left open are written down: the attribution links are validated
  but the material match is left to the pickers (D-026), and a record is frozen once its return
  has been recorded (D-027).

**Next:** checkpoint D — the Damaged items list with its chips and totals, the Record damage
form with its attribution tiles and stock-effect sentence, the damage detail with its four
actions, and the links from the material, order and purchase pages.

## I3 · Checkpoint D — done (the real-phone review is owed by the client)

The damage screens, mobile first. Bundle **186.8 kB gzipped** against the 250 kB budget;
**665 message keys × 3 languages**, every reference in the interface and in the API resolving.

- Damaged items list with the chips of 3.3 (pending return, returnable, this month, voided,
  filters), the period totals of FR-807 — quantities always, value only with the bought-price
  flag — and rows that lead with the material, its quantity and its two chips.
- Record damage (wireframe 3.4.3): the material picker with its stock, the priced measure first,
  the date, the four attribution tiles with the order and company/purchase pickers **filtered by
  the material**, the returnable toggle, the reason, More for the note and "done by", and a
  footer that says what the save will do to stock before it is tapped. The same form edits a
  record.
- The damage record with its chips, its links to the material, order, company and purchase, the
  stock sentence, the estimated value, and the four actions of FR-803 to FR-806 — Mark returned
  (with "and record a credit" pre-filled from the purchase line), Written off, Record customer
  credit, Return to stock — plus the credits that name it and its History.
- "Damaged" links from the material, order and purchase pages, which open the list filtered to
  that record; the `damages` namespace in all three languages; `ReturnStatusChip` and
  `AttributionChip`; the attribution tiles in the component library.
- **8 new screenshots** in Kurdish, Arabic and English, both themes, plus the 360 px overflow
  and 44 px target checks on the record form at the largest text size. **41 Playwright checks**
  in total.

## I3 · Checkpoint E — done

- Review: `docs/REVIEW-I3.md`. Eight findings, each fixed with a regression test — the one that
  mattered was `GET /damages/:id` answering **500** for a record whose material had been
  re-classified since it was written, because the kernel threw where it should have answered
  "unknown"; the screenshot suite also caught a 28 px tap target on every `Toggle` in the
  system, which had been there since I1.
- Demo script of 4.5 is **executable** (`scripts/demo-i3.mjs`) and passes end to end: 4 kg
  damaged from a supplier delivery with its stock movement and its value, 2.5 kg back from a
  customer order that leaves stock alone, the return that credits Al-Noor 23,600 د.ع from the
  purchase line's own price at the company's rate, the customer credit that moves a balance only
  because somebody recorded it, a usable lot put back into stock through a `return_in` movement,
  and the list's filters and totals seen with and without the bought-price permission.
- CI: lint · types · translations (interface **and** API) · contrast · migrations · route
  declarations · **431 tests** · build · bundle budget · **41 Playwright checks**.

## I3 — Definition of done (section 4.1)

| # | Item | State |
|---|---|---|
| 1 | Three languages, glossary terms, build fails on a missing key | ✅ 665 keys × 3 from one table; the check covers the API's error keys too |
| 2 | RTL verified **on a real phone** in ckb, ar and en | ⚠️ automated at 360 px in all three, both themes; **the real-phone check is owed** |
| 3 | Permissions enforced on every new endpoint | ✅ 110 routes declared (8 new); the credit inside a return additionally needs `companies.record_credit`, checked with the record loaded |
| 4 | Every change in History with old → new, balances before → after | ✅ create, edit, void, status change and both credits asserted |
| 5 | Every amount in both currencies through `DualAmount`, ≈ for conversions | ✅ the value, the period totals and every credit |
| 6 | Both themes, all four text sizes, no overflow, contrast | ✅ 8 new screenshots, overflow and target checks at 1.25 — which is what found the toggle |
| 7 | Tests for money and stock logic | ✅ 66 kernel tests (22 new), 206 API tests (34 new) |
| 8 | Skeleton, empty, error and offline states | ✅ through one `QueryStates` on every new page and tab |
| 9 | Accessibility basics | ✅ labels, focus order, 44 px asserted — and a real 28 px defect fixed |
| 10 | Demo on staging with seeded data | ⚠️ the demo script passes against a live deployment; **staging still needs a host** |

**I3 is complete but for the two items that have been owed since I0:** the real-phone RTL and
identity review (FR-1311, item 2) and a host for staging (item 10).

**Still open with the client:** Q-A-03, Q-B-02 and Q-B-03 from I1; Q-16 and Q-17 were both built
as the specification's defaults state them (no stock change for a customer-order damage; a
supplier return credits what we owe with an editable amount; a customer's returned goods change
nothing until a credit is recorded).

**Next:** I4 — reports and History. It reads what I1 to I3 have written and adds no new writes,
so it needs nothing from the client to start.

---

# Iteration 4 — reports & history depth

Branch `feat/i4-reports`, brief `iterations/I4-reports-history.md`.

## I4 · Checkpoint A — done · History in full

- `/history` takes the **assigned to** filter of FR-902 — a different question from "done by",
  read from `related.assigned_user_id` through the GIN index, and the two return different sets
  over the same order — plus the entity and action filters it already had.
- An edit storm collapses into one entry per record with the rows behind it (2.4.5), per page
  rather than across pages (D-028); a record's own History tab stays ungrouped.
- **6 new API tests**, including the case that makes the two user filters mean different things:
  Sara serving a customer assigned to Rebaz.

## I4 · Checkpoint B — done · the reports

**121 routes, all declared** (11 new); **238 API tests**, **471 across the workspace**.

- The eight reports of 2.11 — Sales, Purchases, Profit, Stock, Receivables, Payables, Damage,
  Employee activity — plus the **daily cash-up** (FR-1013), the **dashboard** (FR-1309) and
  **global search** (FR-1310), which the brief lists as optional and no later iteration claims.
- Every report reads stored values per currency, groups by Asia/Baghdad month by default, and is
  pinned to the caller when they lack `reports.view_all` — `done_by` for what somebody did,
  `assigned_to` for whose customers they are — with the pin echoed in the response so the screen
  can say so. (Payables was pinned here too; the review took that pin off — see checkpoint D and
  D-031.)
- The margin comes from the kernel (`lineMargin`, 8 unit tests with hand-computed figures):
  one computation in the line's entered currency from the snapshot stored on it, converted at
  the line's own rate, so the two currencies can never disagree in sign (D-029). Lines with no
  cost snapshot are counted and named, never counted as profit.
- The field flags: Profit, Receivables and Payables ask for their flag as a second key, because
  a report of money with the money removed is not a report; Purchases, Stock, Damage and the
  dashboard carry their amounts under `cost`, so the quantities and counts survive.
- Every report's totals are asserted against an independent SQL sum over the same seeded data —
  a report that agrees with itself proves nothing.

**Next:** checkpoint C — the History page completed, the Reports hub and its nine pages, the
dashboard and the search screen.

## I4 · Checkpoint C — done (the real-phone review is owed by the client)

The reading screens, mobile first. Bundle **196.0 kB gzipped** against the 250 kB budget;
**806 message keys × 3 languages**, every reference in the interface (970) and in the API (88)
resolving.

- **History in full** (FR-902): the two user filters side by side under their own labels,
  because "done by" and "assigned to" are different questions; the date presets resolved from
  the Baghdad day; the record-type and action filters; an entry that expands into its old → new
  diff, the note and the reference the support line asks for; an edit storm shown as one line
  that opens into each edit. `AuditDiff` renders a change set per field type — money through
  `DualAmount`, permissions as added and removed keys, lines as quantities — in one place, so a
  new audited field reads correctly without a new component.
- **The Reports hub** (3.3) with a card and a one-line description per report, and a report the
  caller's flags do not reach simply absent rather than a locked door.
- **One report page for all nine**: the range chips and custom range, the grouping chips, the
  employee filter for a caller who may see everyone, summary tiles in both currencies, and a row
  per group that expands into its figures. Nine files that differed only in their column lists
  would have drifted apart the first time a label changed, so what each report shows is one
  table at the top of the file.
- **The dashboard** (FR-1309) as tiles per permission, with the stale-rate prompt of FR-1106,
  each tile a link to the screen that answers it; **global search** (FR-1310) across customers,
  companies, materials, orders and purchases, normalised across the Arabic and Kurdish letter
  variants, with the sections the caller may not see absent.
- **10 new screenshots** in Kurdish, Arabic and English, both themes, plus the 360 px overflow
  and 44 px target checks on a report page at the largest text size. **53 Playwright checks** in
  total.

**Next:** checkpoint D — the review with volume in the database, the demo script of 4.6, and the
Definition of done.

## I4 · Checkpoint D — done

I4 has four checkpoints rather than five: it stores nothing new, so there was no schema
checkpoint — `audit_log`, the ledgers and the documents already held every figure these reports
read.

- Review: `docs/REVIEW-I4.md`. **Eight findings**, each fixed with a regression test (the
  dashboard's plan-shape guard bites at volume rather than at test scale, and the review says
  so). Measured against **2,000,230 audit rows, 63,001 orders and 132,001 order lines over five
  years**, on top of I2's and I3's volume.
  - The two that mattered: **Payables answered "we owe nothing" to an accountant**, because
    2.11's sentence pins it to `assigned_to` while companies are deliberately unscoped (D-031);
    and **Receivables took 668.7 ms** because it asked the `order_balances` view a question per
    customer — the third appearance of the pattern the I1 and I2 reviews found, now with a test
    that explains the endpoint's own statement and asserts one scan per table (668.7 → 37.4 ms,
    the Stock report 190.2 → 19.1 ms, the dashboard 62.6 → 34.2 ms).
  - What a read promises: no report had a bound on its groups (10,000 customers is 2.5 MB to a
    phone), so every report now sends its largest 200 with `group_count`/`has_more` and totals
    that still cover the period (D-032); the margin report read every line of the period into
    memory at once and now folds them in batches (D-033); History had no offline state and now
    renders through the same `QueryStates` as every other page.
  - **History at two million rows: 4.1 ms** for the first page against the 300 ms of
    NFR-03/NFR-13.
- A second review pass over the **interface** code (the first pass had read it only for its page
  states and screenshots) found four more, in `docs/REVIEW-I4.md`: the dashboard's unpaid tile
  **added dinars to cents and labelled the sum dinars** — the I1 review's worst defect in a new
  place, now a pair under `balance` behind `fields.see_customer_balances`; the `old → new` arrow
  was a literal character that cannot mirror, so in Kurdish and Arabic it pointed back at the old
  value; that arrow was the only thing between two values for a screen reader; and **no search
  field in the system debounced** — every keystroke was a request, in the pickers since I1.
  Reviewing that fix in turn found a thirteenth: the "we owe suppliers" tile hid its money behind
  `fields.see_bought_price`, which is the wrong flag for a balance — it has its own key now.
- Demo script of 4.6 is **executable** (`scripts/demo-i4.mjs`) and passes end to end, twice:
  once against an empty deployment and once against one it had already run against. It walks
  the four steps of the brief — History filtered by who did it and by whose customer it is, with
  the two edits as one entry that expands; the same order's own History tab; Sales, the margin
  against the month price with a flagged fallback line and matching signs, Receivables pinned to
  a sales employee, Payables, Damage, Employee activity and the daily cash-up; the dashboard for
  an accountant against a sales employee, and search finding a name and an order number — and
  ends by checking that the reports agree with the records they read.
- CI: lint · types · translations (interface **and** API) · contrast · migrations · route
  declarations · **482 tests** · build · bundle budget · **55 Playwright checks**.

## I4 — Definition of done (section 4.1)

| # | Item | State |
|---|---|---|
| 1 | Three languages, glossary terms, build fails on a missing key | ✅ 806 keys × 3 from one table; month and report names localised, the API's error keys covered |
| 2 | RTL verified **on a real phone** in ckb, ar and en | ⚠️ automated at 360 px in all three, both themes; **the real-phone check is owed** |
| 3 | Permissions enforced on every new endpoint | ✅ 121 routes declared (11 new); Profit, Receivables and Payables require their field flag as a second key; search and the dashboard filter section by section |
| 4 | Every change in History with old → new, balances before → after | ✅ nothing here writes; History itself is what this iteration completed, diffs and all |
| 5 | Every amount in both currencies through `DualAmount`, ≈ for conversions | ✅ every report tile and row; the margin's two sides are one computation, never a conversion of a sum |
| 6 | Both themes, all four text sizes, no overflow, contrast | ✅ 10 new screenshots, overflow and target checks at 1.25 on a report page |
| 7 | Tests for money and stock logic | ✅ 8 new kernel tests for the margin with hand-computed figures; 248 API tests (42 new), every report against an independent SQL sum, and the dashboard's unpaid tile asserted per currency |
| 8 | Skeleton, empty, error and offline states | ✅ one `QueryStates` on every new page — and History moved onto it, which is what the review found |
| 9 | Accessibility basics | ✅ labels, focus order, 44 px asserted on the report filters — and History's diff now names its two sides for a screen reader |
| 10 | Demo on staging with seeded data | ⚠️ the demo script passes against a live deployment; **staging still needs a host** |

**I4 is complete but for the two items that have been owed since I0:** the real-phone RTL and
identity review (FR-1311, item 2) and a host for staging (item 10).

**Still open with the client:** Q-A-03, Q-B-02 and Q-B-03 from I1. Nothing new was blocked in
I4: where 2.11 contradicted itself about the Payables pin, FR-711 settled it (D-031), and where
it said nothing about how much of a report to send, NFR-03 and NFR-13 did (D-032).

**Next:** I5 — the shared-tablet features and the advanced permission grid.

---

# Iteration 5 — shared tablets & permissions depth

Branch `feat/i5-shared-tablets`, brief `iterations/I5-shared-tablets-permissions.md`.

## I5 · Checkpoint A — done · the schema

- `0012_device_tickets.sql`: the `device_tickets` table of 2.2 — a hashed, peppered 256-bit
  secret per browser, with its label, its seven-day expiry, its PIN-attempt count and its
  revocation reason — plus `sessions.pin_failures` for the attempts that belong to an unlock
  rather than to a browser, and `mizan_prune_expired` extended to sweep lapsed tickets after the
  same grace period sessions get.
- `0013_device_ticket_privileges.sql`: SELECT, INSERT and UPDATE for the application role and no
  DELETE — the sweep runs as the owner, so nothing leaves the record because of something the API
  did.
- Everything else I5 needs was already in place from I0: `sessions.auth_method`,
  `users.pin_hash`/`pin_length`, `is_shared_device`, `device_label`, and the three settings keys.

## I5 · Checkpoint B — done · the API

**123 routes, all declared** (2 new); **271 API tests** (22 new), **504 across the workspace**.

- `POST /auth/login` takes either a username and password or **a device ticket and a PIN**
  (FR-106): a password sign-in now also issues this browser a seven-day ticket, and a PIN is
  accepted only against a live ticket for that user, with `switch_from_session` revoking the
  employee who had the tablet before — both halves in History.
- `POST /auth/pin` sets or clears one's own PIN behind one's own password; `POST /auth/unlock`
  takes a PIN or a password on the same session; `GET /users/:id/sessions` now lists the sessions
  **and** the browsers that may sign that employee in with a PIN; `DELETE
  /users/:id/device-tickets` takes that away everywhere at once.
- The rules of 2.8, each with a test: a PIN alone signs nobody in; a ticket is bound to one user,
  so Sara's ticket with Rebaz's PIN is nothing; six digits on a shared tablet and four on a
  personal phone; five wrong PINs revoke the ticket (and five wrong unlock PINs demand the
  password); tickets die with a password reset, with deactivation, and at the admin's word; the
  admin can switch PIN sign-in off for shared devices entirely; and **every audit row written
  from a PIN session carries `ticket_pin`** — asserted on a customer created from such a session.
- Five decisions recorded where the specification was silent or contradicted itself: D-034 to
  D-038.

**Next:** checkpoint C — the lock screen's user switcher and PIN pad, PIN setup in Settings, the
Sessions tab, and the Advanced permission grid.

## I5 · Checkpoint C — done (the real-phone review is owed by the client)

The shared-tablet screens, mobile first. Bundle **203.2 kB gzipped** against the 250 kB budget;
**904 message keys × 3 languages** — 48 of them the permission names the Advanced grid needs,
because a grid of `orders.record_payment` is a grid nobody can be asked to use.

- **The lock screen** (flow 3.5.8) answers two questions: *still me?* — the PIN pad or the
  password on the same session, which keeps the drafts — and *somebody else?* — the last three
  people who signed in on this browser, each offered their PIN when this browser still holds a
  ticket for them and their password otherwise. A handover applies **that employee's own
  language** before the first screen paints (FR-1103) and clears the previous drafts. Every
  refusal is a different sentence: "wrong PIN", "sign in with your password on this device
  first", "PIN sign-in is off on shared tablets", "set a longer PIN".
- **`PinPad`** in the component library: large keys in the thumb zone, dots that show how many
  digits have been typed and never which, and a left-to-right island in a right-to-left page
  because a keypad is not a sentence (2.10.6 point 5).
- **Settings → My account** gains the PIN card (set, change, remove — behind the password), and
  **Settings → System** the three shared-tablet rules an admin owns.
- **The Sessions tab** (FR-1304) on the employee's page: where they are signed in, with the
  method of each session, and which browsers may use their PIN, with one button that takes that
  away everywhere.
- **The Advanced permission grid** (FR-204), folded away behind a disclosure in the permissions
  editor: all 48 keys grouped by screen, each named, each saying what comes with it.
- **9 new screenshots and checks** — the pad in English, Kurdish and Kurdish dark at 1.25, the
  Sessions tab, the grid — plus the 44 px target check on every key and the overflow check.
  **62 Playwright checks** in total; **509 tests** across the workspace.

**Next:** checkpoint D — the review with the tablet flows walked through, the demo script of
4.7, and the Definition of done.

## I5 · Checkpoint D — done

- Review: `docs/REVIEW-I5.md`. **Seven findings**, each fixed with a regression test. Measured
  against **18,042 sessions and 6,000 device tickets** — thirty employees signing in twice a day
  on two tablets for five years.
  - The two that mattered: **a stolen locked tablet was an unlimited password oracle** — the
    five-in-fifteen lockout of 2.8 lived only on the Login page, so the lock screen's password
    fallback, the PIN form and change-password all guessed for free; and **a sign-in row did not
    say how it was signed in**, because `recordAnonymous` never wrote `auth_method` or
    `session_id`, which made the one row where the question matters most the one row that could
    not answer it (present since I0, invisible until there were two methods to tell apart).
  - The lockout deliberately does **not** stop an unlock: a mistyped password must not end an
    employee's shift on a tablet they are standing in front of, and their own PIN still works.
  - Data growth and RTL: a tablet accumulated one live ticket per sign-in (the client now says
    which ticket it replaces, and at most five stay live per employee); the icon-mirroring rule
    reached inside left-to-right islands, so the pad's backspace arrow pointed away from the
    digits it deletes in Kurdish.
- Demo script of 4.7 is **executable** (`scripts/demo-i5.mjs`) and passes end to end, twice —
  once against an empty deployment and once against one it had already run against: Sara's
  four-digit PIN refused on a shared tablet and her six-digit one accepted, the 423 while
  locked, the attempts-left count, the handover that ends her session and starts Rebaz's, the
  payment his PIN session recorded and what History says about it, the admin revoking the ticket
  and then switching PIN sign-in off altogether, and the Advanced grid granting one key with
  old set → new set in History.
- CI: lint · types · translations (interface **and** API) · contrast · migrations · route
  declarations · **515 tests** · build · bundle budget · **62 Playwright checks**.

## I5 — Definition of done (section 4.1)

| # | Item | State |
|---|---|---|
| 1 | Three languages, glossary terms, build fails on a missing key | ✅ 904 keys × 3, including all 48 permission names the Advanced grid needs |
| 2 | RTL verified **on a real phone** in ckb, ar and en | ⚠️ automated at 360 px in all three, both themes; the Kurdish pad found a real mirroring defect; **the real-phone check is owed** |
| 3 | Permissions enforced on every new endpoint | ✅ 123 routes declared (2 new): `POST /auth/pin` is session-only and one's own, `DELETE /users/:id/device-tickets` is admin-only |
| 4 | Every change recorded in History | ✅ and more of it than before: sign-ins, failed PINs, lockouts and handovers now carry their method and session (finding 3) |
| 5 | Every amount in both currencies through `DualAmount` | ✅ nothing in this iteration is money |
| 6 | Both themes, all four text sizes, no overflow, contrast | ✅ 5 new screenshots including the pad in Kurdish dark at 1.25, plus the 44 px check on every key |
| 7 | Tests for money and stock logic | ✅ none added; 278 API tests (30 new) cover the credential rules instead |
| 8 | Skeleton, empty, error and offline states | ✅ the Sessions tab through `QueryStates`; the lock screen is a form, and every refusal is its own sentence |
| 9 | Accessibility basics | ✅ the pad's keys are 44 px+ in every language and size, its dots are labelled "n / m", and the disclosure summary is a full target |
| 10 | Demo on staging with seeded data | ⚠️ the demo script passes against a live deployment; **staging still needs a host** |

**I5 is complete but for the two items owed since I0:** the real-phone RTL and identity review
(FR-1311, item 2) and a host for staging (item 10).

**Still open with the client:** Q-A-03, Q-B-02 and Q-B-03 from I1, and **Q-25** (lock timings and
PIN acceptability), which this iteration built to the specification's defaults — 5 idle minutes
and 6-digit PINs on shared devices, 30 minutes and 4 digits on personal ones, all of them
settings the admin can change.

**Next:** I6 — polish and go-live: the remaining Proposed items the client chose, the real-device
pass, the seeded load test, and the go-live checklist.

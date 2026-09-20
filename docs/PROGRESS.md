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

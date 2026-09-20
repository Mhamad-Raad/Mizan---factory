# Iteration 2 — code review

Reviewed as a senior engineer would before this becomes a system nobody touches for years:
correctness, logical defects, architecture, DRY, web patterns, and how each decision behaves
when the data grows. Every finding below is fixed in this branch, and each has a regression
test that fails against the previous code.

The measurements were taken against synthetic volume in the development database: **49
companies, 60,009 purchases, 120,018 purchase lines and 90,032 company-ledger rows** — about
fifteen years of a single factory buying ten times a day from forty suppliers, with one
supplier holding 1,500 purchases and 2,250 ledger entries. Times are medians of five requests
through the running API, not bare SQL.

## Findings and fixes

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | **High — data growth** | "Is this row still live?" was asked per row as `all.some(other => other.reverses_entry_id === entry.id)`, so finding the live rows of a ledger was **quadratic in that counterparty's whole history**. It sits on the read path of the accounting tab and the per-purchase allocation *and* on the write path of every purchase and order edit and void. At 2,250 entries it cost most of a request; at 20,000 it would be seconds, growing for the life of the system. | One pass builds the set of reversed ids (`reversedEntryIds`, `reversedMovementIds`), and `liveEntries` / `isLive` read it. Measured on the same data: per-purchase breakdown **43.3 ms → 12.0 ms**, `/purchases/:id/balance` **25.9 → 13.3 ms**, the accounting tab **21.7 → 11.0 ms**. A kernel test asserts the shape at 20,000 entries with 2,000 reversals, which the previous code could not finish in any reasonable time. |
| 2 | **High — data growth** | `GET /companies/:id/ledger` returned **every entry the account ever had**: 2,250 rows and **1.7 MB of JSON** for a fifteen-year supplier, to a phone on a factory floor. The filters specification 2.9.3 documents for that route — `type`, `from`, `to`, `done_by` — were not implemented at all. | The filters are implemented, plus a bound (`limit`, default 100, max 500) with `total` and `has_more`. The running balance is still computed over the **whole** ledger in posting order, so the newest row on a filtered page still carries the figure History recorded (2.4.1 rule 5) — asserted. **1,727 kB → 75 kB**, 21.7 → 11.0 ms. The customer ledger from I1 had the same unbounded shape and takes the same `limit`. |
| 3 | Medium — data growth | `GET /companies/:id/purchase-breakdown` sent every purchase of the company, settled ones included: **326 kB and 1,500 rows** to show the handful that are owed. | Only what still owes something travels, oldest first — the order the money goes out in — at most 50 rows by default, with `owing_count`, `owing_total` and `settled_count` so the identity `Σ remaining + General = balance` stays checkable from the response as sent. **326 kB → 11 kB**. |
| 4 | Medium — correctness (FR-712) | The purchases list read each purchase's "remaining" from the ledger rows that happen to name it. FR-712 defines remaining as the total less the linked entries **and less its oldest-first share of everything unlinked**, so a supplier paid with a lump sum saw "remaining 650,000" on the list beside "settled" on the company's own page. | There is one definition and it is the allocation: `/purchases/:id/balance` computes it (total, linked, its share, remaining), the company's breakdown computes it once for the account, and the list carries no remaining column at all — the company's Purchases tab reads each row from the breakdown it already loads (D-024). |
| 5 | Medium — permissions | The money routes asked for one permission where the route table of 2.9.3 asks for two (`companies.view` + `fields.see_company_balances`). A ledger, a statement or a per-purchase breakdown *is* the balance: answering it with the amounts stripped out returns a shape the client cannot render. | `@RequirePermission(...)` takes several keys, all required, and the guard names the first missing one; the route check and the generated matrix read the list, so rule 4 still holds. The same reading closed the I1 gap where `GET /customers/:id/ledger`, its voucher and the statement were gated by `customers.view` alone (D-023). |
| 6 | Medium — field-level flags | A purchase's prices *are* bought prices (1.5.4: users without `fields.see_bought_price` see dates, companies and quantities but no prices or totals). They were scattered across the DTO as `unit_price_iqd`, `line_total_usd_cents`, `total_*`, `discount_*`, so hiding them meant naming a dozen keys — and forgetting one the day a field is added. | Every amount on a purchase travels under one `cost` object — on the document, each line, `/purchases/:id/balance` and the ledger rows of its History — so one rule hides all of it, the way an order line already carries its snapshot. The audit diff adds `unit_price`, `line_total` and `purchase_total`; the document total in `changes` is deliberately **not** called `total`, because that is the pagination key of every list response (D-022). |
| 7 | Medium — translations (rule 6) | The translation check scanned the web app and the component library only, so **seven** error keys the API answers with existed in no catalog — including `errors:order_customer_immutable` and `errors:stock_insufficient` from I1. A user hitting them would have read a bare code in any language. | `scripts/check-i18n.ts` now also scans `apps/api/src` for `message_key: '…'` (74 references) and fails on one that no catalog defines; the seven are written in Kurdish, Arabic and English. |
| 8 | Medium — navigation | "More" in the bottom bar was a link to the *first* hidden destination. With four tabs visible and five or more permitted, History and Settings were unreachable on a phone — which adding Companies and Purchases made true for every admin. | More opens a sheet listing every remaining destination. (The defect predates I2; two new tabs surfaced it.) |
| 9 | Low — settings | `purchase_edit_window_days` has been in the settings schema since I0 but was in neither the editable nor the employee-visible set, so the buying side's edit window could not be set. | Both lists include it, `PATCH /settings` accepts it, and a test pins that an admin can set it and an employee can read it. |
| 10 | Low — test determinism | `TRUNCATE … RESTART IDENTITY` does not touch standalone sequences, so purchase, order, voucher and posting numbers kept counting across test files: a test asserting "voucher #1" read #54 depending on which files ran first. | The harness restarts the six document sequences, as the Playwright fixture already did. |
| 11 | Low — scope of a document | A statement asked for without a period covered the account's whole life, which is both a 1.7 MB answer and not what a statement is. | No period means the last three months, and the response echoes the range it used so the screen can say what the supplier is being handed (D-025). |

## Checked and found sound

- **Money.** Every amount arrives through `@mizan/money`: a purchase's lines follow the
  entered-currency rule at **the company's** rate (a bought price typed in dinars for a
  USD-settled company is valued at 1,310, not at the global 1,300 — asserted), the purchase's
  ledger entry copies both stored totals rather than converting one, a payment typed in either
  currency stores both sides with the rate that made them, an override stores the implied rate
  as `manual`, settle-in-full lands on zero, and the residue on the supplier side is an
  **adjustment** rather than a credit note. Nothing is recomputed from a later rate: the test
  that changes the company rate and re-reads every stored entry byte for byte proves it.
- **Append-only.** `company_ledger` and `company_rates` are INSERT + SELECT for the
  application role, asserted against the live database rather than trusting the grant;
  `purchases` and `purchase_lines` have no DELETE. A re-basing row cannot be reversed even by
  a direct insert: the trigger refuses it.
- **The allocation.** `Σ remaining + General = balance` is a property test over 300 random
  ledgers, and the API asserts the same identity after an edit, a void and a re-basing. An
  explicit link always wins over the spread; an entry of a voided purchase falls into General.
- **History.** Every write path leaves its `audit_log` row with old → new, and every balance
  change carries before/after — including the settlement-currency change, which records the old
  balance in the old currency and the new one at the agreed rate.
- **Scope.** Companies are deliberately unscoped (FR-711): two employees with `companies.view`
  see the same list, which the test asserts rather than assumes.
- **Edit and void.** Both reverse only *live* rows, so an edit after an edit cannot
  double-correct; a void leaves payments standing, because that money did leave the till; the
  8-second undo is its own route so `/void` can stay behind `purchases.void`; moving a purchase
  to another company is refused rather than silently ignored.
- **Concurrency.** A company row is locked before its balance is touched, so two accountants
  paying the same supplier serialise on that row and nobody else waits; a stock-only purchase
  locks nothing, because it has no counterparty.

## Measured, accepted, and worth watching

| Endpoint | At this volume | Shape |
|---|---|---|
| `GET /purchases` (month chip) | 3.5 ms | chosen by `purchases_date_idx`, then 25 rows counted |
| `GET /purchases` (no filter) | 11.9 ms | the whole table ordered by date; the chips bound it in the interface |
| `GET /companies?sort=balance` | 10.2 ms | every company's ledger summed, index-only |
| `GET /companies/:id` | 2.8 ms | one balance, one rate |
| `GET /companies/:id/ledger` | 11.0 ms / 75 kB | one supplier's whole ledger read, a page returned |
| `GET /companies/:id/purchase-breakdown` | 12.0 ms / 11 kB | that ledger plus its 1,500 purchases, allocated |
| `GET /purchases/:id/balance` | 13.3 ms | the same two reads for one purchase's share |
| `GET /purchases/:id` | 3.1 ms | the document and its lines |

- **The covering index only pays once autovacuum has run.** Before the bulk-loaded table was
  all-visible, the companies list summed balances with a bitmap heap scan at **35 ms**; after a
  `VACUUM ANALYZE` the same query is an index-only scan at **6 ms**. Nothing to fix — it is
  worth knowing that the first hours after a large import read slower than the system will.
- **A supplier's own history is its own cost.** The breakdown and a purchase's balance read
  that supplier's entries and purchases: 13 ms at fifteen years for one of forty suppliers,
  linear in that supplier's history. Specification 2.2.6 names the upgrade path — a maintained
  sum refreshed inside the ledger transaction — and it is worth revisiting when one supplier
  passes roughly 20,000 entries.
- **Free-text search over purchase notes** has no index (2.2.5 lists none), exactly as on the
  orders side: `p.notes ILIKE '%…%'` reads the table. The date chips bound it in the interface.
- **`purchase_linked_totals` and `company_balances`** stay as the definitions of 2.2.6 and are
  used for single-row reads only, where the predicate *is* pushed into the aggregate
  (`Index Only Scan … Index Cond`, 0.97 ms) — not from list pages, which is the mistake the I1
  review measured on `order_balances`.

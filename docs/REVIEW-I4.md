# Iteration 4 — code review

Reviewed as a senior engineer would before this becomes a system nobody touches for years:
correctness, logical defects, architecture, DRY, web patterns, and how each decision behaves
when the data grows. Every finding below is fixed in this branch, and each has a regression test
that fails against the previous code.

The measurements were taken against synthetic volume in the development database: **2,000,230
`audit_log` rows, 63,001 orders and 132,001 order lines over five years**, on top of the 60,010
purchases, 90,034 company-ledger rows and 40,003 damage records the I2 and I3 reviews loaded.
Times are medians of five requests through the running API, not bare SQL.

Two things about that fixture, said plainly because the numbers below mean nothing without
them. It is **five years deep**, which is what these reports are for. It is also **fourteen
times below the design point of NFR-13** on orders (500 a day, not 35), so every figure that
scales with the number of orders should be read as a lower bound; NFR-13's own acceptance puts
the seeded load test in I6, and that is where the design point belongs. Where a cost grows with
the data rather than staying flat, the finding says so rather than hiding behind a millisecond
count.

This iteration is almost entirely reads, and the review is shaped accordingly: three of the
eight findings are the same defect — a grouping view asked a question about one row at a time —
one is a report that answered the wrong question about money, and the rest are about what a read
*promises*: how much of it arrives, how much memory it costs, and what it says when the phone
has no signal.

## Findings and fixes

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | **High — data growth** | `GET /reports/receivables` took **668.7 ms**. It joined the `order_balances` view once per customer to count each one's unpaid orders; that view groups every order ever placed, and a predicate on one customer cannot be pushed inside it — so 63,000 orders were aggregated twenty times over. This is the third appearance of the pattern the I1 review found on the Orders list and the I2 review found in the per-purchase breakdown. | Two CTEs: `order_remaining` computes each order's remaining once, `unpaid` counts them per customer once, and the report joins that. **668.7 ms → 37.4 ms.** The regression test takes the statement the endpoint actually issued and asserts two things about it: that it does not reach for `order_balances` at all, and that its plan reads about as many rows out of `orders` as `orders` has — not that many times the number of groups. |
| 2 | **High — data growth** | `GET /reports/stock` took **190.2 ms** for seven materials, because "when was this last sold?" and "when was it first bought?" came from the `item_stats` view as correlated subqueries: the whole of `order_lines` was visited once per material. At 5,000 materials (NFR-13) it does not finish in a time anybody would wait for. | `sold` and `bought` CTEs group once and are joined once. **190.2 ms → 19.1 ms**, and the regression test asserts the same two things: no `item_stats`, and the plan reading 48 rows out of `order_lines` rather than the 1,152 the correlated version read. The two remaining LATERALs — the period's movements and the month price — are per-material *index* lookups, which is what a LATERAL is for. |
| 3 | Medium — data growth | The dashboard's "unpaid orders" tile read the same `order_balances` view, so the first screen after sign-in paid for an aggregate over every order ever placed: **62.6 ms** of a 62.6 ms request. | One grouped pass over the ledger, filtered to the caller's scope before grouping. **62.6 ms → 39.4 ms** (and 34.2 ms once the tiles stopped waiting for each other, finding 8). Guarded the same way, plus a parity test: the tile's count must equal the sum of Receivables' `unpaid_orders`, so the dashboard and the report cannot drift apart. |
| 4 | **High — correctness (money, permissions)** | **Payables answered "we owe nothing" to an accountant.** Section 2.11's sentence says Payables pins `assigned_to`; its table lists no pin. Pinned, a user without `reports.view_all` saw only companies *assigned to them* — and companies are deliberately unscoped (FR-711), their `assigned_user_id` optional and in practice empty. So the report an accountant opens to pay suppliers came back empty, with `pinned` quietly set: an empty state that reads as a fact about the business. | Payables has no pin (D-031); Receivables keeps its `assigned_to` pin, because customers *are* assigned. An unpinned report also ignores `done_by`/`assigned_to` from a caller without `reports.view_all`, so nothing enters by the back door. The test gives an accountant `reports.view` + `fields.see_company_balances` and asserts they see every supplier and the right total. |
| 5 | Medium — data growth (response size) | **No report had a bound on its groups.** Receivables listed every customer — including the ones who owe nothing — and "sales by customer" every customer with an order, *alphabetically*. At the 10,000 customers of NFR-13 that is roughly 2.5 MB of JSON, which on the reference connection of NFR-03 (400 kbps) is the better part of a minute to a phone that can show a screenful; and it arrives sorted by name, so the rows the question was about are scattered through it. The same shape as the I2 review's finding 3, in nine new places. | Every report sums **all** its groups and sends at most 200, with `group_count` and `has_more`; the screen says "the largest 200 of N — narrow the period or the material to see the rest" in all three languages. Groups by a dimension are ordered by their own money, largest first (`sum(o.total_iqd) DESC`), so a cap keeps what matters; month and day groupings stay chronological (D-032). The test creates 214 customers and asserts 200 groups, `group_count` 214, `has_more`, the largest first — and that the **totals still equal an independent SQL sum over all of them**, because a capped report whose totals shrank would be worse than a slow one. |
| 6 | Medium — memory under load | The margin report read **every order line of the period into the API process at once** — 132,001 row objects for five years of the fixture, 1.9 million at the design point — because D-029 keeps the margin in the kernel and the kernel works per line. One report's memory was a function of how wide a range somebody typed, and thirty concurrent users are in scope (NFR-13). | The lines arrive in batches of 50,000 keyed on the line's id, folded into the running per-group totals as they come (D-033). Every figure there is a sum of per-line figures, so the boundaries cannot matter — asserted with a batch size of seven, which puts a boundary inside every group, against the endpoint's own totals. Five years measured **527 ms whole, 580–596 ms batched**: ten per cent of wall clock for a ceiling on memory that no longer depends on the question. |
| 7 | Low — page states | The History page carried a skeleton, an empty state and an error state, but not the **offline** wording: a phone that lost signal on the factory floor was told "something went wrong". Every other page of the system distinguishes the two, because `QueryStates` does it for them — History had been written by hand before that component existed. | History renders through `QueryStates` like every other page, so the four states of Definition-of-done item 8 come from one place and no screen can forget one. |
| 8 | Low — latency | The dashboard asked its seven questions **one after another**, so the first screen after signing in cost the sum of every tile its reader is allowed to see, and an owner's dashboard was slower than an employee's for no reason but the `await`s. | The tiles are independent questions, so they are asked together and assembled in the order the screen reads them; the rate and the stale-rate setting ride along in the same `Promise.all`. **39.4 ms → 34.2 ms**, which is now the cost of the slowest tile rather than of all of them. Under a saturated pool the total database work is unchanged — this buys latency, not throughput, and the connection pool is the bound either way. |

## Checked and found sound

- **Every report against an independent sum.** Twenty-seven tests write the fixture through the
  API and then sum the same period in SQL that does not go near the repository: sales per
  currency and per payment type, purchases and what was paid, the margin from the line
  snapshots, stock against the stock ledger, the customer and company balances, the damage
  totals against the damaged-items list, the employee counts against the documents and the
  audit log, and the cash-up against the ledgers' entered-currency sums. A report that agrees
  with itself proves nothing.
- **The margin's two currencies.** One computation in the entered currency, converted at the
  line's own stored rate, so they cannot disagree in sign — hand-computed in the kernel test
  (750,000 د.ع / 57,252¢) and re-checked through the API. Lines with no cost snapshot are
  counted and named, never counted as profit; a group whose cost came from an earlier month is
  flagged. Editing a past month's price cannot move a margin already reported, because the cost
  is the snapshot on the line.
- **Stored values, never a conversion.** Every total is two sums of stored minor units. The
  demo script asserts the pair and the invariants; the "≈" of a derived figure appears only
  where `DualAmount` puts it.
- **Baghdad months.** Month grouping is `date_trunc('month', business_date)` over a **date**
  column, so it is a Baghdad month by construction, and the new date chips on History and the
  report pages anchor their arithmetic to `formatter.today()` rather than to the process clock —
  the I3 lesson, checked again here.
- **The pinned filter, per report.** `done_by` for Sales, Purchases, Margin, Damage, Employee
  activity and the cash-up; `assigned_to` for Receivables; none for Stock (2.11) and none for
  Payables (finding 4). The pin is applied **over** the query and echoed in the response, so
  asking for somebody else's figures changes nothing — asserted.
- **Field-level flags.** The margin report requires `fields.see_profit` as a second permission
  key, because a margin report with the money stripped is a shape the client cannot render
  (D-023); mixed responses carry their bought prices under one `cost` object so one rule hides
  all of it (D-022). Asserted from the list, the row and the totals of every report that has
  amounts.
- **History at two million rows.** The first page comes back in **4.1 ms** and a page filtered
  by who did it in **3.0 ms**, against the 300 ms of NFR-03/NFR-13, because the keyset index
  carries the order and `assigned_to` goes through the GIN index on `related`. The edit storm is
  grouped per page (D-028) and a record's own History tab is deliberately ungrouped.
- **Search.** Bounded at five hits per section and three per document type, normalised across
  the Arabic and Kurdish letter variants (2.10.7), and every section gated by the permission
  that owns it — a user with `materials.view` alone finds materials and nothing else, asserted.
- **Append-only.** Nothing in this iteration writes a ledger. The reports are `SELECT`s and the
  dashboard is `SELECT`s; the one write path touched is none.

## Measured, accepted, and worth watching

| Endpoint | At this volume | Shape |
|---|---|---|
| `GET /history` (first page of 2,000,230) | **4.1 ms** / 47 kB | keyset index, no count |
| `GET /history?done_by=` | 3.0 ms / 53 kB | the same index, filtered |
| `GET /dashboard` | 34.2 ms / 0.5 kB | one grouped pass per tile the caller may see, asked together |
| `GET /search?q=` | 2.5 ms | bounded per section |
| `GET /reports/sales` (month) | 5.9 ms | `orders_date_idx` |
| `GET /reports/sales` (year) | 8.5 ms | one grouped pass |
| `GET /reports/sales?group_by=item` (year) | 36.7 ms | 132,000 lines grouped by material |
| `GET /reports/purchases` (year) | 8.9 ms | 60,000 purchases |
| `GET /reports/profit` (month) | 28.7 ms | the kernel over the month's lines |
| `GET /reports/profit` (year) | 89.8 ms | ~26,000 lines |
| `GET /reports/profit` (five years) | **595.8 ms** | 132,001 lines, batched |
| `GET /reports/stock` | 20.4 ms | two grouped CTEs + two index LATERALs |
| `GET /reports/receivables` | 37.4 ms | one pass over the customer ledger |
| `GET /reports/payables` | 27.3 ms | one pass over 90,000 company-ledger rows |
| `GET /reports/damage` (year) | 8.5 ms | `damages_totals_idx`, index-only |
| `GET /reports/employee-activity` (month) | 10.3 ms | per-employee subqueries over date indices |
| `GET /reports/cash-up` (today) | 3.8 ms | one day of two ledgers |

- **The margin report is the one whose cost grows with the number of lines, and it is the one
  to watch.** 27 ms for a month, 90 ms for a year, 596 ms for five years at 132,000 lines — of
  which 291 ms is reading the rows and 218 ms is the kernel folding them. At the design point of
  NFR-13 a *year* is around 380,000 lines, so the year case lands in the region of a second and
  the five-year case in several. It is bounded in memory (D-033) and it is honest arithmetic, but
  if an owner starts opening five-year margins on a phone the answer is the same upgrade path
  2.2.6 names for maintained totals: a per-line margin snapshot, written by the kernel at save
  time beside the cost snapshot it already stores, which turns the report into a grouped SQL
  sum. That is a migration, a backfill and a write-path change, which is not a review's work;
  it is written down here so the next person does not have to rediscover the arithmetic.
- **Everything else on this list is flat or grows with the answer, not the archive.** The
  reports that read ledgers and documents are single grouped passes over date-indexed columns;
  the caps of finding 5 bound what crosses the wire whatever the factory's size.
- **`GET /reports/sales?group_by=item` at 35.8 ms** is the widest grouped pass here (every line
  of a year). It stays a scan by definition; the index cannot help a sum of everything.
- **The dashboard is one query per tile the caller may see, asked together** (finding 8), so the
  request costs its slowest tile — the unpaid one. A tile nobody may see is not queried at all,
  which is why a sales employee's dashboard is cheaper than an owner's.
- **Tests.** Two consecutive clean runs of the whole suite (479 tests across 28 files: 246 API,
  the rest kernels and the interface), the 53 Playwright checks at 360 px in three languages and
  two themes, and the demo script of 4.6 twice against a live deployment — once on an empty
  database and once on a database it had already run against, because a demo that only works on
  a fresh database is a demo that does not work on staging.

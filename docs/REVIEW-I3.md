# Iteration 3 — code review

Reviewed as a senior engineer would before this becomes a system nobody touches for years:
correctness, logical defects, architecture, DRY, web patterns, and how each decision behaves
when the data grows. Every finding below is fixed in this branch, and each has a regression
test that fails against the previous code.

The measurements were taken against synthetic volume in the development database — **40,003
damage records over five years**, on top of the 60,000 purchases and 90,000 company-ledger rows
the I2 review loaded — as medians of five requests through the running API.

This was a smaller iteration than I2, and the review found fewer things. Two of them matter.

## Findings and fixes

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | **High — correctness** | `GET /damages/:id` answered **500** for a record whose material had been re-classified since it was written. A material's pricing unit is editable (`PATCH /items/:id`), so a record that carries kilos can find itself on a material now priced per piece — and the kernel *threw* (`RangeError: a line priced per piece must carry qty_count`) when it tried to value it. Found by reading the volume data back, which is exactly the shape a re-classification leaves behind. | The kernel answers **unknown** where it cannot answer: `damageValue` returns a null value with source `none`, and `damageCreditValue` returns null so the credit sheet asks for the figure that was agreed instead of pre-filling one. The record opens, its quantities and dates still read, and an edit that supplies the measure the material is now priced in values it again — no void needed. Three kernel tests and an API test that re-classifies the material between the write and the read. |
| 2 | Medium — data growth | The list's period totals and its row count joined the **material, employee, company, order, customer and purchase** tables, because they were built from the same `FROM` clause as the list. Postgres drops the unused left joins, but `JOIN items` it cannot drop — and that one join costs the covering index, so the sums read the heap: a bitmap heap scan instead of an index-only scan. | The count and the totals are built without the joins unless the free-text filter needs the material's name, so `damages_totals_idx` serves them index-only. Measured for a month at 40,000 records: **13.8 ms → 10.7 ms** end to end (the aggregate itself 0.26 ms → 0.19 ms, and it no longer touches the heap). |
| 3 | Medium — accessibility | The `Toggle` switch — "Can it be returned?", "Settle in full", every toggle in the system since I1 — had a **28 px** tap target where the minimum is 44 (NFR-10). The label row was 48 px, so it read as fine; the thing you actually press was not. Found by the screenshot suite's target check on the damage form, which is the first form to carry a toggle. | The button is `var(--tap-target)` tall and the 28 px pill is drawn by a pseudo-element inside it, so the switch looks the same and the target is a target. The check now covers a form with a toggle on it, so it cannot come back. |
| 4 | Low — layout | On the Damaged items list the trailing chip column (attribution + return status + void) squeezed the row body until the material's name broke one word per line at 360 px in Kurdish — the same defect the I1 review found on order rows, in a new place. | Everything moved into the row body, with the chips flowing under the reason. The name keeps the full width. |
| 5 | Low — wording | The tab label read "کاڵا زیانلێکەوتووەکان" — the full glossary term — which wrapped over two lines in a five-tab bar at 360 px and collided with its neighbours. | A `tab_label` key with one word per language (Damaged / التالف / زیان); the page keeps the full term as its title. |
| 6 | Low — layout | The damage record's header put the material's name beside its chips, which squeezed the name on a phone (the same shape as finding 4). | Name, then what and when, then the chips on their own row — the order the page is read in. |
| 7 | Low — wording | A saved record said "Stock **will** decrease by 4.000 kg", the same sentence the form shows before saving. | The record says "Stock decreased by …"; the form keeps the future tense, because that is the one place it is a prediction. |
| 8 | Low — correctness | The form's stock sentence printed the text as typed ("4 kg") rather than the quantity that would be stored ("4.000 kg"), so the sentence and the record disagreed by a formatting detail. | The typed text is normalised to three decimals before it is formatted, which is what the save will store. |

## Checked and found sound

- **The stock effect.** `none` exactly when the goods had already been sold, `reduced` otherwise,
  `returned_in` only through the explicit action — asserted per attribution in the kernel, at the
  API, and by the database's own `damages_stock_effect` constraint, which the test suite proves
  by trying to insert the contradiction directly.
- **The attribution links.** The API refuses an order or company that does not exist, a voided
  document and a purchase belonging to another company; the database refuses any record whose
  attribution and links disagree, in both directions. What is deliberately *not* checked is that
  the document still contains the material (D-026).
- **Money.** A damage record writes none. A return to a supplier is an ordinary company credit
  through the one ledger writer — locked, balanced before and after, audited — that names the
  damage record and the purchase; a customer's returned goods change nothing until somebody
  records a credit, which names the damage record and the order. Both are validated to belong
  to the account they are recorded against, which is what the I2 review taught about linked ids.
- **The value snapshot.** Quantity × the month's bought-price *pair as stored*, flagged when it
  came from an earlier month, unknown rather than zero when no month has one — the same
  discipline as an order line's cost snapshot, so editing a past month's price cannot rewrite
  what a period lost.
- **The return state machine.** Pending → Returned → Returned & credited, or Written off; both
  ends terminal, nothing reachable from `not_returnable`, and a second credit refused rather
  than silently ignored. Twelve kernel cases.
- **Edit and void.** Both reverse only *live* movements, so an edit after an edit cannot
  double-correct. A record is frozen once its return has been recorded (D-027), because the
  supplier has the goods and the ledger has the credit.
- **Field-level flags.** The value of a record and the value of a period are bought prices:
  both travel under `cost` and are stripped together, while the material, the quantities, the
  dates and the chips stay readable — asserted from the list, the row and the totals.
- **Tests.** Two consecutive clean runs of the API suite (206 tests), after the I2 lesson about
  trusting a suite before trusting its results.

## Measured, accepted, and worth watching

| Endpoint | At 40,000 records | Shape |
|---|---|---|
| `GET /damages` (this month) | 10.7 ms / 22 kB | chosen by `damages_date_idx`, totals index-only |
| `GET /damages` (no range) | 19.9 ms | summing every record ever, by definition a scan |
| `GET /damages?return_status=pending` | 17.5 ms | a third of the table is pending in this fixture |
| `GET /damages?item_id=` | 16.5 ms | one material's whole history |
| `GET /damages/:id` | 4.7 ms / 1 kB | the record, its credit pre-fill and its credits |
| `GET /orders?item_id=` (the picker) | 3.0 ms | `EXISTS` over `order_lines_item_idx` |
| `GET /purchases?item_id=` (the picker) | 19.9 ms | `EXISTS` over 60,000 purchases' lines |

- **"All time" totals are a scan, and that is what they are.** Summing 40,000 records takes
  22 ms of the 19.9 ms request (the index cannot help a sum of everything); the list opens on
  *this month*, where it is 0.19 ms. Specification 2.2.6's upgrade path — a maintained total —
  is available if an owner ever asks for all-time totals on a dashboard.
- **The purchase picker is the slowest thing here** at 19.9 ms, because it asks 60,000
  purchases which of them carried this material. It is a picker behind a sheet, opened
  deliberately, and the answer is paginated; worth revisiting if purchases pass a few hundred
  thousand.
- **A damage record's credit pre-fill reads one purchase line and up to two years of price
  rows.** Both are indexed lookups; the cost is flat in the size of the system.

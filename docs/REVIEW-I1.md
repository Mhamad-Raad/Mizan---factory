# Iteration 1 — code review

Reviewed as a senior engineer would before this becomes a system nobody touches for years:
correctness, logical defects, architecture, DRY, web patterns, and how each decision behaves
when the data grows. Every finding below is fixed in this branch, and each has a regression
test that fails against the previous code.

Three of the findings were caught by the screenshot suite rather than by reading, which is
the argument for having it.

## Findings and fixes

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | **High — money** | A cash order whose received amount was given **in the settlement currency** wrote that amount into the *other* column: handing over 84,900 د.ع on an 85,000 د.ع order stored −84,900 **cents**, an $849 settlement, and the dollar figure of the day was wrong from then on. | In the settlement currency the settlement is the exact negation of the order entry in both columns; a different amount handed over in the same currency is refused with `RECEIVED_AMOUNT_OUT_OF_TOLERANCE { reason: 'same_currency' }`, because it is a discount (FR-616) or a part payment, not a rate. |
| 2 | **High — data growth** | The Orders list joined the `order_balances` view. A predicate on `orders.order_date` cannot be pushed inside that view's `GROUP BY`, so showing today's 25 orders aggregated **every order ever placed**: measured at 60,000 orders, 85 ms with an external merge sort spilling 7 MB to disk, growing linearly for the life of the system. | The remaining amount and the derived status are read per row through a LATERAL, so the page is chosen by `orders_date_idx` first and only those rows are summed. Measured on the same data: **1.4 ms**, and flat in the size of the ledger. The view stays as the definition of 2.2.6 and for single-order reads, where the predicate *is* pushed down. |
| 3 | **Medium — data growth** | The per-item and per-customer sums (a material's stock, a customer's balance, an order's remaining) read the amounts from the heap, because no index carried them. One material with 30,000 movements cost 12 ms per row of the Materials list. | Three covering indices — `customer_ledger (customer_id) INCLUDE (amount_iqd, amount_usd_cents)`, the same on `(order_id)`, and `stock_ledger (item_id) INCLUDE (qty_count, qty_kg)`. The sums are now index-only scans: 12.3 ms → 2.6 ms per item on the same data. |
| 4 | **Medium — logical** | Reversing a payment that belonged to an order voided *afterwards* answered 409 `DOCUMENT_VOID`. That is precisely the case FR-610 describes — the payment stays as credit and is handed back — so the one action the specification asks for was refused. | The status lookup after a write reads the order's state whether it is active or void; only *new* payments still refuse a voided order. |
| 5 | **Medium — scope** | An employee who entered an order could no longer record a payment against it once the customer had been reassigned: the order was in their scope, the customer was not, and the customer-level check refused with 404. | The orders route passes `authorisedByOrder` after its own scope rule has let the caller through. A general payment, which names no order, still obeys the customer scope. |
| 6 | **Medium — presentation** | A reversed payment followed by a corrected one collapsed into a single "edited" row showing only the new amount — hiding both that a payment had been undone and that another had arrived. Only *documents* are edited (2.4.5). | The (entry → reversal → replacement) chain is followed for `order`, `cash_settlement` and `purchase` rows only; a reversed money row is "undone". |
| 7 | Medium — accessibility | Segmented-control options were 40 px tall where the minimum is 44 (NFR-10), which is every payment-type and "Paid in" control on the order form. | `min-block-size: var(--tap-target)`; the screenshot suite asserts every control on the form. |
| 8 | Medium — layout | The sticky totals footer sat *behind* the fixed bottom tab bar, so the Save button of the order form was partly unreachable on a phone. | Both now share a `--tabbar-height` token: pages reserve it and the footer sits on top of it. |
| 9 | Medium — layout | A list row's trailing cell (amount plus chips) squeezed the row body until the title wrapped one character per line at 360 px. | One `.mz-list__end` class with a width bound; amounts moved into the body on the rows that carry chips too. |
| 10 | Low — correctness | A saved order line never carried the "from August" marker of FR-306: the field existed in the response and was always `null`. | The line query joins its month price; the marker is set when that month differs from the order's own. |
| 11 | Low — correctness | `PUT /orders/:id` accepted a different `customer_id` and silently ignored it, so a mis-tap read as a successful edit. | Refused with `IMMUTABLE`: moving a debt between two customers is a void and a new order. |
| 12 | Low — correctness (I0) | The first-boot seed passed one query parameter as both a `uuid` and a `text` column, so the audit insert failed **every time**: the first admin existed with no record of being created, which rule 3 forbids. The failure was invisible because the script had already inserted the user. | The id is passed twice, the user and its History row commit in one transaction, and `seed.test.ts` pins both. |
| 13 | Low — correctness (I0) | The system settings were cached in-process for five seconds. A setting here is a *rule* (`locked_through`, `allow_negative_stock`): with a second API replica, one keeps applying the old rule — the defect the I0 review found in the permission cache. | Read per request; it is a primary-key scan of a dozen rows. |

## Checked and found sound

- **Money.** Every amount still arrives through `@mizan/money`: line totals follow the
  entered-currency rule (the 850 IQD/kg × 5,000 kg case is asserted at $3,244.27, not the
  $3,250 a rounded unit price gives), document totals are sums per currency, the order's
  ledger entry copies both stored totals rather than converting one, and settle-in-full lands
  on zero in both of its shapes. No stored figure is ever recomputed from a later rate: the
  test that edits a past month's bought price and re-reads the order's cost snapshot proves it.
- **Append-only.** `customer_ledger`, `stock_ledger`, `global_rates` and
  `order_payment_type_changes` are INSERT + SELECT for the application role, asserted against
  the live database rather than trusting the grant. The mutable tables have no DELETE at all.
  A re-basing row cannot be reversed even by a direct insert: a trigger refuses it.
- **History.** Every write path was checked to leave its `audit_log` row with old → new, and
  every balance change to carry before/after — including the ones that are easy to forget: the
  payment-type switch, the settlement-currency change (which records the old balance in the old
  currency and the new one at the agreed rate), and the per-material rows of a price copy.
- **Scope.** Out of scope answers 404, never 403, on customers and orders alike; the duplicate
  check deliberately ignores scope and names the assignee; an employee keeps seeing the orders
  they entered after a reassignment.
- **Edit and void.** Both reverse only *live* rows, so an edit after an edit cannot
  double-correct; a void leaves payments standing as credit; the 8-second undo is its own route
  so `/void` can stay behind `orders.void` and the generated matrix test keeps proving it.

## Measured, accepted, and worth watching

- **A material's own history.** Summing one material's movements is its own cost: with 30,000
  movements the card takes ~2.6 ms after the covering index, and it grows with that material's
  history. Specification 2.2.6 names the upgrade path (a maintained sum refreshed inside the
  ledger transaction). Worth revisiting when a single material passes ~100,000 movements.
- **Free-text search on order notes.** `o.notes ILIKE '%…%'` has no index (2.2.5 lists none):
  at 60,000 orders a notes search reads the table. The date chips bound it in the interface,
  and a trigram index on `notes` is a one-line migration if the client searches notes often.
- **Filtering by a derived status** costs one index-only lookup per candidate order, so the
  "Unpaid" chip is cheap when combined with a date chip (the default) and linear when not.
  That is inherent to deriving status from the ledger, which is the rule that keeps it honest.

# Mizan — Iteration 1 — Materials, customers & orders (selling) (standalone brief)

This brief is extracted verbatim from `spec/mizan-factory-system-spec-v1.2.md`. Section numbers refer to that document, which must be available to you in full; `spec/2-architecture.md` and `spec/3-ux-ui-direction.md` are the same text split by deliverable.

## Read these sections of the specification first

1. 1.3.3 Materials & Stock, 1.3.5 Customers, 1.3.6 Orders & Payments (FR-301 to FR-310, FR-501 to FR-507, FR-601 to FR-617), FR-1106, FR-1109, FR-1013 context
2. 2.2 tables: items, item_month_prices, global_rates, customers, orders, order_lines, order_payment_type_changes, customer_ledger, stock_ledger; views 2.2.6
3. 2.3 money model in full (entered-currency rule, document rate, settle in full, discount), 2.4 ledgers and presentation rules, 2.5 stock model and edit/void algorithm
4. 2.6.4 scope rules, 2.9.3 endpoints for items, settings/global-rates, customers, orders (and receipt/voucher/statement if kept)
5. 2.10.7 search normalisation, 2.10.11 components
6. 3.3 rows for Materials, Material detail, Orders, New order, Order detail, Customers, Customer profile; 3.4.1 wireframe; flows 3.5.1, 3.5.4, 3.5.7; 3.6 signature moments 1 and 3
7. Outcome of the materials workshop (Q-37) — must be recorded before starting

## 4.1 Definition of done (applies to every iteration)

An iteration is done only when all of the following hold for everything it delivered:

1. **Three languages**: every new string exists in `ckb-IQ`, `ar-IQ` and `en`, uses the glossary terms (section 1.6), and the build's missing-key check passes.
2. **RTL verified on a real phone**: every new screen checked in Kurdish and Arabic (RTL) and English (LTR) on a physical Android phone at 360 px; icons, animations, gestures, numeric inputs and currency placement follow section 2.10.6.
3. **Permissions enforced on the backend**: every new endpoint carries a permission decorator or `@AdminOnly()`, the generated permission-matrix test covers it, and the UI hides what the user cannot do.
4. **Every change recorded in History**: every new write path produces the expected `audit_log` rows (with old → new and the note where one exists) and, for balances, the before/after values; tests assert it.
5. **Every amount shows both currencies** through `DualAmount`, with ≈ for converted balances; stored values carry both currencies and the rate.
6. **Both themes and all four font sizes checked** on every new screen (automated screenshots for the eight key screens, manual check for the rest), with no horizontal overflow and contrast per the token sheet.
7. **Tests for any money or stock logic added** (unit + API integration), and the whole suite green in CI.
8. **States**: every new page has its skeleton, empty, error and offline states implemented as in section 3.3.
9. **Accessibility basics**: labels, focus order, 44 px targets, reduced-motion behaviour.
10. **Demo on staging** with seeded data, walked through with the demo script, and the client's feedback recorded as new open questions or tickets.

## 4.3 Iteration 1 — Materials, customers & orders (selling)

**Goal.** Deliver the factory's daily activity end to end: materials with pricing unit and monthly price lists in both currencies, the global rate, customer profiles with assignment and scoping, order creation with lines, discount, payment type, the currency received on cash orders, partial payments and settle-in-full, derived order status, customer ledger and balance, edit/void with compensating movements, opening stock and opening customer debts — and, if kept, the order receipt, payment voucher and customer statement.

**User-visible outcome.** A sales employee creates a borrowed order on a phone in under a minute and shares the receipt; records a partial payment and later settles the rest in dollars with no residue; the customer's balance and the order status follow; stock and "last sold" update; the admin sees who did what and can hand a customer a statement.

**Scope.**

- *Data (2.2):* `items`, `item_month_prices`, `global_rates`, `customers` (incl. the seeded "Walk-in customer" — **Proposed — not requested** — and `credit_limit_*` — **Proposed — not requested**), `orders` (with `rate_iqd_per_usd` "rate for this order", `discount_*` — **Proposed — not requested**), `order_lines` (with the cost snapshot `cost_unit_*`, `cost_source`), `order_payment_type_changes`, `customer_ledger` (incl. `voucher_number` and `method` — **Proposed — not requested**), `stock_ledger` (`sale_out`, `opening`, `adjustment`, `reversal`), views `customer_balances`, `order_balances`, `ledger_running` (posting order), `item_stock` (priced measure + completeness flags), `item_stats`; sequences `order_number_seq`, `voucher_number_seq`; trigram indices on `items.name_normalized` and `customers.name_normalized`; settings `allow_negative_stock`, `rate_guard_percent`, `order_edit_window_days`, `allow_edit_after_payment`, `settle_tolerance_*`, `default_customer_currency`, `locked_through` (**Proposed — not requested**, FR-1109), `rate_stale_days` (**Proposed — not requested**).
- *Kernel:* `money` in real use (entered-currency-authoritative line totals, document rate, discount pair, settle-in-full manual-rate pairs); `ledger` customer writer (`order`, `cash_settlement` with received currency, `payment`, `credit`, `refund`, `adjustment`, `opening`, `reversal`) with before/after audit values and per-customer row locking; stock `sale_out`, `opening`, `adjustment`; order status derivation (2.4.3); payment-type switch (FR-605); edit/void algorithm (2.5.3) including the period-lock check; month-price lookup with silent carry-forward (FR-306); cost snapshot on lines (FR-602); ledger presentation grouping (2.4.5).
- *API (2.9.3):* `/items` (list with stock and this month's prices, create, read, update, deactivate, reactivate, soft delete), `/items/:id/prices`, `PUT /items/:id/prices/:month`, `/items/prices/copy-month`, `/items/:id/movements`, `/items/:id/opening-stock`, `/items/:id/stock-adjustments`, `/items/:id/history`; `/settings/global-rates` (get, post); `/customers` (list with scope, create with auto-assignment, read, update, deactivate, reactivate, soft delete), `PUT /customers/:id/assignment`, `PUT /customers/:id/settlement-currency` (admin, re-basing rule), `/customers/:id/ledger` (grouped, `as_of`), `/customers/:id/orders`, `/customers/:id/payments` (with `settle_in_full`, `split` — **Proposed**), `/customers/:id/credits`, `/customers/:id/refunds`, `/customers/:id/adjustments`, `/customers/:id/opening-balance`, `/customers/:id/ledger/:entry_id/reverse`, `/customers/:id/history`; `/orders` (list with filters and scope, create with `received_currency`, `rate_iqd_per_usd?`, `discount?`, read, put within the rules, void, payment-type, payments, history); **Proposed — not requested:** `GET /orders/:id/receipt`, `GET /customers/:id/ledger/:entry_id/voucher`, `GET /customers/:id/statement`.
- *Frontend (3.3, 3.4.1):* Materials list, Material detail (Overview, Prices with `MonthPriceEditor` and copy-last-month, Movements, History tab), New material sheet, Settings → System (global rate + history, stale-rate prompt if kept, period lock if kept), Customers list, Customer profile (Overview, Orders, Ledger with `LedgerList` grouping, History tab), New customer sheet, Orders list with date chips and filter sheet, New order form (customer picker, `PaymentTypeChip` segmented control with "Paid in", line cards, "More" with notes / rate for this order / done by, `TotalsFooter` with round-down if kept, drafts), Order detail (Lines, Payments with Record payment sheet incl. Settle in full, History incl. payment-type history), Change payment type sheet, Credit/Refund sheet, Opening balance sheet, Assign sheet, `OrderStatusChip`; **Proposed:** receipt/voucher/statement share sheets, split-payment sheet, credit-limit warning.
- *Permissions consumed:* `materials.view/create/edit/set_prices/opening_stock`, `settings.set_global_rate`, `orders.view/create/edit/void/change_payment_type/record_payment/credit`, `customers.view/view_all/create/edit/assign/opening_balance`, `fields.see_bought_price`, `fields.see_customer_balances`; scope rule 2.6.4.

**Explicitly out of scope.** Companies, purchases and company accounting (I2), damage and customer credits *from damage records* (I3 — the credit endpoint exists now), Reports and History tabs on records (I4), PIN quick sign-in (I5).

**Acceptance criteria.**

- FR-301 to FR-309, FR-501 to FR-507, FR-601 to FR-612, FR-205 (customers), FR-904 (customer side), FR-1106, FR-1107 (System), FR-1205 (materials, customers) meet their acceptance criteria; optional FR-310, FR-613, FR-614 and FR-615 (customer side), FR-616 (orders), FR-617 (customer side), FR-1109 if kept.
- Automated tests: line totals per the entered-currency rule (the 850 IQD/kg × 5,000 kg case); document rate change recomputes non-overridden lines only; cash order → order + cash_settlement with received currency, status Paid; borrowed → Unpaid → partial → Paid; settle in full leaves zero; switch both directions with note and history; void with and without payments (credit remains); edit → reversals + new; period lock refuses back-dated writes; scope: assigned-only employee cannot open another customer's order (404) and the duplicate warning names the assignee; customer balance invariant; running balance equals History before/after; cost snapshot stored per line and unchanged by a later price edit; silent carry-forward marker; negative stock warn/block setting.
- Order form usable one-handed at 360 px in Kurdish; three-line order saved in ≤ 60 s by a trained user in a timed session; saving on a throttled phone completes in ≤ 1.5 s after tap and is safe to retry.

**Demo script.**

1. As admin: set the global rate 1,310; create materials "Steel sheet 1.2 mm" (per piece) and "Copper wire 2 mm" (per kg); set September's bought and sale prices typing IQD and watching USD fill; record opening stock with a note.
2. Create customer "Kawa Trading" assigned to Rebaz; record an opening balance of 450,000 د.ع with a note.
3. As Rebaz (Sales preset) on a phone in Kurdish: New order for Kawa, two lines, borrowed; watch the totals; round the total down (if kept); save → Unpaid; share the receipt (if kept); stock decreased; "last sold" on the material.
4. Record a partial payment of 300,000 → Partially paid; ledger shows the running balance and the voucher number (if kept).
5. Settle the rest in dollars with "Settle in full" → Paid, zero residue; show the manual-rate pair on the entry.
6. Create a cash order for the Walk-in customer (if kept) paid in USD; show it is Paid immediately and that the customer's ledger tab is absent while the Orders list shows it.
7. Edit yesterday's order (still unpaid) → movements show reversal + new; void another with a reason → stock restored, the earlier payment remains as credit; record a refund.
8. Sign in as another Sales employee: Kawa is not visible; try to create "Kawa Trading" again → "exists, assigned to Rebaz — ask your admin"; as admin grant "Sees all customers" → visible.
9. Set the period lock to last month (if kept) and show a back-dated order being refused with the lock date.

**Risks and dependencies.** Depends on I0. The materials model decision (Q-37) must be settled first. Client answers to Q-06, Q-07 (prices), Q-10 (partial payments), Q-12 (cash orders in the ledger, walk-in customer), Q-13 (edit rules), Q-23 (receipts, vouchers, statements, discount) — all reversible by settings, labels or by dropping Proposed items.

**Size.** L.

## Rules for the agent

- Do not ask questions in chat. When the specification is silent or ambiguous, choose the option its assumptions and defaults point to, record the decision in `docs/DECISIONS.md` with the section relied on, and continue. Genuine blockers go into `docs/QUESTIONS.md` with your proposed default.
- Keep `docs/PROGRESS.md` current at every checkpoint (done, next, test counts).
- Never store money as floating point; never update or delete a ledger or audit row; every route carries a permission decorator or `@AdminOnly()`; never use physical left/right CSS; every string goes through the message catalogs in all three languages; every amount renders through `DualAmount`.
- Build only what this iteration lists. Nothing from later iterations and nothing from section 2.15, even if it seems small.
- Finish with the demo script of this iteration run on staging, and the Definition of done ticked item by item in `docs/PROGRESS.md`.

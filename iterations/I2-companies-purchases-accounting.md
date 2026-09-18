# Mizan — Iteration 2 — Companies, purchases & company accounting (buying) (standalone brief)

This brief is extracted verbatim from `spec/mizan-factory-system-spec-v1.2.md`. Section numbers refer to that document, which must be available to you in full; `spec/2-architecture.md` and `spec/3-ux-ui-direction.md` are the same text split by deliverable.

## Read these sections of the specification first

1. 1.3.4 Purchases, 1.3.7 Supplier Companies & Accounting (FR-401 to FR-408, FR-701 to FR-712), FR-614/615/616/617 company side
2. 2.2 tables: companies, company_rates, purchases, purchase_lines, company_ledger; views company_balances, purchase_balances
3. 2.3.3 rate selection, 2.3.5 settlement currency and re-basing, 2.4.2 mapping of "change how much you owe", 2.4.5 presentation rules
4. 2.9.3 endpoints for companies and purchases
5. 3.3 rows for Add material / Purchase, Purchase detail, Purchases, Companies, Company profile & accounting; 3.4.2 wireframe; flows 3.5.2, 3.5.3, 3.5.6

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

## 4.4 Iteration 2 — Companies, purchases & company accounting (buying)

**Goal.** Deliver stock-in and supplier accounting: company profiles with settlement currency and rate history, the "Add material" purchase flow with lines and the rate for this purchase, stock movements, the company ledger with what we paid and what we owe per purchase (oldest-first allocation), payments with automatic conversion and settle-in-full, manual adjustments of the owed amount with mandatory notes, manual credits, opening company debts — and, if kept, company payment vouchers and statements.

**User-visible outcome.** A warehouse employee adds a purchase from a company on a phone in under a minute; stock and first-bought dates update; the accountant sets the company's rate, records a payment typing in either currency, adjusts the owed amount with a note, sees per-purchase remaining amounts without linking anything, and hands the supplier a statement.

**Scope.**

- *Data (2.2):* `companies`, `company_rates`, `purchases` (with `rate_iqd_per_usd` "rate for this purchase", `discount_*` — **Proposed**), `purchase_lines`, `company_ledger` (all types incl. `settlement_change`), `stock_ledger.purchase_in`, views `company_balances`, `purchase_balances` (FIFO display allocation), `item_stats.first_bought_on`; sequence `purchase_number_seq`; trigram index on `companies.name_normalized`; settings `purchase_edit_window_days`.
- *Kernel:* company vs global rate selection (2.3.3); ledger company writer (`purchase`, `payment`, `adjustment`, `credit`, `opening`, `settlement_change`, `reversal`) with before/after audit values and per-company row locking; reconciliation identity with oldest-first allocation (FR-712); edit/void reused from I1.
- *API (2.9.3):* `/companies` (list, create, read, update, deactivate, reactivate, soft delete), `PUT /companies/:id/settlement-currency` (admin, re-basing rule), `PUT /companies/:id/assignment`, `/companies/:id/rates` (get, post with ±20 % guard), `/companies/:id/ledger` (grouped, `as_of`), `/companies/:id/purchases` (with paid/remaining), `/companies/:id/payments` (with `settle_in_full`, `split` — **Proposed**), `/companies/:id/adjustments`, `/companies/:id/credits` (manual, `damage_id` optional), `/companies/:id/opening-balance`, `/companies/:id/ledger/:entry_id/reverse`, `/companies/:id/history`; `/purchases` (list, create, read, put within the rules, void, history), `/purchases/:id/balance`; **Proposed — not requested:** `GET /companies/:id/ledger/:entry_id/voucher`, `GET /companies/:id/statement`.
- *Frontend (3.3, 3.4.2):* Companies list with balances and "highest balance first", Company profile (Overview with rate and "since", Rate history sheet, Set rate sheet, Accounting tab with `LedgerList`, filter chips and the per-purchase section, Purchases tab, History tab), Record payment sheet (wireframe 3.4.2 with live preview and Settle in full), Adjust owed sheet (new balance or delta, note required, preview old → new), Manual credit sheet, Opening balance sheet, Add material / Purchase form (company picker with "No company — stock only", line cards, `QuantityInput`, `MoneyInput`, `TotalsFooter`, More with rate for this purchase, drafts, idempotent save), Purchase detail (with "We owe for this purchase", Edit/Void/Duplicate), Purchases list (tab in Materials and in Company), the material's Movements tab now showing purchases, signature moment "Balance settles"; **Proposed:** voucher/statement share sheets.
- *Permissions consumed:* `companies.view/create/edit/assign/set_rate/record_payment/adjust_owed/record_credit/opening_balance`, `purchases.view/create/edit/void`, `fields.see_bought_price`, `fields.see_company_balances`.

**Explicitly out of scope.** Damage-driven credits UI (I3), Reports incl. Payables (I4), exports.

**Acceptance criteria.**

- FR-401 to FR-408, FR-701 to FR-712, FR-205 (companies), FR-904 (company side), FR-1205 (companies) meet their acceptance criteria; the mapping in 2.4.2 is demonstrable in the database and on screen; optional FR-614, FR-615, FR-617 (company side), FR-616 (purchases) if kept.
- Automated tests: purchase with company → stock movements + one company entry copying the purchase totals; without company → movements only (FR-407); a USD-settled company's purchase valued at the company rate even when the month price was typed in IQD; payment entered in USD converts at the company rate and stores both + rate; override stores the implied rate as `manual`; settle in full leaves zero; adjustment writes exactly the delta with note and audit before/after; reversal negates exactly; per-purchase remaining with oldest-first allocation + unallocated remainder = balance (property test); settlement-currency change refused with a non-zero balance unless a re-basing rate is given, and the re-basing entry leaves exactly the agreed balance; ±20 % rate guard; rate change never alters stored entries.
- Saving a three-line purchase on a throttled phone completes in ≤ 1.5 s after tap; the company payment sheet is usable one-handed at 360 px in Arabic and the conversion is visible within 100 ms of typing.

**Demo script.**

1. As accountant: create company "Al-Noor Steel Co." (settlement IQD), set rate 1,310 (different from the global 1,300).
2. As warehouse employee on a phone (Kurdish): Add material from Al-Noor with two lines; watch the totals footer; save; show stock and "first bought" on the material; show the purchase in the company's Purchases tab with "remaining = total".
3. As accountant: record a payment typing 1,000,000 د.ع → USD fills at 1,310; save → balance rolls down; the per-purchase view shows the oldest purchase partly paid without any linking; record a second payment typing 500 $, override the IQD value → "manual rate" marker.
4. Adjust owed: "Change by −476,400" with a note → preview old → new → save; show History with old → new and the note; try without a note → refused.
5. Change the company's rate → new payments use it; earlier entries unchanged (open one). Change a USD-settled company's settlement currency with a re-basing rate → the marker row and the agreed balance.
6. Edit the purchase on the same day (quantity change) → movements show reversal + new; void a second purchase with a reason → stock restored.
7. Record an opening balance for a new company with a note; share its statement (if kept); show the Companies list sorted by highest balance.

**Risks and dependencies.** Depends on I0 and on the ledger patterns and materials from I1. Client confirmation of Q-09 (settlement currency), Q-11 (rate semantics), Q-18 (per-purchase meaning and oldest-first allocation), Q-29 (methods, split payments).

**Size.** L.

## Rules for the agent

- Do not ask questions in chat. When the specification is silent or ambiguous, choose the option its assumptions and defaults point to, record the decision in `docs/DECISIONS.md` with the section relied on, and continue. Genuine blockers go into `docs/QUESTIONS.md` with your proposed default.
- Keep `docs/PROGRESS.md` current at every checkpoint (done, next, test counts).
- Never store money as floating point; never update or delete a ledger or audit row; every route carries a permission decorator or `@AdminOnly()`; never use physical left/right CSS; every string goes through the message catalogs in all three languages; every amount renders through `DualAmount`.
- Build only what this iteration lists. Nothing from later iterations and nothing from section 2.15, even if it seems small.
- Finish with the demo script of this iteration run on staging, and the Definition of done ticked item by item in `docs/PROGRESS.md`.

# Mizan — Iteration 3 — Damaged items & returns (standalone brief)

This brief is extracted verbatim from `spec/mizan-factory-system-spec-v1.2.md`. Section numbers refer to that document, which must be available to you in full; `spec/2-architecture.md` and `spec/3-ux-ui-direction.md` are the same text split by deliverable.

## Read these sections of the specification first

1. 1.3.8 Damaged Items & Returns (FR-801 to FR-807), FR-707 and FR-506 from damage
2. 2.2 table damages, enums damage_attribution / return_status / stock_effect; 2.5.1 stock effects incl. return_in
3. 2.9.3 endpoints for damages and credits
4. 3.3 rows for Damaged items and Damage record; 3.4.3 wireframe; flow 3.5.5

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

## 4.5 Iteration 3 — Damaged items & returns

**Goal.** Deliver the Damaged items page: damage records with optional reason and optional attribution (customer order, us, or the supplier company/purchase), the returnable flag and return status, the stock effect by attribution, "Return to stock" for usable goods, returns that credit the supplier company, and customer credits from damage records.

**User-visible outcome.** An employee logs a damaged item on the floor in under a minute, marks it returnable; when it goes back to the supplier, the accountant records the credit from the same record and the company's balance falls; damage attributed to a customer order does not touch stock and can lead to a customer credit or be put back in stock when usable.

**Scope.**

- *Data (2.2):* `damages` (with `attribution`, `order_id`, `company_id`, `purchase_id`, `is_returnable`, `return_status`, `stock_effect`, `est_value_*`), sequence `damage_number_seq`; `stock_ledger.damage_out` and `return_in`; `company_ledger.credit` and `customer_ledger.credit` rows with `damage_id`.
- *Kernel:* stock effect by attribution (2.5.1); credit valuation from the linked purchase line or the month bought price (A-39); edit/void with compensating movements.
- *API (2.9.3):* `/damages` (list with filters and totals, create, read, update, void, return, history); `/companies/:id/credits` now driven from the damage record; `/customers/:id/credits` with `damage_id`.
- *Frontend (3.3, 3.4.3):* Damaged items list with chips and period totals, Record damage form (`AttributionPicker` tiles, order/company/purchase pickers, returnable toggle, stock-effect sentence), Damage detail (chips, links, Mark returned / Written off / Record credit / Return to stock sheets), `ReturnStatusChip`, damage entries in the material's Movements and History tabs, "Damaged" links from order and purchase detail pages.
- *Permissions consumed:* `damages.view/create/edit/void/mark_returned`, `companies.record_credit`, `orders.credit`, `fields.see_bought_price` (values).

**Explicitly out of scope.** Damage report (I4), lot/batch tracking (never in v1). (Re-entry of usable returned goods is explicit — the "Return to stock" action — never automatic.)

**Acceptance criteria.**

- FR-801 to FR-807, FR-707 (from damage), FR-506 (from damage) meet their acceptance criteria.
- Automated tests: stock effect per attribution; return to stock writes `return_in`; edit quantity → reversal + new; void → reversal; return with credit → company entry linked to damage and purchase; customer credit linked to damage and order; est_value snapshot uses the damage month's bought price with fallback flag; check constraints on attribution links; period lock respected.

**Demo script.**

1. As warehouse employee on a phone: record 4 kg of copper wire damaged, attributed to Al-Noor and purchase #P-0231, returnable, with a reason; show "Stock will decrease by 4 kg"; save; material stock and movements reflect it.
2. Record damage attributed to order #1043 (came back damaged) → "No stock change" sentence; save.
3. As accountant: open the first record → Mark returned and record credit → amount pre-filled from the purchase line price, USD at the company rate → confirm → chip "Returned & credited"; company balance falls; ledger row links back to the damage.
4. On the second record → "Record customer credit" → customer balance falls; History shows both. On a third, customer-attributed record → "Return to stock" → stock rises by the quantity.
5. Filter the list by "Pending return" and by employee; show totals with and without the bought-price permission.

**Risks and dependencies.** Depends on I1 (materials, orders, customer credits) and I2 (companies, purchases, company credits). Client answers to Q-16 and Q-17 — both are switchable rules.

**Size.** M.

## Rules for the agent

- Do not ask questions in chat. When the specification is silent or ambiguous, choose the option its assumptions and defaults point to, record the decision in `docs/DECISIONS.md` with the section relied on, and continue. Genuine blockers go into `docs/QUESTIONS.md` with your proposed default.
- Keep `docs/PROGRESS.md` current at every checkpoint (done, next, test counts).
- Never store money as floating point; never update or delete a ledger or audit row; every route carries a permission decorator or `@AdminOnly()`; never use physical left/right CSS; every string goes through the message catalogs in all three languages; every amount renders through `DualAmount`.
- Build only what this iteration lists. Nothing from later iterations and nothing from section 2.15, even if it seems small.
- Finish with the demo script of this iteration run on staging, and the Definition of done ticked item by item in `docs/PROGRESS.md`.

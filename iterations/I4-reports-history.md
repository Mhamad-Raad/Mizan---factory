# Mizan — Iteration 4 — Reports & history depth (standalone brief)

This brief is extracted verbatim from `spec/mizan-factory-system-spec-v1.2.md`. Section numbers refer to that document, which must be available to you in full; `spec/2-architecture.md` and `spec/3-ux-ui-direction.md` are the same text split by deliverable.

## Read these sections of the specification first

1. 1.3.9 History (FR-902 full, FR-903), 1.3.10 Reports (FR-1001 to FR-1013)
2. 2.4.4 audit log, 2.4.5 presentation rules, 2.7 filter semantics, 2.11 report definitions and pinned filters
3. 2.9.3 endpoints for history and reports (and export/search/dashboard if kept)
4. 3.3 rows for History, Reports, Dashboard and Search

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

## 4.6 Iteration 4 — Reports & history depth

**Goal.** Deliver the eight reports (plus the daily cash-up if kept) with filtering by user (done by / assigned to, pinned per report for own-only users) and date range and month grouping, the History tab on every record, the full History page filters (assigned to, entity type, grouping of edits), and optionally the Proposed dashboard, global search and exports.

**User-visible outcome.** The admin filters History by employee and day and reads every change as old → new with the note; the accountant opens Payables and Receivables; the owner reads Sales and the margin report by month and the daily cash-up per employee; every report shows both currencies.

**Scope.**

- *Data:* no new tables; report queries over orders, purchases, ledgers, damages and audit_log with the indices of 2.2.5; `related` JSON on audit rows used for "assigned to" filtering; cost snapshots on order lines for the margin report.
- *API (2.9.3, 2.11):* `/history` extended (`assigned_to`, `entity_type`, `entity_id`, `action`, grouped edits), `…/:id/history` for every entity (some exist since I1–I3; complete the set), `/reports/sales`, `/reports/purchases`, `/reports/profit`, `/reports/stock`, `/reports/receivables`, `/reports/payables`, `/reports/damage`, `/reports/employee-activity` with `group_by` and the pinned filter for own-only users. Optional (**Proposed — not requested**): `/reports/cash-up`, `/reports/:name/export`, `/history/export`, `/search`, `/dashboard`.
- *Frontend (3.3):* History page completed (two user filters side by side, date chips, type sheet, expandable diffs in the user's language with `DualAmount` values, edit groups collapsed), History tab on orders, purchases, materials, customers, companies, damage records and users; Reports hub and eight report pages (filters → summary tiles → expandable table, month headers localised, fallback-cost flags, "margin vs. month price" label). Optional (**Proposed — not requested**): Daily cash-up page, Dashboard tiles per permission (incl. the stale-rate prompt), Search page, Export buttons.
- *Permissions consumed:* `history.view`, `history.view_all`, `reports.view`, `reports.view_all`, field flags per report (2.11); optional `dashboard.view`, `reports.export`, `history.export`.

**Explicitly out of scope.** New write paths (none); scheduling or e-mailing reports; charts beyond simple bars in tiles (**Proposed — not requested**, only if trivial with the component library).

**Acceptance criteria.**

- FR-902 (full), FR-903, FR-1001 to FR-1011 meet their acceptance criteria; optional FR-1012, FR-1013, FR-1309, FR-1310 if kept.
- Automated tests: each report's totals equal independent SQL sums over seeded data; margin formula per 2.11 from line snapshots, with the same sign in both currencies for every row; month grouping in Asia/Baghdad; History filters by done_by and assigned_to return disjoint, correct sets; pinned filters for own-only users per report; field stripping in report responses; cash-up totals equal the ledgers' entered-currency sums.
- History page at 2 million seeded rows returns the first page in ≤ 300 ms (NFR-03/NFR-13).

**Demo script.**

1. History: filter "Done by: Sara" and "Today" → expand a payment entry → old → new balance and the note; switch to "Assigned to: Rebaz" → Kawa's orders appear; an edited order shows as one "edited" entry, expandable.
2. Open Order #1043 → History tab → the whole story: created, partial payment, settle in full, type change.
3. Reports: Sales by month with dual totals and discounts (if kept); Margin vs. month price for September with a flagged fallback line and matching signs; Receivables sorted by balance (permission demo: the sales user sees only their assigned customers); Payables per company with per-purchase remaining; Damage; Employee activity for the month; Daily cash-up per employee and currency (if kept).
4. (If kept) Dashboard for admin vs. sales user; global search finding "كاوا" typed as "کاوا"; export a report to Excel.

**Risks and dependencies.** Depends on all previous iterations' data. Report performance at real volumes (Q-02) — mitigated by the indices and by testing against seeded data early in the iteration.

**Size.** M.

## Rules for the agent

- Do not ask questions in chat. When the specification is silent or ambiguous, choose the option its assumptions and defaults point to, record the decision in `docs/DECISIONS.md` with the section relied on, and continue. Genuine blockers go into `docs/QUESTIONS.md` with your proposed default.
- Keep `docs/PROGRESS.md` current at every checkpoint (done, next, test counts).
- Never store money as floating point; never update or delete a ledger or audit row; every route carries a permission decorator or `@AdminOnly()`; never use physical left/right CSS; every string goes through the message catalogs in all three languages; every amount renders through `DualAmount`.
- Build only what this iteration lists. Nothing from later iterations and nothing from section 2.15, even if it seems small.
- Finish with the demo script of this iteration run on staging, and the Definition of done ticked item by item in `docs/PROGRESS.md`.

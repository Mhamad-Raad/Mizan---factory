# Mizan — Iteration 6 — Polish & go-live (standalone brief)

This brief is extracted verbatim from `spec/mizan-factory-system-spec-v1.2.md`. Section numbers refer to that document, which must be available to you in full; `spec/2-architecture.md` and `spec/3-ux-ui-direction.md` are the same text split by deliverable.

## Read these sections of the specification first

1. All NFRs (1.4), 3.6 animation and signature moments, 3.7 typography, 2.12 performance and E2E, 2.13 security review, 2.14 backups and the restore drill
2. FR-1204 glossary sign-off, FR-306 first prices, FR-308/504/708 opening balances, optional FR-1312 and FR-1313

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

## 4.8 Iteration 6 — Polish & go-live

**Goal.** Make it feel finished and put it into production: animations and the signature moments, performance on low-end phones, accessibility, QA across three languages and both themes on real devices, the client's review of translations and the glossary, opening balances and first prices entered, backups and restore tested, documentation and training material; optionally the Proposed CSV import and PWA shortcut.

**User-visible outcome.** The client uses Mizan for real work on their own phones and tablets, in their language, with their opening stock, prices and debts loaded, and signs off on the look and feel.

**Scope.**

- *Design polish (3.6, 3.7):* all animation rules and the five signature moments; reduced-motion behaviour; final empty-state illustrations; font-check on the client's devices; theme and font-size sweep of every screen.
- *Performance (NFR-03):* bundle audit, route splitting review, image/font budgets, Lighthouse CI thresholds enforced, one seeded load test with NFR-13 volumes on staging, slow-query review, list virtualisation where needed.
- *Accessibility (NFR-10):* axe pass on all stories, keyboard traversal of every form, contrast and colour-vision re-check, screen-reader labels in all three languages.
- *QA (NFR-01, NFR-09):* full E2E suite on Android Chrome (real device), iOS Safari and desktop browsers; three-language screenshot review; RTL checklist per screen; bug-fix window.
- *Client reviews:* translation and glossary sign-off session (Q-26) with screenshots per language; identity sign-off (NFR-14).
- *Go-live:* production environment, secrets rotation, first admin, opening stock / customer debts / company debts entered by the admin (FR-308, FR-504, FR-708) — optionally via the Proposed CSV import (FR-1312); **a first price for every material** (FR-306); the global rate and every company rate confirmed; go-live date and period lock (if kept) set; backup job and WAL archiving verified; **restore drill executed and logged** (NFR-08); monitoring alerts wired to the operations channel.
- *Documentation and training:* admin guide (users, permissions, rates, prices, opening balances, period lock, backups), employee quick cards per preset (one page each, in all three languages), the runbook (deploy, backup, restore, incident), and a 30-minute training session per role recorded as a screen video.
- *Optional (Proposed — not requested):* FR-1312 CSV import, FR-1313 PWA shortcut.

**Permissions touched.** None new; final review of every preset with the client.

**Explicitly out of scope.** New features beyond the Proposed items listed; anything in section 2.15.

**Acceptance criteria.**

- Every NFR verified with evidence attached (Lighthouse and load-test reports, axe results, device screenshots, restore-drill log).
- FR-1204 client sign-off of the glossary and catalogs recorded; FR-1311 identity signed off.
- Opening balances entered and reconciled with the client's own figures (sum of customer balances, sum of company balances, stock counts) and the reconciliation kept in History via the notes; every active material has a current price.
- Zero open severity-1/2 defects; training delivered; runbook handed over.

**Demo script (go-live review).**

1. On the client's own tablet: sign in, create an order, watch the totals tick and the row land; share the receipt (if kept); record a payment that settles a balance (brass sweep).
2. Switch language mid-task; switch theme; extra-large font on a phone — nothing breaks.
3. Show the Receivables and Payables totals matching the client's opening figures.
4. Show the restore-drill log and the backup dashboard; show monitoring alerts.
5. Hand over the admin guide and quick cards; agree the support channel.

**Risks and dependencies.** Client availability for translation review and opening-balance entry (the longest pole); device diversity on the floor (Q-22); performance of the client's connectivity (mitigated by FR-1305 measures and PWA static caching if kept).

**Size.** M.

## Rules for the agent

- Do not ask questions in chat. When the specification is silent or ambiguous, choose the option its assumptions and defaults point to, record the decision in `docs/DECISIONS.md` with the section relied on, and continue. Genuine blockers go into `docs/QUESTIONS.md` with your proposed default.
- Keep `docs/PROGRESS.md` current at every checkpoint (done, next, test counts).
- Never store money as floating point; never update or delete a ledger or audit row; every route carries a permission decorator or `@AdminOnly()`; never use physical left/right CSS; every string goes through the message catalogs in all three languages; every amount renders through `DualAmount`.
- Build only what this iteration lists. Nothing from later iterations and nothing from section 2.15, even if it seems small.
- Finish with the demo script of this iteration run on staging, and the Definition of done ticked item by item in `docs/PROGRESS.md`.

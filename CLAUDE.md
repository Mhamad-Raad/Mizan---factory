# Mizan — rules for every agent session in this repository

Mizan is a single-factory web system (React + TypeScript SPA, NestJS API, PostgreSQL) for materials stock, customer orders, supplier purchases, dual-currency IQD/USD money, supplier accounting, damaged goods and a full audit history, in Kurdish Sorani (RTL, default), Arabic (RTL) and English (LTR). The complete specification is `spec/mizan-factory-system-spec-v1.2.md`; the same text split by deliverable is in `spec/`, and the standalone iteration briefs are in `iterations/`.

## How work is organised

- Work proceeds one iteration at a time, in the order I0 → I1 → I2 → I3 → I4 → I5 → I6 (`iterations/`). Build only what the current brief lists. Nothing from later iterations, nothing from specification section 2.15 ("deliberately not built").
- Each brief has checkpoints. Stop at a checkpoint marked "human" and report in `docs/PROGRESS.md`; continue past the others when their tests are green.
- Do not ask questions in chat. When the specification is silent or ambiguous, choose what its assumptions (section 1.9) and defaults (section 1.10) point to, record the choice in `docs/DECISIONS.md` with the section relied on, and continue. Genuine blockers go into `docs/QUESTIONS.md` with the default you proceeded with.
- Keep `docs/PROGRESS.md` current at every checkpoint.

## Non-negotiable rules (from the specification)

1. Money is integers in minor units (IQD whole dinars, USD cents), never floating point — in the database, the API and the client. Every stored amount carries both currencies and the rate used (`rate_iqd_per_usd`, `rate_source`). Historical amounts are never recalculated from a later rate. Line totals follow the entered-currency rule (section 2.3.4).
2. Ledgers (`customer_ledger`, `company_ledger`, `stock_ledger`) and `audit_log` are append-only: no UPDATE, no DELETE, corrections are reversal rows; the application database role has no such privileges. Balances and stock are sums over the ledgers, never edited columns.
3. Every write is recorded in `audit_log` with who, when, old → new and the note; balance changes carry before/after.
4. Every API route carries `@RequirePermission(...)` or `@AdminOnly()`; a CI test fails on an undecorated route. Field-level flags strip fields in responses. Scope rules (section 2.6.4) live in repositories. The frontend only hides.
5. RTL is designed, not flipped: logical CSS properties only (lint enforced), mirrored directional icons via the registry, direction-aware animations and gestures, numeric inputs LTR, currency symbols placed per locale (section 2.10.6).
6. Every user-visible string exists in `ckb-IQ`, `ar-IQ` and `en` and uses the glossary (section 1.6); the build fails on a missing key. Formatting goes through the formatting service (section 2.10.4), never raw `Intl` for `ckb`.
7. Every amount renders through `DualAmount` (both currencies; ≈ only for derived figures).
8. Mobile first: every screen usable one-handed at 360 px in all three languages; skeleton, empty, error and offline states for every page.
9. Reuse the palette system's component library; achieve Mizan's identity through tokens, naming and branding only — never fork a component.
10. Tests accompany every money, ledger, stock and permission change; the suite must be green before a checkpoint.

## Definition of done for an iteration

See section 4.1 of the specification (three languages; RTL verified on a real phone; permissions enforced on every new endpoint; every change in History; both currencies everywhere; both themes and all font sizes; tests for money/stock logic; all page states; accessibility basics; demo on staging).

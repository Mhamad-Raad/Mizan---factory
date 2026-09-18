# Mizan — Factory Materials, Orders & Supplier-Accounting Web System

## Requirements Specification, Architecture, UX/UI Direction and Iteration Plan

| | |
|---|---|
| **Document status** | Draft for client sign-off (v1.2 — revised after the senior design review and a targeted verification of the new mechanisms; change log below) |
| **Prepared by** | Lead software architect / product designer |
| **Prepared for** | The factory (single tenant) and the implementation team |
| **Working product name** | **Mizan** (Arabic ميزان / Kurdish میزان — "scale, balance"). Working name only — see Open Question Q-01. |
| **Sibling system** | The existing "palette items" system built by our team for the same factory (blue/teal primary). Mizan reuses its stack and patterns and deliberately looks different. |
| **Tech stack (as supplied)** | React single-page application (TypeScript) + Node.js API (NestJS) + PostgreSQL, hosted the same way as the palette system. Unspecified details (component library, i18n library, ORM, hosting) are stated as assumptions A-01 to A-04. |
| **Palette-system identity (as supplied)** | Blue / teal primary. Mizan's primary hue is a deep plum, roughly 100° away on the hue wheel, on warm neutral surfaces. |
| **Locales** | Kurdish Sorani `ckb-IQ` (RTL, default), Arabic `ar-IQ` (RTL), English `en` (LTR) |
| **Currencies** | Iraqi Dinar (IQD) and US Dollar (USD); every amount is shown in both |
| **Timezone / calendar** | Asia/Baghdad; Gregorian; week starts Saturday (to confirm, Q-04) |

### How to read this document

- **Deliverable 1** is for the product owner and the client: every line of the client's request appears in the *Raw requirement register* (R-01…R-34) and is turned into numbered functional requirements (FR-xxx) with acceptance criteria. Anything we added that the client did not ask for is labelled **Proposed — not requested** wherever it appears, so it can be cut in one pass.
- **Deliverable 2** is for developers: the database schema, ledgers, API, permission checks and frontend architecture, written so that no question needs to be asked before building.
- **Deliverable 3** is for designers: identity, tokens, page map, mobile layouts, wireframes, flows, animation and typography — for a phone, in RTL, in both themes.
- **Deliverable 4** is for whoever runs the build: seven iterations, each a standalone brief with acceptance criteria and a demo script, plus a traceability matrix (in section 2.16) and a per-iteration requirement list (section 4.10).
- **Labels used throughout:** `R-nn` a verbatim client line; `C-nn` a project-context requirement from our brief; `FR-nnn` / `NFR-nn` requirements; `A-nn` assumptions; `Q-nn` open questions for the client; `I0…I6` iterations; **Proposed — not requested** for anything neither the client nor the brief asked for.

### Table of contents

**Deliverable 1 — Requirements specification**
1.1 The business in one paragraph (validated reading) · 1.2 Raw requirement register · 1.3 Functional requirements by module (Auth & Permissions, Users, Materials & Stock, Purchases, Customers, Orders & Payments, Supplier Companies & Accounting, Damaged Items & Returns, History, Reports, Settings & Preferences, i18n/RTL, Cross-cutting) · 1.4 Non-functional requirements · 1.5 Roles and permission catalog with presets · 1.6 Trilingual glossary · 1.7 Out of scope for v1 · 1.8 Proposed — not requested (consolidated list) · 1.9 Assumptions · 1.10 Open questions for the client

**Deliverable 2 — Architecture**
2.1 Stack, reuse and deviations · 2.2 Domain model and ERD · 2.3 Money model · 2.4 History model (ledgers and audit log) · 2.5 Stock model · 2.6 Authorization model · 2.7 Attribution and assignment · 2.8 Authentication and sessions · 2.9 API design · 2.10 Frontend architecture (routing, state, i18n, RTL, search normalisation, theming, font scale, persisted preferences, component reuse) · 2.11 Reports · 2.12 Test strategy · 2.13 Security · 2.14 Deployment, backups and monitoring · 2.15 Deliberately not built in v1 · 2.16 Traceability matrix

**Deliverable 3 — UX/UI direction**
3.1 Design principles · 3.2 Distinct identity and token sheet · 3.3 Page map with mobile layout notes and states · 3.4 Text wireframes · 3.5 Key flows · 3.6 Animation guidelines and signature moments · 3.7 Typography and numerals

**Deliverable 4 — Development plan by iterations**
4.1 Definition of done · 4.2 Iteration 0 — Foundation · 4.3 Iteration 1 — Materials, customers & orders (selling) · 4.4 Iteration 2 — Companies, purchases & company accounting (buying) · 4.5 Iteration 3 — Damaged items & returns · 4.6 Iteration 4 — Reports & history depth · 4.7 Iteration 5 — Shared tablets & permissions depth · 4.8 Iteration 6 — Polish & go-live · 4.9 Dependency graph · 4.10 Requirements per iteration

**Self-check**

### What changed in v1.1 (after the senior design review)

Money and history: the entered currency of a line is now authoritative and the other currency's line total is a conversion of it, never a rounded unit price times a quantity (2.3.4, A-41); each order line snapshots its cost so the Profit report is reproducible and its two currencies can never disagree in sign (FR-602, FR-1005, 2.11, A-42); changing a counterparty's settlement currency requires a zero balance or an explicit re-basing entry at an agreed rate, and the other-currency column is never shown as a balance (2.3.5, FR-702, A-20); running balances follow posting order so they match History (2.2.6, A-43); "settle in full" and a settlement tolerance remove residues (FR-606, FR-705); every purchase and order carries a "rate for this document" that can be agreed per deal (2.3.3); ledger noise is collapsed by explicit presentation rules (2.4.5); stock is tracked in the priced measure only (FR-303); unlinked supplier payments are allocated oldest-first for the per-purchase view (FR-712, A-29); a `return_in` movement puts usable customer returns back in stock (2.5.1).

Operations on the floor: cash orders record the currency physically received (FR-604); Proposed additions — order receipts, payment vouchers, account statements, order-level discount/round-down and credit limit, payment method and split payments, a daily cash-up per employee, a period lock, a stale-rate prompt (FR-613 to FR-617, FR-1013, FR-1109) — with the receipts family recommended for the first business iteration. Editing is allowed while unpaid until the period is locked instead of same-day only (A-25).

Permissions and auth: a simple permission editor (preset + six extras) with the full grid under Advanced (FR-204); `purchases.create` implies seeing bought prices; duplicate checks run across all customers; sessions last 30 days on personal devices and 12 hours on shared ones; PINs are six digits on shared devices, PIN switching is admin-controlled, and every session and History entry records the authentication method (FR-106, 2.8, A-44); the lock screen remembers each user's language on a shared tablet (FR-1103).

v1.2 verification fixes: the settlement-currency change always writes a re-basing entry (a zero old balance still leaves a mixed-rate sum in the new column) with an explicit delta formula, and re-basing rows are never reversed; the per-purchase reconciliation identity now includes a "General" bucket (opening balances, unlinked adjustments, settlement changes, entries of voided purchases, unallocated remainder) so it holds at go-live; lines carry their own rate and rate source, and a document-rate change recomputes every line where only one price was typed; ledgers gain a `posting_seq` because rows written in one transaction share `created_at`; the cash-settlement pair for a cash order paid in the other currency is fully specified and bounded by the settlement tolerance; a same-currency shortfall within tolerance is written as paid plus a residue credit/adjustment; a replaced order line keeps its cost snapshot unless its item or month changed; stock-ledger measures are nullable so "not carried" is distinguishable from zero; the six permission extras have a "partly" state; PIN length is stored so shared devices can refuse short PINs; the period lock covers reversals and fully ended months; stale iteration numbers in the Proposed list corrected.

Plan: I0 slimmed to a medium foundation; selling (materials, customers, orders, receipts) is now the first business iteration, buying the second; shared-tablet features and the advanced grid moved to a small I5; WAL archiving is standard (RPO 15 minutes) and the test/ops apparatus is trimmed to what protects money and stock (2.12, 2.14). A blocking question (Q-37, catalog vs. batch model of materials) must be settled in a workshop before I1.

---

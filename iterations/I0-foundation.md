# Mizan — Iteration 0 — Foundation (standalone brief)

This brief is extracted verbatim from `spec/mizan-factory-system-spec-v1.2.md`. Section numbers refer to that document, which must be available to you in full; `spec/2-architecture.md` and `spec/3-ux-ui-direction.md` are the same text split by deliverable.

## Read these sections of the specification first

1. Front matter and change log
2. 1.5 permission catalog, presets, extras
3. 1.6 glossary (provisional until ticked)
4. 2.1 stack; 2.2 conventions, enums, the I0 tables (users, user_permissions, sessions, login_attempts, idempotency_keys, settings, audit_log), ERD, 2.2.5 indices
5. 2.3 money model and 2.4 history model (kernels built and tested now)
6. 2.6 authorization, 2.7 attribution, 2.8 authentication (password sign-in, lock, password unlock only)
7. 2.9 API conventions, error format, I0 endpoints
8. 2.10 frontend architecture in full
9. 2.12 tests, 2.13 security, 2.14 deployment
10. 3.1, 3.2 identity and tokens, 3.3 rows for Login, Lock, Users, Settings, History and global states, 3.4.4 (simple mode), 3.6, 3.7

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

## 4.2 Iteration 0 — Foundation

**Goal.** Stand up the Mizan application with its distinct identity, sign-in without e-mail, user management with presets and the simple permission editor, three languages with RTL, two themes, the font-size scale, browser-persisted preferences, the audit log infrastructure with a plain History list, and the shared money/ledger/text kernels — so that every later iteration only adds business screens. Kept to a medium size on purpose: the advanced permission grid, PIN quick sign-in and user switching are I5.

**User-visible outcome.** An admin signs in on a phone in Kurdish, sees the plum Mizan shell (unmistakably not the palette system), creates employees from presets and adjusts the six everyday extras, switches language/theme/font size and sees them persist after reload, locks the screen and unlocks with the password, and reads every action in the History list.

**Scope.**

- *Data (section 2.2):* `users`, `user_permissions`, `sessions` (with `auth_method`), `login_attempts`, `idempotency_keys`, `settings`, `audit_log`; enum types; migrations framework; seed of the first admin from environment; database roles (`mizan_app` without UPDATE/DELETE on `audit_log`; `mizan_migrate`). `device_tickets` is created in I5.
- *Kernels:* `permissions` (catalog 1.5.2, presets and the six extras 1.5.3, implied-key expansion), `money` (integer minor units; entered-currency-authoritative line totals; conversion and rounding 2.3.4; settlement tolerance — unit-tested now, used from I1), `ledger` (append-only writer + reversal helper + audit before/after hook + posting-order running balance, tested against a throwaway table), `text` (search normalisation 2.10.7 with its test table), `i18n` (catalogs, ICU, `ckb` plural rule, formatting service 2.10.4 incl. Kurdish/Arabic month names and numerals).
- *API (section 2.9):* `/auth/login` (password), `/auth/logout`, `/auth/me`, `/auth/change-password`, `/auth/lock`, `/auth/unlock` (password only in this iteration); `/users` (list, create, read, update, deactivate, reactivate, reset-password, permissions get/put), `/users/directory`; `/permissions/catalog`, `/permissions/presets`; `/settings` (read; admin patch for idle-lock minutes, week start, date format); `/history` (cursor list with `done_by` and date filters; own-only without `history.view_all`), `/history/me`; `/health`. Guards: AuthGuard, PermissionGuard, SensitiveField interceptor, idempotency middleware, version-conflict handling, error format 2.9.2, rate limiting and lockout.
- *Frontend (sections 2.10, 3.2, 3.3):* app shell (`AppShell`, bottom tab bar computed from permissions, header with the Mizan mark), Login, Lock screen (current user, password unlock; the recent-users switcher is I5), Users list, User page (Details, Permissions in **simple mode** — preset + six extras — with the Advanced grid deferred to I5, Activity tab), History page (plain list with "done by" and date filters, expandable diffs), Settings (This device, My account incl. "My activity"; System: idle lock, week start), tokens for both themes (3.2.4) with the colour-vision simulation check, `--font-scale`, pre-paint script and localStorage preferences with fallbacks (2.10.10), `DualAmount`, `MoneyInput`, `NumberField` LTR-in-RTL, icon mirroring registry, direction-aware sheet/page transitions, `OfflineBar`, draft store, global states (403/404/conflict/offline).
- *Identity:* logo mark, wordmark, favicons, login illustration, empty-state illustration set, font subsets and the font-check page (3.7.1).
- *Ops (2.14):* repository, CI (lint incl. logical-property rule, type-check, unit, API integration with PostgreSQL, screenshot diffs for the key screens, bundle budget), staging deployment with TLS, nightly backup job and WAL archiving configured (restore drill is I6), error tracking and uptime check.

**Permissions touched.** Whole catalog stored and editable (simple mode writes the same set); admin-only routes for users and settings; `history.view` / `history.view_all` consumed by the History page; every other key exists in the catalog but has no consuming screen yet.

**Explicitly out of scope.** Any business entity (materials, purchases, customers, orders, companies, damage); Reports; History tabs on records (I4); the Advanced permission grid, PIN quick sign-in, device tickets, user switching and per-user language memory (I5); Dashboard; global search; exports.

**Acceptance criteria.**

- FR-101 to FR-105, FR-106 (lock and password unlock only), FR-107, FR-108, FR-201 to FR-204 (simple mode), FR-206, FR-901, FR-902 (plain list), FR-1101 to FR-1105, FR-1107 (device and account sections), FR-1108, FR-1201 to FR-1206, FR-1301, FR-1303, FR-1307, FR-1308 (pattern), FR-1311 meet their acceptance criteria.
- Permission-matrix test runs against every route in the codebase; the CI fails on an undecorated route.
- A first visit on a fresh browser opens in Kurdish, RTL, follow-device theme, default size, with no flash; a private-mode browser works with the notice in Settings.
- Contrast script passes for the token sheet; the colour-vision simulation shows every status chip distinguishable by icon and text; Lighthouse mobile ≥ 80 on the login and Users pages; app shell ≤ 250 kB gzipped.
- Side-by-side screenshots with the palette system reviewed and approved by the client (FR-1311); the **materials model workshop (Q-37) has been held** and its outcome recorded before I1 starts.

**Demo script.**

1. Open staging on a phone: Kurdish login screen with the Mizan mark; switch to Arabic then English; note the mirrored layout.
2. Sign in as the seeded admin; forced password change.
3. Create employee "Rebaz" from the Sales preset; show the temporary password; in Permissions turn on the extra "Can void"; save; open History and show the permission change as old set → new set.
4. Sign in as Rebaz on a second phone; show the bottom bar computed from his permissions; try a URL he may not open → friendly 403.
5. Settings: switch theme and font size; reload — persisted, no flash.
6. Lock the screen; unlock with the password; show both events in History.
7. Show CI: permission-matrix test and contrast test output.

**Risks and dependencies.** Access to the palette system's `@factory/ui` package and token pipeline (blocking; A-01); confirmation of the palette's exact primary colour (Q-01) before finalising tokens; Kurdish glyph rendering on the client's actual devices (mitigated by the font-check page); the client's availability for the identity review and for the Q-37 workshop.

**Size.** M.

## Rules for the agent

- Do not ask questions in chat. When the specification is silent or ambiguous, choose the option its assumptions and defaults point to, record the decision in `docs/DECISIONS.md` with the section relied on, and continue. Genuine blockers go into `docs/QUESTIONS.md` with your proposed default.
- Keep `docs/PROGRESS.md` current at every checkpoint (done, next, test counts).
- Never store money as floating point; never update or delete a ledger or audit row; every route carries a permission decorator or `@AdminOnly()`; never use physical left/right CSS; every string goes through the message catalogs in all three languages; every amount renders through `DualAmount`.
- Build only what this iteration lists. Nothing from later iterations and nothing from section 2.15, even if it seems small.
- Finish with the demo script of this iteration run on staging, and the Definition of done ticked item by item in `docs/PROGRESS.md`.

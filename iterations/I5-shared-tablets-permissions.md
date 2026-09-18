# Mizan — Iteration 5 — Shared tablets & permissions depth (standalone brief)

This brief is extracted verbatim from `spec/mizan-factory-system-spec-v1.2.md`. Section numbers refer to that document, which must be available to you in full; `spec/2-architecture.md` and `spec/3-ux-ui-direction.md` are the same text split by deliverable.

## Read these sections of the specification first

1. FR-106, FR-204 (Advanced grid), FR-1103 (per-user language), FR-1304
2. 2.2 table device_tickets, users.pin_hash/pin_length, sessions.auth_method; 2.8 in full; 2.6.5
3. 2.9.3 auth endpoints (ticket + PIN), users sessions and device-tickets endpoints
4. 3.3 Lock screen row; 3.4.4 Advanced grid; flows 3.5.8, 3.5.10; 3.6 signature moment 4

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

## 4.7 Iteration 5 — Shared tablets & permissions depth

**Goal.** Add what shared floor tablets need — PIN quick sign-in with device-bound tickets, fast user switching from the lock screen, per-user language memory, authentication-method tracking, the admin's Sessions tab — and the Advanced permission grid for the rare cases the simple editor does not cover.

**User-visible outcome.** Two employees share one tablet: the first locks it, the second taps their name, enters a six-digit PIN and continues in their own language; the admin can see and revoke sessions and tickets, and can open the full permission grid for an unusual role.

**Scope.**

- *Data (2.2):* `device_tickets`; `sessions.auth_method` used; audit rows carry the method; settings `pin_min_length_shared`, `pin_min_length_personal`, `allow_pin_switch_on_shared`.
- *API (2.9.3):* `/auth/login { ticket, pin }` with `switch_from_session`, `/auth/pin` (set/remove), `/auth/unlock` with PIN, `GET /users/:id/sessions`, `DELETE /users/:id/sessions/:sid`, `DELETE /users/:id/device-tickets`; the existing `PUT /users/:id/permissions` now driven by the Advanced grid too.
- *Frontend (3.3, 3.4.4):* Lock screen with `UserSwitcher` (recent users, PIN pad, last language per user), PIN setup in Settings → My account, Sessions tab on the user page, "Advanced" disclosure in the Permissions editor with the full `PermissionGrid`, `auth_method` shown on History entries written from PIN sessions.
- *Permissions consumed:* none new; admin-only session management.

**Explicitly out of scope.** Any business change; biometrics (not in v1).

**Acceptance criteria.**

- FR-106 (PIN quick sign-in, user switching), FR-204 (Advanced grid), FR-1304, FR-1103 (per-user language on switch) meet their acceptance criteria.
- Automated tests: a ticket is required for PIN sign-in and is bound to the user; 6-digit rule on shared devices; 5 wrong PINs → password; switch revokes the previous session; tickets revoked on password reset and deactivation; the admin toggle disables PIN switching; every audit row from a PIN session carries `ticket_pin`.

**Demo script.**

1. On a tablet marked "shared": Sara signs in with her password and sets a six-digit PIN; the tablet locks after the (demo-shortened) idle time; Sara unlocks with the PIN.
2. Sara taps "Switch user" → Rebaz → his PIN (he signed in with his password on this tablet earlier) → the app opens in Rebaz's last language; History shows Sara's lock and Rebaz's PIN sign-in.
3. Rebaz records a payment; the admin opens that History entry → "signed in with PIN on Floor tablet 2".
4. The admin opens Sessions for Rebaz and revokes the ticket; Rebaz's next switch asks for the password. The admin turns off PIN switching on shared devices → the lock screen offers passwords only.
5. The admin opens Advanced on a user and toggles a single key, watching implied keys; saves; shows old set → new set in History.

**Risks and dependencies.** Depends on I0 (sessions, lock screen) and on the client's answer to Q-25 (lock timings, PIN acceptability).

**Size.** S.

## Rules for the agent

- Do not ask questions in chat. When the specification is silent or ambiguous, choose the option its assumptions and defaults point to, record the decision in `docs/DECISIONS.md` with the section relied on, and continue. Genuine blockers go into `docs/QUESTIONS.md` with your proposed default.
- Keep `docs/PROGRESS.md` current at every checkpoint (done, next, test counts).
- Never store money as floating point; never update or delete a ledger or audit row; every route carries a permission decorator or `@AdminOnly()`; never use physical left/right CSS; every string goes through the message catalogs in all three languages; every amount renders through `DualAmount`.
- Build only what this iteration lists. Nothing from later iterations and nothing from section 2.15, even if it seems small.
- Finish with the demo script of this iteration run on staging, and the Definition of done ticked item by item in `docs/PROGRESS.md`.

# Iteration 5 — code review

Reviewed as a senior engineer would before this becomes a system nobody touches for years:
correctness, logical defects, architecture, DRY, web patterns, and how each decision behaves
when the data grows. This iteration is about **credentials**, so the review is weighted
accordingly: what a stolen tablet is worth, what a stolen ticket is worth, and what each refusal
tells whoever is holding the device. Every finding below is fixed in this branch, and each has a
regression test that fails against the previous code.

The measurements were taken against synthetic volume in the development database — **18,042
sessions and 6,000 device tickets**, which is thirty employees signing in twice a day on two
tablets for five years, on top of the orders, purchases, damages and two million audit rows the
I2 to I4 reviews loaded. Times are medians of five requests through the running API.

## Findings and fixes

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | **High — security** | **A stolen locked tablet was an unlimited password oracle.** Specification 2.8 caps sign-in attempts at five per username per fifteen minutes, and that cap lived only on the Login page. The lock screen's password fallback verified the password and simply answered "wrong" — for ever, with no count anywhere — and so did the PIN form's "current password" and the change-password form. Anybody holding a locked tablet could guess a password all night at a rate limited only by Argon2id. | One method decides what a wrong password costs, wherever it was typed: `chargeWrongPassword` records the attempt, registers the failure and locks the username on the fifth, and the lock screen, the PIN form and change-password all call it. The tests guess five times through the unlock and five through the PIN form, and assert the username is locked out on the Login page afterwards. |
| 2 | Medium — usability of finding 1's fix | A lockout that also stopped the **unlock** would have ended an employee's shift over a mistyped password, on a tablet they are standing in front of. | The lockout stops new **sign-ins** — the brute-force path — and not an unlock: somebody who knows their own PIN keeps working, and the fifteen minutes cost them nothing. Asserted, because this is exactly the sort of thing a later refactor "tidies up" into a single check. |
| 3 | **High — History (rule 3)** | **A sign-in row did not say how it was signed in.** `recordAnonymous` — the path every `login`, `login_failed`, `lockout` and `switch_user` row goes through, because there is no request context while a session is being created — never wrote `session_id` or `auth_method`. So the one row where "password or six digits?" matters most was the one row that did not answer it, and the demo script's step 3 could not show what 2.8 promises. Present since I0 and invisible until PIN sign-in existed to contrast with. | `recordAnonymous` takes both; the password sign-in records `password` with its new session, the PIN sign-in records `ticket_pin`, a failed PIN attempt records `ticket_pin` (so History distinguishes a mistyped PIN from a mistyped password), and a handover is recorded against the session that **ended**, carrying that session's own method. Three tests, and the harness now reads the column so a test can see it at all. |
| 4 | Medium — data growth | **A tablet accumulated one live ticket per sign-in.** Each password sign-in issued a fresh seven-day ticket and left the previous one live, so one browser held a live secret per shift — sixty-odd per employee per month, all of them a PIN away from a session, and the admin's only remedy was "revoke everywhere". Found by looking at the Sessions screenshot, which showed six live tickets for one employee after a few test runs. | The client sends the ticket it already holds as `replaces_ticket`, and the server retires it as it issues the new one; independently, the server keeps at most **five** live tickets per employee and retires the rest as `superseded`, so a browser that cannot present its ticket — private mode, cleared storage, a second phone — cannot grow the table either. Two tests: the replaced ticket stops working, and seven sign-ins leave five live. |
| 5 | Medium — RTL (rule 5) | **The icon-mirroring rule reached inside left-to-right islands.** `[dir='rtl'] [data-mirror='true']` is a descendant selector, so it flipped icons inside elements that are deliberately `dir="ltr"` — numeric inputs, and now the PIN pad. In Kurdish the pad's backspace arrow pointed **away** from the digits it deletes. Found by reading the Kurdish screenshot rather than the code. | A second rule of equal specificity, later in the sheet: `[dir='ltr'] [data-mirror='true'] { transform: none }`. It wins exactly inside an LTR island and nowhere else. A Playwright check in Kurdish asserts the pad's arrow has no transform. |
| 6 | Low — honesty of a label | The Sessions tab called every session and ticket without a device label **"This device"**, which is a guess — an unlabelled browser is usually somebody else's phone. | "Unnamed device", in all three languages. |
| 7 | Low — response size | `GET /users/:id/sessions` listed every live session with no bound. At 1,200 sessions per employee in the fixture that is a screen nobody can read and 200 kB to a phone. | The newest twenty, with the tickets already capped at fifty. **19.2 kB** for the tab at volume. |

## Checked and found sound

- **The pair of secrets.** A PIN signs nobody in without a live device ticket for that user on
  that browser; a ticket signs nobody in without the PIN. Sara's ticket with Rebaz's PIN
  resolves to *Sara* and is refused, which is asserted rather than assumed. Five wrong PINs
  revoke the ticket, and then even the right PIN is worthless there until a password sign-in
  issues a new one.
- **Shared versus personal.** Six digits on a shared tablet, four on a personal phone, and a
  ticket **remembers** which kind of browser issued it — claiming to be a personal phone with a
  ticket issued on a tablet does not lower the bar. The admin can switch PIN sign-in off for
  shared devices entirely, and a personal phone is unaffected.
- **The handover.** `switch_from_session` revokes the previous session rather than leaving it
  locked, so nothing the previous employee left open can be reached, and their drafts go with
  it (2.10.2). Both halves are in History under the right names. A handover POST carries the
  previous session's CSRF token, so a cross-site request cannot switch users on a tablet.
- **What dies with what.** A password reset and a deactivation revoke sessions *and* tickets;
  the admin's one button revokes every ticket; the deactivated account is refused before the PIN
  is even considered. Each asserted.
- **The PIN is a credential, so it is treated as one.** Set only by its owner, behind their own
  password (an admin cannot mint one — an admin who could would be able to sign in as anybody);
  hashed with Argon2id like a password; never in a response, never in History. The audit field
  is `pin_length`, because the audit service strips anything named `pin` outright and that guard
  is worth keeping (D-037).
- **Append-only.** `device_tickets` is INSERT/SELECT/UPDATE for the application role with no
  DELETE, asserted against the live database; the sweep runs as the owner. Revoked and expired
  tickets stay listed for the grace period, because "why has my PIN stopped working?" is
  answered by the row that says it was revoked, not by its absence.
- **The Advanced grid** writes through the same `POST /users/:id/permissions` the simple editor
  uses, so implied keys, the last-admin rules and the old set → new set in History are the same
  code — the grid is a second *view*, not a second write path. All 48 keys are named in three
  languages; a grid of `orders.record_payment` is a grid nobody can be asked to use.
- **The lock screen's refusals are different sentences.** "Wrong PIN" with attempts left, "sign
  in with your password on this device first", "PIN sign-in is off on shared tablets", "set a
  longer PIN", "this account is deactivated". Somebody standing at a bench needs to know which
  of those they are looking at, and the screen falls back to the password by itself where that
  is the answer.
- **The policy the locked screen needs.** A locked session cannot read `/settings` (423), so the
  three PIN keys are cached in this browser's preferences while it is unlocked and validated on
  the way back in — a stored "two-digit minimum" falls back to the specification's six (D-038).

## Measured, accepted, and worth watching

| Endpoint | At this volume | Shape |
|---|---|---|
| `POST /auth/login` (password) | **57.5 ms** | Argon2id by design (64 MB, 3 passes) |
| `POST /auth/login` (ticket + right PIN) | 56.6 ms | the same hash, over six digits |
| `POST /auth/login` (ticket + first wrong PIN) | 54.8 ms | deliberately the same cost |
| `POST /auth/login` (dead or unknown ticket) | 3.1 ms | refused before any hashing |
| `GET /users/:id/sessions` (1,200 sessions) | 2.9 ms / 19.2 kB | bounded to 20 + 50 |
| `GET /auth/me` | 2.2 ms | one indexed lookup |
| `GET /history` (first page of 2M) | 2.6 ms | unchanged by this iteration |

- **A sign-in costs an Argon2id hash and that is the point.** 57 ms of CPU per attempt is what
  makes five attempts a wall rather than a formality; NFR-03's budget for a write is 500 ms.
  Thirty employees arriving at once cost thirty hashes, which the pool serialises at ten at a
  time — about 170 ms of queue at the worst moment of the day, and nobody notices it.
- **A dead ticket is refused in 3 ms and a live one costs 55.** That timing difference tells
  whoever holds a ticket whether it is still live, which is information they already have by
  trying it; what it does not reveal is anything about the PIN, because a wrong PIN and a right
  one cost the same hash.
- **The PIN's attempt budget is per ticket, and the password's is per username.** That is
  deliberate (D-035): mixing them would let a mistyped PIN on a tablet lock somebody out of the
  Login page, and letting the PIN share the username's budget would make a shared tablet a way
  to lock colleagues out.
- **Tests.** Two consecutive clean runs of the whole suite (**515 tests** across 29 files: 278
  API, 30 of them this iteration's), the **62 Playwright checks** at 360 px in three languages
  and two themes, and the demo script of 4.7 twice against a live deployment — once on an empty
  database and once on one it had already run against.

# Iteration 0 — code review

Reviewed as a senior engineer would before this becomes a system nobody touches for years:
correctness, logical defects, architecture, DRY, web patterns, and how each decision behaves
when the data grows. Every finding below was fixed in commit `fix(api): address iteration 0
review findings`, and each has a regression test that fails against the previous code.

## Findings and fixes

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | **High — security** | Temporary passwords came from `Math.random()` over an eight-word list. `Math.random` is predictable from previous outputs, and the value is a credential handed to a new employee. | `crypto.randomInt` over a 24-word list plus four digits (~32 bits), with a test that 500 generated passwords never collide. |
| 2 | **High — logical** | The idempotency reservation was released by the error filter for *any* failed request carrying the header. A duplicate that was told to try again shortly would delete the reservation the first copy was still working under, so a third attempt would redo the work. | Ownership is recorded on the request; only the request that reserved the key may release it. |
| 3 | **High — data growth** | The History date filter wrapped the column (`(occurred_at AT TIME ZONE …)::date >= $1`), which no index can serve, and the cursor ordered by `id` alone. At the design point of two million rows a filtered deep page degrades into a scan. | The bound is converted instead of the column; ordering and the cursor are the row value `(occurred_at, id)`, matched by a new composite index. `EXPLAIN` now shows `Index Cond` on an index-only scan reading exactly 25 rows at 200,000 rows, including deep pages. |
| 4 | **Medium — correctness** | The effective permission set was cached in-process for 60 seconds. FR-103 requires a change to take effect at the next request, and a per-process cache is wrong as soon as a second API replica exists — which section 2.14 makes a one-command change. | The set is read per request (a primary-key lookup of a few rows). Test asserts a revoked permission is refused on the very next call, with no sleep. |
| 5 | **Medium — longevity** | `idempotency_keys` had an `expires_at` that nothing acted on, and `sessions` grew forever. Over years of unattended operation both only grow. | `mizan_prune_expired()`, owned by the migrate role, removes expired keys and long-dead sessions. A test asserts it touches no history row. |
| 6 | Low — correctness | `AppModule.configure` called `loadEnv()` three times and constructed two `CsrfMiddleware` instances, binding one and discarding the other. | One instance from injected configuration. |
| 7 | Low — accessibility | The Users page nested a `<button>` inside a `<Link>`: invalid HTML, and two overlapping controls for a screen reader. | A link wearing the button's class, with the underline reset moved into the stylesheet. |
| 8 | Low — correctness | `PATCH /settings` silently dropped unknown keys, so an admin editing a setting this iteration does not own got a cheerful 200 and no change. | The schema is `.strict()`; an unknown key is a 422. |
| 9 | Low — React | The permissions editor copied server state into local state inside an effect, which shows a stale set after a refetch. | The saved set is the source of truth and an explicit `draft` holds unsaved edits; the effect is gone. |

## Checked and found sound

- **Money.** Nothing reaches an amount except through `@mizan/money`; every intermediate is a
  `decimal.js` value and every stored figure is an integer in minor units, guarded by
  `assertSafeAmount` at each boundary. The line-total rule is tested against the
  specification's own worked figures.
- **Append-only.** The application's database role has no UPDATE or DELETE on `audit_log` or
  `login_attempts`, and a test proves it against the live database rather than trusting the
  grant. The only table that gained UPDATE is `idempotency_keys`, which is a 24-hour response
  cache, not history (decision D-009).
- **Authorization.** One guard, ordered authenticate → 423 → 403; a route with no declaration
  is refused rather than opened, and the permission matrix is generated from route metadata so
  a route added in a later iteration is covered the moment it exists.
- **DRY.** The permission catalog, the glossary, the money rules and the search normaliser
  exist once and are imported by both sides. The one duplication that remains is deliberate and
  documented: the pre-paint script in `index.html` restates the preference contract, because it
  must run before any module loads. `preferences.test.ts` guards the two against drift.

## Carried into later iterations

- **`users.list` runs a second `count(*)`** on every page. Harmless for employees; the pattern
  must not be copied to Orders or History, where an estimate or "has more" is the right answer.
- **`SessionService.resolve` writes on read** (`last_seen_at`, at most once a minute). Correct
  at thirty concurrent users; revisit only if the session table becomes hot.
- **No rate limit per IP yet** — only per username (FR-101's requirement). The per-IP limit of
  section 2.8 belongs with the shared-tablet work in I5, where the lock screen becomes a second
  entry point.

# Iteration 6 — code review

Reviewed as a senior engineer would before this becomes a system nobody touches for years:
correctness, logical defects, architecture, DRY, web patterns, and how each decision behaves
when the data grows. This iteration is **polish, performance and go-live**, so the review is
weighted accordingly: what the reference device of NFR-03 actually does, what the evidence
behind each number is worth, and what happens on the day the connection is bad. Every finding
is fixed in this branch, and each has a test that fails against the previous code.

The measurements are taken against the volume fixture in the development database — **1,158,007
orders, 1,227,007 order lines, 1,107,672 customer-ledger rows, 425,010 purchases, 30,040
customers, 5,014 materials, 4,033,249 audit rows, 4,253 MB** — which is between one and three
times the design point of NFR-13. Times are medians of five requests through the running API on
this laptop; the client's server is not this laptop, so the figures are for comparison between
shapes of query, not promises.

**The first finding is about the measurements themselves, and it changes the reading of
everything measured in this iteration before it.**

## Findings and fixes

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | **High — the evidence** | **The volume fixture had no stock ledger.** `scripts/seed-volume.mjs` reported a seeded year of trading, and `stock_ledger` held **43 rows** against 1,227,007 order lines: the step that writes the movements never ran, and the script said nothing. Every stock figure measured in this iteration — the materials list, the Stock report, the dashboard's low-stock tile, the negative-stock check inside every write — had been measured against a table that was not there. A fixture that reports success while writing nothing is worse than no fixture, because it produces numbers people then quote. | Both sides of every movement are written (1,347,043 rows: purchases in, sales out), the script **counts what it wrote and prints it**, and it exits non-zero when the stock ledger is left under a thousand rows. Findings 2 and 3 are what the honest fixture then showed. |
| 2 | **High — performance at volume** | **`item_stock` aggregated the whole stock ledger to answer a question about one material.** The view grouped `stock_ledger` by material every time anybody read it. With the ledger full: `GET /reports/stock` **674 ms** against its stated 500 ms budget — 290 ms of it aggregating all 5,014 materials to send the 200 the report shows; the dashboard's low-stock tile one sequential pass per load; and `stockOf()`, which FR-307's negative-stock rule calls **inside every order and purchase transaction**, the same pass again. | `item_stock_totals` (migration 0017, D-045): one row per material maintained by an `AFTER INSERT` trigger on the append-only ledger, with `item_stock` redefined as a view over it so nothing above the database changed. The application role has no privilege on the table (0018); the trigger runs `SECURITY DEFINER` in the movement's own transaction, which is what lets `stockOf()` see it immediately. **674 → 430 ms.** |
| 3 | Medium — performance at volume | **The two dates of FR-304 were computed from the documents.** `last_sold_on` was `max(order_date)` over every active line of the material, joined to its order: at 245 lines per material, 245 index entries and 245 random heap reads **per material shown**. 200 ms of the Stock report's remaining time, and 200 of the materials list's 280 ms — growing with every year of trading. | Both dates read the stock ledger (0019, D-046): the oldest unreversed `purchase_in`/`opening` movement and the newest unreversed `sale_out`, each an `ORDER BY … LIMIT 1` on a new `(item_id, movement_type, entry_date DESC)` index. A stock question answered by the stock ledger, which is rule 2. **Stock report 350.7 ms, materials list 240.3 ms**, and a plan-shape test asserts the report never reads `order_lines` again. |
| 4 | **High — availability** | **A screen whose chunk never arrived took the whole application down.** Route splitting turned every screen after the first into a file that has to arrive, and three ordinary things stop it: the tablet is in the yard with no signal; the connection drops mid-fetch; the server was deployed while the tab stayed open and the content-hashed file is gone. React unmounts the whole tree on that rejection — a white screen, taking the working screens and the navigation with it — and `React.lazy` caches the rejection, so tapping again changes nothing for the life of the page. | The chunk is asked for **twice** (`lib/chunk.ts`, three unit tests), and `RouteBoundary` catches the second failure: the offline sentence when the device is offline and the broken one otherwise, a reload — which is what actually fixes a file the server no longer has — and a way out, because the navigation bar lives inside the screen that failed. A Playwright check aborts the request and asserts the error state, the way out, and that the next screen still works without a reload. |
| 5 | Medium — the evidence | **Five screenshot baselines were photographs of a loading state.** A skeleton holds perfectly still, and `toHaveScreenshot` waits for two identical frames — so when the typography pass regenerated the baselines, five of them captured the Suspense fallback and were written as truth. Those checks then compared grey bars with grey bars and passed. The three profile screens were the worst of it: they asserted a name and a figure that the **list** behind the transition also shows, so the assertions passed before the destination had rendered. | Every screenshot goes through `shot()`, which waits for the skeletons to be gone on either side of a short pause; the three profile screens identify their destination by its own URL and its tab strip. The five baselines were regenerated and looked at. |
| 6 | Medium — money (rule 7) | **The payment sheet said the remainder was "≈ $0.00".** It passed a zero for the currency that is not the account's settlement one instead of converting, so a 3,050,000 IQD remainder read `3,050,000 د.ع ≈ 0.00 $` — on the remaining line *and* on the live preview of the balance after the payment, which is the figure somebody decides on. | Both convert at the account's rate and are marked `derived`, so the sheet reads `3,050,000 د.ع ≈ 2,337.16 $`. The Arabic screenshot of the sheet is the evidence. |
| 7 | Medium — RTL (rule 5, 2.10.6) | **Names did not carry their own direction.** Specification 2.10.6 point 6 asks for user-entered names to be wrapped in `<bdi>`, and only `DualAmount` ever did. So `Al-Noor Steel Co.` rendered as `.Al-Noor Steel Co` on every Arabic and Kurdish screen: the trailing full stop is a neutral character and took the direction of the paragraph rather than of the name. | 34 call sites plus the header title, the picker rows and the search results render names, notes and usernames inside `<bdi>` — an isolate **and** `dir="auto"`, so the name's own first strong character decides. CSS cannot do this (`unicode-bidi: isolate` exists, `direction: auto` does not), which is why it is markup (D-043). |
| 8 | Medium — usability of finding 4's cause | **A tap could land on the screen the employee was leaving.** React Router navigates inside a `startTransition`, which keeps the previous screen on the glass until the new chunk arrives — about half a second on the 400 kbps reference connection, during which the thumb that has already tapped a customer is still tapping the list underneath. Found as a test failure: after tapping a company, the primary button under the thumb was still the list's "New company". | One Suspense boundary **per route** (D-042), keyed by the route rather than by the record, so a navigation cannot show stale children and the tap always lands on a screen that says "loading". After the first visit the module is in memory, nothing suspends, and no skeleton is seen. |
| 9 | Low — offline behaviour | **The service worker could cache a bad answer as the offline shell, and its cache had no bound.** A 502 from a restarting container became the page everybody saw when they opened the icon without signal; and because the worker file itself does not change between deployments, `activate` — where a cache is usually cleaned — may not run for years, so every deployment's hashed assets accumulated on the tablet for the life of the device. | Only `response.ok` becomes the shell, and the cache keeps its most recent 120 entries, never evicting the shell document itself. |
| 10 | Low — component library (rule 9) | `Card` accepted a `className` and dropped it, because the spread came before it. One screen lost 67 px of layout, which is how it was noticed. | The class is merged; the screenshot that shrank is back. |

## Checked and found sound

- **The typography of 3.7 is real now, and it was not before.** Vazirmatn and Inter were
  specified in section 3.7 and never wired: Kurdish rendered in whatever the device happened to
  have. Both are self-hosted, subset to the glyph ranges these three languages use, and the
  pre-paint script links **only the active language's family** — a Kurdish user never downloads
  Inter. `/font-check` renders the glyph page of 3.7.1 for the sign-off on a real phone, and the
  regenerated screenshots show every Kurdish joining form.
- **The motion budget is honoured where it matters.** `motionAllowed()` says no three ways —
  `prefers-reduced-motion`, two cores or fewer, data-saving mode — and it is re-asked per call,
  because a tablet can be put into reduced-motion mode mid-shift. `useRollingNumber` returns the
  target itself when motion is off, so there is no state to be caught mid-roll, and it cancels
  its frame on unmount. The stagger stops at eight rows and refuses lists over fifty.
- **The import writes what the forms write.** Every row goes through the same service the screen
  calls, in its own transaction, so an imported opening debt is an ordinary ledger entry with an
  ordinary History row attributed to the admin who ran it — and the preview reads the file on the
  admin's own device and names the row and column of every problem before anything is written.
  Admin-only, like every other bulk power.
- **The append-only rules survived two new tables.** `item_stock_totals` and `order_remaining`
  are written by triggers and readable by the application; `REVOKE INSERT, UPDATE, DELETE`
  covers both. The ledger grants are unchanged, and `check-integrity.mjs` now compares **both**
  maintained figures against their ledgers on every restore drill.
- **The PWA is removable, as FR-1313 requires.** Deleting the worker, the manifest and two lines
  of `index.html` leaves the application unchanged; nothing else references them, and no data is
  cached — every `/api/` request goes to the network, always, because A-12 says there is no
  offline editing in v1 and a stale balance shown as current is worse than a refusal.
- **Accessibility.** axe reports no violations on the key screens in all three languages
  (`e2e/accessibility.spec.ts`), the Lighthouse accessibility score is 1.00, the bottom sheet is
  a real modal (the page behind it is `inert`, not merely labelled `aria-modal`), and every
  control on the PIN pad and the forms is at least 44 px in all three languages at 1.25× text.

## Measured, accepted, and worth watching

| Endpoint | Before the review | After | Budget |
|---|---|---|---|
| `GET /reports/stock` | 674 ms | **350.7 ms** | 500 (stated, D-041) |
| `GET /items` (materials) | 291 ms | **240.3 ms** | 300 |
| `GET /dashboard` | 217 ms (empty stock ledger) | **207.7 ms** (1.35 M movements) | 300 |
| `GET /reports/receivables` | 320 ms | **305.9 ms** | 500 (stated, D-041) |
| `GET /customers` | — | 211.0 ms | 300 |
| `GET /orders` (month) | — | 106.5 ms | 300 |
| `GET /history` (first page of 4 M) | — | 4.4 ms | 300 |
| `GET /reports/sales` (year, by material) | — | 533.1 ms | 1,500 (a year in one answer) |
| `GET /reports/profit` (year) | — | 262.9 ms | 1,500 |

All 21 endpoints in `scripts/check-budgets.mjs` are within budget with the stock ledger full.

| The first load on NFR-03's reference device | |
|---|---|
| Initial JavaScript | **156.8 kB gzipped** of the 250 kB NFR-03 allows |
| The whole build | 243.1 kB gzipped across 43 lazy chunks |
| Lighthouse performance / accessibility / best practices | **0.58 / 1.00 / 0.96** |
| First contentful paint · time to interactive | 7.2 s · 8.8 s |
| Font files (Arabic, Vazirmatn-Latin, Inter-Latin) | 37 / 21 / 30 kB, subset from 45 / 34 / 47 |

- **The performance score is 0.58 and the reasoning is written down.** 229 KiB at 50 kB/s is
  4.6 s of download before anything is parsed, with the CPU throttled 4×. `docs/LIGHTHOUSE.md`
  names the three remaining levers with what each is worth (the two unused language catalogs
  ≈ 12 kB ≈ 0.25 s; the 77 kB vendor chunk; the 44 kB formatting and money kernel) and why
  reaching 0.80 on 400 kbps would mean giving up something the specification asks for. The
  assertion in CI is the measured 0.55, not an aspiration nobody believes.
- **Two maintained sums, and no more.** Each one is the remedy 2.2.6 names, each is over an
  append-only ledger, each is trigger-written and unwritable by the application, and each is
  compared with its ledger on every restore drill. A third would need the same three properties
  and the same measurement, or it is a cache with a nice name.
- **What the fixture still does not prove.** It holds one year of trading; the system is meant
  to run for ten. The three figures that grow fastest are the audit log (4 M rows, paged by
  keyset and flat at 4.4 ms), the stock ledger (1.35 M, now summed by the trigger rather than
  scanned) and `order_lines` (1.2 M, no longer read for the two dates). The Sales-by-material
  report over a year is the one query that reads a year of lines on purpose, and it carries a
  stated 1.5 s budget because it is a year in one answer.
- **Tests.** Two consecutive clean runs of the whole suite (**537 tests** across 32 files), the
  **89 Playwright checks** at 360 px in three languages and two themes — including the new one
  that aborts a chunk — and the demo script of 4.8 twice against a live deployment.

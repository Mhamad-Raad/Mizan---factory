# Questions for the product owner

One entry per blocker: date · iteration · the question · the default the agent proceeded with · status.

## Q-A-01 · 2026-09-19 · I0 · Where is the palette system's component library?

`KICKOFF-PROMPT.md` still says `<PATH OR PACKAGE NAME>`. I0's own risk list calls this blocking (A-01).
**Proceeded with:** a local `packages/ui` that mirrors the component names and behaviour of 2.10.11 and
consumes semantic tokens only, so the real `@factory/ui` can replace it without touching a screen (D-001).
**Needed:** the package name or path, and its token pipeline. **Status:** open.

## Q-A-02 · 2026-09-19 · I0 · The palette system's exact primary colour (Q-01)

FR-1311 requires at least 90° of hue separation, verified by side-by-side screenshots.
**Proceeded with:** the plum sheet of 3.2.4; the copper alternative of 3.2.6 is implemented as a second
token file and can be switched in one import (D-006). **Status:** open — needs the client's I0 identity
review.

## Q-A-03 · 2026-09-19 · I0 · Materials model workshop (Q-37) — blocking for I1

I0's acceptance criteria require the workshop to have been held and its outcome recorded before I1 starts.
**Proceeded with:** nothing in I0 depended on it; I1 started on the specification's own default — the catalog
model with monthly prices (D-010), which is what 1.10 Q-37 says to build when the answer does not come.
**Status:** open — I1 is built. If the answer turns out to be *batches*, the Materials page and the Profit
report change; order lines already carry their own cost snapshot, so nothing recorded is lost (D-010).

## Q-A-04 · 2026-09-19 · I0 · Glossary tick-off (Q-26)

The message catalogs use the left-column terms of the glossary in 1.6 for all three languages.
**Proceeded with:** the glossary namespace is a separate catalog file per language, so a change of word is
one edit per term and no screen changes. **Status:** open — client review scheduled for I6 (FR-1204).

## Q-B-01 · 2026-09-19 · I0 · Kurdish and Arabic spellings of the same personal name do not match in search

The fold table of 2.10.7 maps ئ (U+0626) to ی and keeps ە as a letter, so a customer stored as
**ئەحمەد** is not found by searching **احمد**, and FR-501's duplicate check will not warn about the pair.
This is the algorithm exactly as specified, and it is pinned by a test so it cannot change silently.
**Proceeded with:** the specification's table unchanged; the fuzzy second pass already covers the
گ/چ/پ/ژ keyboard problem. **Options if the client wants the names to match:** drop ئ at word start and
treat ە as optional in a third, looser pass used only for duplicate warnings (never for scoping).
**Status:** open — decide during the glossary session (Q-26).

## Q-B-02 · 2026-09-20 · I1 · Which of the optional extras do you want to keep? (Q-23)

The ticked list of section 3 of `client/mizan-client-signoff-summary.md` has not come back.
**Proceeded with:** the default of 1.10 Q-23 — everything the I1 brief lists is built: order receipt,
payment vouchers with numbers, customer statement, order discount with "round down", customer credit
limit (warns, never blocks), payment method and split payments, the walk-in customer, the period lock and
the stale-rate prompt (D-011). Each is removable: a setting, a column or one endpoint.
**Needed:** the ticks, so the screens can lose what you do not want before go-live. **Status:** open.

## Q-B-03 · 2026-09-20 · I1 · A general customer payment does not change any order's status

FR-606 allows a payment recorded from the customer profile without naming an order, and FR-607 derives an
order's status from the entries carrying its `order_id`. Taken literally, a general payment lowers the
balance but leaves every order "unpaid", which will surprise an employee who meant to pay off the oldest
order. **Proceeded with:** the literal reading (D-012); the Orders tab lists unpaid orders first with
their remaining amount so the payment can be linked deliberately. **Options if you want the other
behaviour:** allocate unlinked customer payments oldest-first for *display* exactly as the company side
does (A-29) — presentation only, no data migration. **Status:** open.

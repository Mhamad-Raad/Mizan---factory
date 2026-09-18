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
**Proceeded with:** nothing in I0 depends on it; the I0 tables contain no materials.
**Status:** open — must be closed before I1.

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

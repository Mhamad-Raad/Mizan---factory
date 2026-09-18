> Extracted from `spec/mizan-factory-system-spec-v1.2.md` (Deliverable 3). Section numbers are unchanged, so cross-references to other deliverables resolve in the full document or in the sibling files of this folder.

# Deliverable 3 — UX/UI direction

## 3.1 Design principles

1. **Few screens, progressive disclosure.** Ten primary pages. Detail lives in tabs and bottom sheets, not in new pages. Advanced fields (override a calculated currency, link a payment to a purchase, back-date) are collapsed behind "More" until needed.
2. **One primary action per screen.** Every page has exactly one filled plum button (New order, Add material, Record payment, Save). Secondary actions are text buttons or live in the row/overflow menu.
3. **A form an employee completes on a phone in under a minute.** Defaults do the work: today's date, the signed-in employee, the customer's usual payment type, this month's price. The keyboard matches the field. Pickers open as bottom sheets with search focused and recent choices first.
4. **Totals always visible.** While entering an order or purchase, a sticky footer shows the running total in both currencies and animates when it changes. The user never scrolls to find out what the total is.
5. **Undo where safe, confirm only where not.** Saving, assigning, deactivating, toggling a permission and marking a return all show a toast with Undo (8 s). Undo of a just-saved order, purchase, damage record or payment is available only to the user who saved it, only for 8 seconds, and is implemented as the corresponding compensating write (a void with reason "undo", or a reversal entry with note "undo") — fully logged, and permitted as part of the create permission (no `*.void` key needed for this one case). Void, delete and permission save with "n changes" use a confirm sheet, because they are not safely undoable.
6. **Skeletons, not spinners.** Every list and detail page has a skeleton shaped like its content; no page shows a centred spinner.
7. **Zero dead ends.** Every empty, loading and error state says what happened and what to do next, with a button (section 3.3 lists them per page). A 403 explains who to ask. A conflict shows both versions.
8. **Money is never ambiguous.** Both currencies everywhere; the settlement currency is visually primary; converted balances are marked ≈; the entered currency is the one with the caret.
9. **Direction is designed, not flipped.** RTL first; icons, animations, gestures, numbers and symbols follow section 2.10.6.
10. **Calm surfaces, warm materials.** Plum is used for the one primary action, selected states and the header; everything else is warm stone. Colour appears where it means something (status), never as decoration.
11. **Same hands, different room.** Staff who know the palette system find every control where they expect it; they know which app they are in from the colour of the header and the logo in the corner before reading a word.

## 3.2 Distinct identity from the palette system

### 3.2.1 What stays the same

Layout grid (4 px base, 8/12/16/24 spacing steps), the app shell (header, bottom tab bar on phones, side navigation on desktop), list/detail/form patterns, all component behaviour (pickers, sheets, toasts with undo, skeletons), the icon set (Lucide-style outline icons), touch-target sizes, motion durations and curves, form validation behaviour, the login form layout, keyboard and screen-reader behaviour. Staff feel at home immediately.

### 3.2.2 What is different

| Element | Palette system | Mizan |
|---|---|---|
| Primary hue | Blue / teal (≈ 175–225°) | **Deep plum**, hue ≈ 318° (`#7A2E63` light, `#E79ACF` dark) — 97° from blue, 143° from teal |
| Neutrals | Cool greys (assumed) | **Warm stone** (`#FAF7F4` … `#221B20`), dark theme with a faint plum cast |
| Accent | — | **Brass** (`#8C6A12` / `#E4C260`), used only in the logo mark, the login illustration and the "settled" signature moment |
| App name | (palette name) | **Mizan** — ميزان / میزان |
| Logo mark | (palette mark) | A balance beam with two pans drawn as a single continuous plum stroke; the right pan holds a small stack of three bars (materials), the left a coin. Monochrome plum on light, light plum on dark; brass version for the login screen only. |
| Favicon | (palette) | Plum square, white beam glyph; dark-theme variant inverted |
| Login screen | (palette) | Split layout on desktop — plum panel with the brass mark and a line-art beam animation; on phones, a plum header band with the mark above the form |
| Header colour | (palette blue/teal) | Light theme: plum header (`#5E1F4B`) with white text; dark theme: dark surface with a 2 px plum accent line and the plum mark |
| Empty-state illustration style | (palette) | Two-tone line illustrations in plum + brass on stone, with a rounded "beam" motif recurring (empty list = an empty pan) |
| Typography | (palette pair) | Vazirmatn (Arabic script) + Inter (Latin), section 3.7 |

### 3.2.3 Mood words

**Balanced · Warm · Precise · Unhurried.** The product should feel like a well-kept ledger book on a clean desk: nothing flashy, everything exactly where it should be, with a small sense of reward when a balance settles.

### 3.2.4 Token sheet (both themes, contrast measured)

Semantic tokens consumed by components. Ratios are WCAG 2.1 contrast ratios computed from the hex values (script in CI, section 2.12). Targets: text ≥ 4.5:1, large text / icons / control boundaries ≥ 3:1.

| Token | Light | Dark | Measured contrast (light / dark) |
|---|---|---|---|
| `--color-bg` (page) | `#FAF7F4` | `#161116` | — |
| `--color-surface` (cards, sheets) | `#FFFFFF` | `#211A21` | — |
| `--color-surface-2` (subtle fills, table stripes) | `#F3EEE9` | `#2C232C` | — |
| `--color-text` | `#221B20` | `#F4ECF1` | 16.9 on surface, 15.8 on bg / 14.7 on surface, 16.1 on bg |
| `--color-text-muted` | `#6B5F68` | `#B4A5AF` | 6.1 on surface, 5.3 on surface-2 / 7.2 on surface, 6.5 on surface-2 |
| `--color-border` (dividers) | `#E4DCD8` | `#3B2F3A` | decorative, no target |
| `--color-border-strong` (inputs, control boundaries) | `#9E9098` | `#756573` | 3.05 / 3.13 on surface |
| `--color-primary` | `#7A2E63` | `#E79ACF` | 8.8 on surface, 8.2 on bg / 8.0 on surface, 8.8 on bg |
| `--color-primary-hover` | `#66244F` | `#F0B0DC` | — |
| `--color-on-primary` | `#FFFFFF` | `#33112A` | 8.8 on primary, 10.9 on hover / 7.9 on primary, 9.5 on hover |
| `--color-primary-soft` (selected rows, borrowed chip) | `#F7E6F1` | `#3C1F35` | — |
| `--color-on-primary-soft` | `#6A2555` | `#F2C4E4` | 8.7 / 9.6 on primary-soft |
| `--color-success` (paid, returned & credited) | `#1E7A4C` | `#63CF98` | 5.3 on surface, 4.6 on success-soft / 8.8 on surface, 7.1 on success-soft |
| `--color-success-soft` | `#E3F3EA` | `#163325` | — |
| `--color-warning` (partially paid, pending return, fallback price) | `#8F5400` | `#F0B450` | 6.1 on surface, 5.2 on warning-soft / 9.2 on surface, 7.5 on warning-soft |
| `--color-warning-soft` | `#FBEBD1` | `#3A2A10` | — |
| `--color-danger` (unpaid, void, destructive) | `#B3261E` | `#F58B84` | 6.5 on surface, 5.4 on danger-soft / 7.2 on surface, 6.5 on danger-soft |
| `--color-danger-soft` | `#FCE4E2` | `#3E1A18` | — |
| `--color-header` | `#5E1F4B` | `#211A21` (+ 2 px `--color-primary` line) | on-header text 11.8 / 14.7 |
| `--color-on-header` | `#FFFFFF` | `#F4ECF1` | — |
| `--color-brass` (brand accent only) | `#8C6A12` | `#E4C260` | 5.0 / 9.9 on surface (icon use only) |
| `--color-focus` (3 px ring, 2 px offset) | `#7A2E63` | `#E79ACF` | 8.8 / 8.0 on surface |
| `--color-neutral-chip` (cash, void) | text `#6B5F68` on `#F3EEE9` | text `#B4A5AF` on `#2C232C` | 5.3 / 6.5 |
| `--shadow-sheet` | `0 -8px 24px rgba(34,27,32,.12)` | `0 -8px 24px rgba(0,0,0,.5)` | — |
| `--radius-sm / md / lg` | 6 / 10 / 16 px | same | — |

Colour-vision check: plum (318°) and danger red (≈ 0°) sit close for some colour-vision deficiencies, so I0 includes a deuteranopia/protanopia simulation of every chip and button state; chips never rely on colour alone. Status mapping: Paid → success chip with check icon; Partially paid → warning chip with half-circle icon; Unpaid → danger-soft chip with danger text and clock icon; Void → neutral chip with strike icon; Cash → neutral chip; Borrowed → primary-soft chip; Returnable pending → warning; Returned → success outline; Returned & credited → success filled; Not returnable / Written off → neutral. Every chip carries its word; colour is never the only signal.

### 3.2.5 Logo, favicon and header in use

- Header (phones): 56 px tall, `--color-header`, the mark at the inline start (24 px), the page title centred, one action icon at the inline end. Desktop: a 240 px side navigation with the mark and the wordmark "Mizan / میزان" at the top; the header becomes a slim toolbar.
- Lock screen and login show the mark at 64 px above the form and the app name in the current language, so a shared tablet's home screen is unmistakable.
- Browser tab: favicon plus the title pattern "Order #1042 · Mizan".

### 3.2.6 Alternative identity (only if the palette system turns out to be purple-leaning)

If the palette's "blue" is a violet-blue near 250°, plum at 318° is still 68° away but less distinct. The fallback is a **deep copper** primary (`#9A3F12` light, `#F0A277` dark) on the same warm stone neutrals, with warning shifted to a clear yellow (`#7A5C00` / `#F2D35C`) to keep semantics apart. Same tokens, different values.

## 3.3 Page map with mobile layout notes and states

Global patterns applied to every page: skeleton on load; an `OfflineBar` when the network is unreachable; a `DraftBanner` when a saved draft exists; a bottom tab bar on phones with the first four permitted of Orders · Materials · Customers · Companies · Damaged, then More (History, Reports, Users, Settings, Dashboard, Search); the global "+" action in the header opening a sheet with New order / Add material / Damaged item / Company payment / Customer payment, filtered by permission. Desktop uses a left navigation and two-column detail pages; content max-width 1,200 px.

| Page | Purpose | Mobile layout note | Empty state | Loading state | Error state |
|---|---|---|---|---|---|
| **Login** | Sign in without e-mail | Plum header band with the mark; two fields; one button; language switch as three chips below the form; password visibility toggle; numeric keyboard when the username looks like a phone | — | Button shows inline progress; fields stay editable | Inline generic message; after lockout: "Try again in 14 min" with countdown; offline: "No connection — check Wi-Fi" |
| **Lock screen** | Idle lock, quick unlock, switch user | Full-screen overlay: current user avatar + name, PIN pad (large 44 px keys) or password field, "Switch user" showing up to three recent users as cards (PIN pad when a device ticket exists for that user, password field otherwise), language chips | No recent users → only the current user | — | Wrong PIN: shake + "2 attempts left"; 5 failures → password required |
| **Dashboard** (**Proposed — not requested**) | First screen with today's numbers | Vertical stack of tiles (2 per row ≥ 400 px): Today's sales, Unpaid orders, Purchases today, We owe companies, Low stock (if kept), My recent actions; each tile links to its filtered list; tiles hidden without permission | "Nothing yet today — start with New order" | Tile skeletons | Tile-level error with Retry; other tiles keep working |
| **Materials** | Find materials, see stock and prices | Search bar pinned at top; filter chips (In stock / Out / Inactive / per kg / per piece); list rows: name, stock in the priced measure (other measure when complete), this month's sale price (dual); bought price line when permitted; FAB "Add material" (purchase) for `purchases.create`; "New material" in the overflow | "No materials yet — add your first material" with button; search empty: "No match for '…' — check the spelling or add it" | 8 skeleton rows | "Couldn't load materials" + Retry; keeps last list with "may be out of date" |
| **Material detail** | Stock, dates, prices, movements | Header card: name, pricing unit, stock (large), first bought / last sold; tabs Overview · Prices · Movements · History; Prices tab lists months with dual bought/sale and a "Set this month's prices" sheet; Movements is a ledger list | Prices: "No prices yet — set September's prices"; Movements: "No movements yet" | Skeleton header + tab content | Tab-level Retry |
| **Purchases** (list; a tab in Materials and in each company, also `/purchases`) | Find purchases | Date chips + filter sheet (company, done by, status); rows: number, company or "Stock only", date, total (dual, with permission), status chip; FAB "Add material" | "No purchases in this period — Add material" | Skeleton rows | Retry; keeps last list |
| **Add material / Purchase (new & edit)** | Record a purchase | Company picker (optional, sheet with search, "No company — stock only" row), date (default today), lines as cards with material, count/kg, unit price (MoneyInput with the other currency computed), line total; "Add line" button; "More" (notes, rate for this purchase, done by, discount — **Proposed — not requested**); sticky TotalsFooter with Save | Lines empty: inline "Add your first line" | New: none (empty form); edit: skeleton form until the purchase loads, fields disabled meanwhile | Save failed: toast with Retry (draft kept); conflict: side-by-side sheet; stock warnings inline on the line; edit outside the window: explanation with "Void and re-enter" |
| **Purchase detail** | Review a purchase | Header: number, company, date, done by, status chip; totals (dual); lines list; linked ledger entry (paid/remaining, with permission); History tab; actions: Edit (in window), Void, Duplicate | — | Skeleton | Retry |
| **Orders** | Find orders | Date chips (Today · Week · Month · Unpaid) + filter sheet (customer, done by, assigned to, payment type, status); rows: number, customer, total (dual), payment chip, status chip; FAB "New order" | "No orders in this period — New order" | Skeleton rows | Retry; keeps last list |
| **New order (& edit)** | Create a sale | Wireframe 3.4.1: customer picker at top (recent first, walk-in pinned if kept), payment-type segmented control with "Paid in IQD / USD" for cash, line cards, "More" (notes, rate for this order, done by), sticky totals with "Round down / discount" (**Proposed — not requested**) and Save | Lines empty: inline "Add your first line" | New: none (empty form); edit: skeleton form until the order loads | Same as purchase form |
| **Order detail** | Review, pay, change type, void | Header: number, customer, date, done by, payment chip, status chip; totals and remaining (dual); tabs Lines · Payments (ledger rows + "Record payment" button) · History (incl. payment-type history); actions: Change payment type (sheet with note), Edit, Void, Duplicate, Receipt / share (**Proposed — not requested**); payment rows offer Voucher (**Proposed — not requested**) | Payments: "No payments yet" with Record payment | Skeleton | Retry |
| **Customers** | Find customers | Search pinned; filter chips (Owes us · Settled · Assigned to me · Inactive); rows: name, phone, assigned employee, balance (dual, with permission); FAB "New customer" | "No customers yet — add one" / search empty | Skeleton | Retry |
| **Customer profile** | Balance, orders, ledger | Header card: name, phone (tap to call), assigned employee, balance (large, dual ≈); tabs Overview · Orders · Ledger · History; Ledger rows show running balance; actions: Record payment (with Settle in full), Credit/Refund (permission), Opening balance, Assign, Edit, Deactivate, Statement (**Proposed — not requested**); ledger collapses edited/undone/cash pairs (2.4.5) | Orders: "No orders yet — New order for this customer" | Skeleton | Retry |
| **Damaged items** | Log and track damage | Filter chips (Pending return · Returnable · This month); rows: material, quantity, date, attribution chip, return-status chip; FAB "Record damage" | "No damage recorded — that's good" with the button | Skeleton | Retry |
| **Damage record (new & detail)** | Record / update damage | Wireframe 3.4.3; detail shows stock effect line, attribution links, return actions (Mark returned / Written off / Record credit / Return to stock) | New: none (empty form) | New: none; detail: skeleton | Save failed toast with Retry; detail: Retry |
| **Companies** | Find companies | Search pinned; rows: name, settlement currency, rate, balance (dual, with permission), assigned employee; FAB "New company" | "No companies yet — add one" | Skeleton | Retry |
| **Company profile & accounting** | Rate, balance, ledger, purchases | Header card: name, contact (tap to call), settlement currency, current rate with "since", balance (large, dual ≈); tabs Overview · Accounting · Purchases · History; Accounting = ledger list with running balance and filter chips (Payments · Adjustments · Credits · Purchases); per-purchase section with oldest-first allocation; actions: Record payment (wireframe 3.4.2, with Settle in full), Adjust owed, Set rate, Opening balance, Assign, Edit, Statement (**Proposed — not requested**) | Accounting: "No entries yet"; Purchases: "No purchases from this company yet — Add material" | Skeleton | Retry |
| **History** | Audit log | Two user filters side by side ("Done by", "Assigned to") + date chips + type filter sheet; entries as cards: actor avatar, action sentence, time, expandable diff (old → new rows); infinite scroll | "Nothing in this period" | Skeleton cards | Retry; keeps loaded entries |
| **Reports** | Hub and reports | Hub: cards per report with one-line description (incl. Daily cash-up, **Proposed — not requested**); report page: filters (date chips, done by, assigned to, group by) → summary tiles (dual amounts) → expandable table (horizontal scroll inside the card only) → Export (Proposed) | "No data for this period" | Tile + table skeleton | Retry |
| **Users & permissions** | Admin management | List with status chips; user page tabs Details · Permissions (simple mode with Advanced grid, wireframe 3.4.4) · Activity · Sessions; sticky Save bar | "No employees yet — add one" | Skeleton | Retry; LAST_ADMIN and self-change rules explained inline |
| **Settings** | Device, account, system | Sections as cards: This device (language chips, theme segmented, font size stepper with live preview text, numerals, shared device toggle + device label), My account (change password, PIN), System (admin: global rate + history with the stale-rate prompt (**Proposed — not requested**), idle lock minutes and PIN policy, negative stock rule, edit windows, period lock (**Proposed — not requested**), settlement tolerance, week start, go-live date, backups status; a user with only `settings.set_global_rate` sees the rate card) | — | — | "Preferences cannot be saved on this browser" notice when storage fails; system save errors inline |
| **Search** (**Proposed — not requested**) | Find anything | Full-screen search with keyboard focused; grouped results (Materials, Customers, Companies, Orders, Purchases) | "Type to search" / "No results for '…'" | Row skeletons | Retry |
| **Conflict / 403 / 404 / offline** (global) | System states | Conflict: sheet with "Your version / Current version" and Reload; 403: "You no longer have access — ask your admin"; 404: "This record isn't available"; offline: bar with Retry | — | — | — |

Tablet (≥ 768 px): the bottom tab bar becomes a side rail; lists show two columns; detail pages show the header card and tabs side by side. Desktop (≥ 1,024 px): master–detail for lists with a detail pane, and forms as centred sheets of max 640 px.

## 3.4 Text wireframes (phone, 360 px, RTL as designed; English mirrors)

Conventions: `[ ]` button, `( )` segmented/radio, `[x]` toggle on, `[ ]` toggle off, `[◐]` toggle partly on (indeterminate), `▾` opens a bottom sheet, `⋮` overflow, `≡` drag handle, `←` back (drawn on the right edge because the layout is RTL; in English it sits on the left). Labels are shown in English for readability; the real screens use the glossary terms.

### 3.4.1 New order

```text
┌──────────────────────────────────────────────┐
│  ⋮                New order              ←   │  header: plum, 56 px
├──────────────────────────────────────────────┤
│  Customer                                    │
│  ┌──────────────────────────────────────┐    │
│  │ Kawa Trading ▾           Owes 450,000│    │  picker sheet: search, recent first,
│  └──────────────────────────────────────┘    │  "Walk-in customer" pinned; balance
│                                              │  shown only with permission
│  Payment type      ( Cash ) (● Borrowed )    │  default = customer's last type
│  Paid in           ( IQD ) ( USD )           │  cash orders only: currency received
│  Date              18/09/2026 ▾              │  default today; back-date allowed
│                                              │
│  Lines                                       │
│  ┌──────────────────────────────────────┐    │
│  │ ≡  Copper wire 2 mm        per kg   ⋮│    │  line card 1
│  │    Kg   [  12.500 ]  Count [   —   ] │    │  priced measure first & highlighted
│  │    Price  [ 6,500 ] د.ع  ≈ 4.96 $    │    │  MoneyInput: type one, see other
│  │    This month's price · override ▾   │    │  price source marker
│  │    Line total   81,250 د.ع · 62.02 $ │    │  IQD entered: 6,500 × 12.5; USD = 81,250 ÷ 1,310
│  │    Stock 240.5 kg                    │    │  stock hint; warning if exceeded
│  └──────────────────────────────────────┘    │
│  ┌──────────────────────────────────────┐    │
│  │ ≡  Steel sheet 1.2 mm    per piece  ⋮│    │  line card 2
│  │    Count [   40 ]   Kg   [ 96.000 ]  │    │
│  │    Price  [ 18,000 ] د.ع ≈ 13.74 $   │    │
│  │    Line total 720,000 د.ع · 549.62 $ │    │
│  └──────────────────────────────────────┘    │
│  [ + Add line ]                              │  opens material picker sheet
│                                              │
│  ▸ More (notes, rate for this order, done by)│  collapsed; rate defaults to 1,310
│                                              │
├──────────────────────────────────────────────┤
│  Discount   [ 0 ]  · Round down ▸            │  Proposed — not requested (FR-616)
│  Total   801,250 د.ع  ·  611.64 $            │  sticky TotalsFooter, sums per currency
│  [            Save order (2 lines)         ] │  primary, full width, thumb zone
└──────────────────────────────────────────────┘
```

Material picker sheet (opened from "Add line"): search field focused with the keyboard up, "Recent" section, then all materials with stock and this month's sale price; tapping a row adds the line and returns to the form with the quantity field focused and the numeric keyboard shown. Save shows a success toast "Order #1043 saved · Undo" and returns to the Orders list with the new row highlighted.

### 3.4.2 Company payment

```text
┌──────────────────────────────────────────────┐
│                Record payment            ←   │  bottom sheet over Company profile
├──────────────────────────────────────────────┤
│  Al-Noor Steel Co.                           │
│  We owe   4,500,000 د.ع   ≈ 3,435.11 $       │  balance (settlement first, ≈ other)
│  Rate     1 $ = 1,310 د.ع  (company rate)    │  RateBadge; "since 01/09/2026"
│                                              │
│  Amount                                      │
│  ┌────────────────────┐ ┌──────────────────┐ │
│  │ 1,000,000     د.ع  │ │  763.36       $  │ │  type in either; the other fills
│  └────────────────────┘ └──────────────────┘ │  instantly; caret marks entered side
│  Calculated at 1,310 · [ edit calculated ]   │  override → "manual rate" marker
│                                              │
│  Date paid        18/09/2026 ▾               │
│  Paid by          Sara (you) ▾               │  "who made the payment"
│  ▸ More: link to a purchase, note            │  purchase picker: open purchases
│                                              │  of this company with remaining
├──────────────────────────────────────────────┤
│  After this payment: 3,500,000 د.ع ≈ 2,671 $ │  live preview of new balance
│  [            Record payment               ] │
└──────────────────────────────────────────────┘
```

On save: the sheet collapses into the ledger list, the new row slides in at the top, and the balance in the header rolls from 4,500,000 to 3,500,000 (signature moment 3, section 3.6). Toast: "Payment recorded · Undo" (undo = reversal entry with note "undo", allowed for 8 s and only for the recording user).

### 3.4.3 Damaged item

```text
┌──────────────────────────────────────────────┐
│                Record damage             ←   │
├──────────────────────────────────────────────┤
│  Material                                    │
│  ┌──────────────────────────────────────┐    │
│  │ Copper wire 2 mm ▾      Stock 228 kg │    │
│  └──────────────────────────────────────┘    │
│  Quantity    Kg [ 4.000 ]   Count [  —  ]    │  priced measure first
│  Date        18/09/2026 ▾                    │
│                                              │
│  Where did it come from?  (optional)         │  attribution, four large tiles
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ │
│  │ None   │ │Customer│ │  Us    │ │Company │ │  selected tile filled plum
│  │        │ │ order  │ │        │ │   ●    │ │
│  └────────┘ └────────┘ └────────┘ └────────┘ │
│  Company     Al-Noor Steel Co. ▾             │  appears for Company
│  Purchase    #P-0231 (05/09/2026) ▾ optional │  purchases of that company w/ item
│                                              │
│  Can it be returned?        [x] Yes          │  returnable flag
│  Reason (optional)                           │
│  ┌──────────────────────────────────────┐    │
│  │ Arrived with cracked insulation      │    │
│  └──────────────────────────────────────┘    │
│  ▸ More: note                                │
├──────────────────────────────────────────────┤
│  Stock will decrease by 4.000 kg             │  stock-effect sentence (or "No stock
│  [            Save damage record           ] │  change — goods were already sold")
└──────────────────────────────────────────────┘
```

Detail view after saving shows the chip "Returnable — pending" and the actions "Mark returned" (with "and record credit" when a company is attributed, opening the credit sheet pre-filled from the purchase line price) and "Written off".

### 3.4.4 Permissions editor (admin)

```text
┌──────────────────────────────────────────────┐
│  ⋮        Rebaz Ahmed · Permissions      ←   │
├──────────────────────────────────────────────┤
│  Preset   [ Sales ▾ ]                        │  apply preset → diff sheet → confirm
│  ──────────────────────────────────────────  │
│  Extras                                      │  six everyday toggles (1.5.3)
│      Can void orders / purchases      [ ]    │
│      Sees bought prices               [ ]    │
│      Sees all customers               [ ]    │  off = assigned customers only
│      Sees balances                    [◐]    │  partly: customers yes, companies no
│      Can adjust what we owe           [ ]    │
│      Can set exchange rates           [ ]    │
│  ──────────────────────────────────────────  │
│  ▸ Advanced — full permission grid           │  opens the page × action grid
│      (customised in Advanced: Orders › Edit) │  shown when the set ≠ preset + extras
│                                              │
│  When expanded:                              │
│  ▾ Orders                       View  [x]    │  page group; master toggle
│      Create                           [x]    │
│      Edit (while unpaid)              [x]    │
│      Void                             [ ]    │
│      Change payment type              [x]    │
│      Record payment                   [x]    │
│      Credit / refund                  [ ]    │
│  ▸ Materials · Purchases · Customers · …     │  collapsed groups show View state
│  ▾ Fields                                    │
│      See bought prices                [ ]    │
│      See profit                       [ ]    │  greyed: needs bought prices
│      See company balances             [ ]    │
│      See customer balances            [x]    │
├──────────────────────────────────────────────┤
│  3 changes                                   │  sticky bar; lists the changes on tap
│  [ Discard ]        [   Save permissions   ] │  confirm sheet lists old → new
└──────────────────────────────────────────────┘
```

Simple mode is what most admins ever need: a preset and six toggles. In Advanced, toggling "Create" with View off turns View on and shows an inline note "also turned on: View orders"; turning View off collapses the group and turns off its actions with an Undo toast. Rows are 48 px tall for one-handed use.

## 3.5 Key flows (step by step)

### 3.5.1 Create an order on a phone (Sales employee)

1. From the Orders tab, tap the plum "New order" button (or "+" in the header → New order).
2. The customer picker opens automatically with the keyboard: type two letters (any script), tap "Kawa Trading". The picker closes; the form shows the customer with their balance (if permitted).
3. Payment type is pre-selected from the customer's last order (Borrowed). Date is today. (For a cash order the "Paid in IQD / USD" chip appears and defaults to the customer's last choice.)
4. Tap "Add line" → material picker (recent first) → tap "Copper wire 2 mm" → the line card appears with the Kg field focused and the decimal keyboard up. Type 12.5. The price is pre-filled from September's sale price in the currency it was typed in, the other side at the order rate; the line total appears.
5. Tap "Add line" again → "Steel sheet 1.2 mm" → Count 40 → done. The sticky footer total ticks up with each change.
6. (Optional) Expand "More" to add a note.
7. Tap "Save order (2 lines)". The button shows progress; the API writes order, lines (with their cost snapshots), stock movements and ledger entries in one transaction. Toast "Order #1043 saved · Undo · Share receipt" (receipt **Proposed — not requested**); the Orders list shows the new row highlighted. Total time for a trained user: about 40 seconds.
8. If the network fails mid-save, the toast says "Couldn't save — Retry" and the draft is kept; a retry reuses the idempotency key, so the order is never duplicated.

### 3.5.2 Add material as a purchase from a company (Warehouse employee)

1. Materials tab → "Add material" (FAB). The company picker opens: choose "Al-Noor Steel Co." (or "No company — stock only"). The rate badge shows the company's rate.
2. Date today; "Rate for this purchase" under More shows the company's 1,310 and can be changed if a different dollar was agreed for this delivery. Add line → "Steel sheet 1.2 mm" → Count 200 → the unit price pre-fills from September's bought price in the currency it was typed in (visible because the Warehouse preset sees bought prices); the USD side fills at the purchase rate.
3. Add a second line for a new material: in the picker, tap "New material" → a short sheet (name, pricing unit) → saved and selected in one go.
4. Footer shows the total in both currencies; tap "Save purchase". Stock increases, and the company's balance increases by the total (visible to users who may see balances). Toast with Undo.
5. The Purchase detail shows "We owe for this purchase: 3,600,000 د.ع" (with permission) and links to the company.

### 3.5.3 Record a company payment with auto-conversion (Accountant)

1. Companies tab → "Al-Noor Steel Co." → the header shows the balance and rate; tap "Record payment".
2. The sheet (3.4.2) opens with the amount fields; type 1,000,000 in the IQD field; the USD field fills with 763.36 at 1,310. (Typing in the USD field instead fills the IQD field.)
3. Optionally tap "edit calculated" to overwrite the USD value (the sheet then shows "manual rate 1,305").
4. Confirm the date, "Paid by" (defaults to you; choose another employee if they physically paid), optionally link to a purchase and add a note.
5. The preview line shows the balance after the payment. Tap "Record payment". The ledger list gets a new row with running balance and voucher number; the balance rolls down; History gets "Payment · 1,000,000 د.ع · by Sara · balance 4,500,000 → 3,500,000"; the toast offers "Share voucher" (**Proposed — not requested**).
6. Paying the last instalment in dollars: tap "Settle in full", type the $ amount actually handed over — the entry stores the exact remaining IQD balance with that USD amount as a manual-rate pair, and the balance lands on zero (no residue).

### 3.5.4 Change an order's payment type and record a partial payment

1. Open Order #1043 (Borrowed, Unpaid, 801,250 د.ع). Tab "Payments" → "Record payment".
2. The sheet pre-fills the remaining amount; change it to 300,000 د.ع (USD fills at the global rate); date today; "Received by" you; optional note. Save → chip changes to "Partially paid"; remaining shows 501,250 د.ع.
3. Later, the customer pays the rest in cash at the counter: tap "Change payment type" → choose Cash → the sheet explains "This records a cash settlement of the remaining 501,250 د.ع today" and asks "Paid in IQD / USD" → note required ("paid at counter") → Confirm. The order becomes Paid; the payment-type history shows Borrowed → Cash with the note, who and when. (Had the customer paid the rest in dollars through "Record payment", "Settle in full" would have written the exact remainder and the received dollars as a manual-rate pair.)
4. Reverse direction (Cash → Borrowed) works the same way: the sheet explains "The cash settlement will be reversed and the order will be owed again"; note required.

### 3.5.5 Log a damaged item and mark it returnable

1. Damaged items tab → "Record damage" (or "+" → Damaged item).
2. Pick "Copper wire 2 mm", type 4 kg, keep today's date.
3. Under "Where did it come from?" tap "Company" → pick "Al-Noor Steel Co." → optionally pick purchase #P-0231. Toggle "Can it be returned?" on. Type the reason.
4. The footer says "Stock will decrease by 4.000 kg". Save. The list shows the record with "Returnable — pending".
5. When the goods go back: open the record → "Mark returned" → "and record credit" is pre-ticked (accountant permission) → the credit sheet shows 4 kg × 5,900 د.ع (purchase line price) = 23,600 د.ع ≈ 18.02 $ at the company rate, editable with a note → Confirm. Chip becomes "Returned & credited"; the company ledger shows the credit; the balance falls.

### 3.5.6 Adjust a company's owed amount with a note (Accountant)

1. Company profile → "Adjust owed". The sheet shows the current balance (3,476,400 د.ع).
2. Choose "Set new balance" or "Change by": type −476,400 as a change (or 3,000,000 as the new balance; the other field updates). The USD side fills at the company rate.
3. Note is required ("Agreed discount for late delivery, per phone call with Mr. Ali"); optionally link to a purchase.
4. The preview shows "3,476,400 → 3,000,000 د.ع". Tap "Save adjustment". The ledger shows "Adjustment −476,400 · by Sara · note"; History shows old → new. The entry cannot be edited; a mistake is corrected by another adjustment.

### 3.5.7 Void an order

1. Open order #1044 (Borrowed, 801,250 د.ع, 300,000 د.ع received so far) → overflow "⋮" → "Void order". If the user lacks `orders.void`, the item is absent.
2. A confirm sheet explains the effect: "Stock for 2 materials will be restored; the order's 801,250 د.ع will be removed from the customer's balance; the 300,000 د.ع already received stays on the customer's account as credit (balance −300,000)." Reason field required.
3. Confirm → the order shows a "Void" chip, greyed lines, and a banner "Voided by Sara on 18/09/2026: reason". Reversal movements and entries are written; History shows the void. "Duplicate as new order" is offered.

### 3.5.8 Admin edits an employee's permissions

1. More → Users → tap "Rebaz Ahmed" → tab "Permissions" (3.4.4), which opens in simple mode: the preset and six extras.
2. Optionally apply a preset; a diff sheet lists what turns on and off; confirm. Toggle an extra ("Can void") if needed.
3. Only for an unusual case, open "Advanced" and toggle individual keys; implied keys switch on with an inline note; the sticky bar counts changes.
4. Tap "Save permissions" → a confirm sheet lists old → new → Confirm. The change applies at Rebaz's next request: a button he had disappears; a request in flight returns 403 with a friendly message. History records the change with old set → new set.

### 3.5.9 Switch language, theme and font size

1. More → Settings → "This device". Language: tap "کوردی / العربية / English" chips — the whole app re-renders and mirrors direction with a 300 ms cross-fade; numbers and dates reformat; nothing reloads.
2. Theme: segmented Light / Dark / Follow device — surfaces cross-fade (200 ms); the header, favicon and status bar colour follow.
3. Font size: stepper Small / Default / Large / Extra large with a live preview sentence; the entire app scales through `--font-scale`; layout is verified at Extra large.
4. All three are saved on this device immediately; the card says "Saved on this device". Reloading the page starts in the chosen language, theme and size with no flash.

### 3.5.10 Handing a shared tablet to another employee

1. Sara finishes a purchase; she taps the lock icon in the header (or the tablet locks itself after 5 minutes idle; if a form has unsaved changes, a 30-second countdown appears first).
2. The lock screen shows Sara's avatar and PIN pad, and "Switch user" with the recent users Rebaz and Ahmed.
3. Rebaz taps his card → enters his PIN (because he signed in with his password on this tablet earlier this week; otherwise his password) → Sara's session is revoked (`switch_user`), Sara's drafts are discarded, Rebaz's session starts on his last page. History records Sara's lock and Rebaz's sign-in.
4. Theme and font size stay as set on the tablet, as the client requested; the language switches to Rebaz's last choice on this device (remembered next to his name in the same browser storage), so a Kurdish and an Arabic speaker can share one tablet without fighting the setting. The lock screen notes "Settings on this device are shared".

## 3.6 Animation guidelines and signature moments

### 3.6.1 Rules

| Rule | Specification |
|---|---|
| Micro-interactions (toggles, chips, buttons, focus, checkmarks) | 150–250 ms, `cubic-bezier(0.2, 0, 0, 1)` (ease-out); pressed state 100 ms |
| Page and sheet transitions | 250–400 ms; pages slide 24 px in reading direction and fade; bottom sheets rise with a spring (stiffness 300, damping 30) and dim the backdrop to 40 % |
| List items | Enter: fade + 8 px slide in reading direction, staggered 30 ms up to 8 items; exit: collapse height 200 ms then fade; new row after save: 600 ms plum-soft highlight that fades |
| Success feedback on save | Button morphs to a check (200 ms), toast slides from the bottom (250 ms) with the Undo action; the saved row highlights in the list |
| Totals that change | Digits roll (odometer) 300 ms per change, tabular figures so width is stable; a subtle scale 1.00 → 1.02 → 1.00 on the total when a line is added |
| Bottom sheets and drawers on mobile | Drag-to-dismiss with velocity; snap points 60 % and 100 %; keyboard pushes the sheet up rather than covering fields |
| Direction | All horizontal motion uses `--dir` (2.10.6): sheets from the end edge, swipes from the start edge, progress start → end; vertical motion is unchanged |
| Reduced motion | With `prefers-reduced-motion: reduce`: transitions become 80–100 ms opacity fades, no slides, no odometer (numbers just update), no stagger, no spring; toasts still appear |
| Never block input | Animations run on transform/opacity only (compositor), never on layout properties; forms accept input during transitions; a save's progress state is shown in the button, not in a blocking overlay |
| Loading | Skeletons shimmer 1.2 s loop; no spinners; a skeleton appears only after 150 ms so fast responses never flicker |
| Budget | No animation on lists longer than 50 items; disabled entirely on devices reporting `navigator.hardwareConcurrency ≤ 2` and `saveData` |

### 3.6.2 Signature moments (where Mizan should feel delightful)

1. **The total ticks.** Adding a line to an order or purchase makes the footer total roll up digit by digit in both currencies with a soft scale pulse — the employee sees the sale grow.
2. **Balance settles.** When a payment brings an order or a company balance to zero, the number rolls down to 0, the status chip flips to Paid with a check drawn in 250 ms, and a thin brass line sweeps across the card once (the only place the brass accent moves).
3. **The row lands.** After Save, the sheet collapses towards the list and the new row slides into place with the highlight, so the user sees where their work went instead of a blank success page.
4. **Handover.** On the lock screen, the recent-user cards slide in from the end edge; tapping one flips the card to the PIN pad — quick, and clearly "someone else is here now".
5. **Language mirror.** Switching between Kurdish/Arabic and English cross-fades the whole layout while it mirrors (300 ms), rather than snapping — a small moment that shows all three languages were designed, not bolted on.

## 3.7 Typography and numerals

### 3.7.1 Fonts

| Role | Font | Reason |
|---|---|---|
| Arabic script (Kurdish Sorani and Arabic UI text, names, notes) | **Vazirmatn** (variable, open licence, self-hosted), fallback **Noto Sans Arabic** | Complete Arabic-script coverage including the Kurdish letters ڵ ڕ ۆ ێ ە ڤ گ چ پ ژ (U+06B5, U+0695, U+06C6, U+06CE, U+06D5, U+06A4, U+06AF, U+0686, U+067E, U+0698), clean at small sizes on low-end screens, matching x-height with Inter, tabular Eastern digits available |
| Latin (English UI, numbers in all languages) | **Inter** (variable), fallback system sans | Tabular figures (`font-variant-numeric: tabular-nums`) for amounts, wide language support |
| Numbers inside Arabic-script text | Inter for Western digits; Vazirmatn for Eastern digits | Keeps digit shapes consistent per numeral setting |

Font stacks: `--font-arabic: "Vazirmatn", "Noto Sans Arabic", "Segoe UI", Tahoma, sans-serif;` and `--font-latin: "Inter", system-ui, sans-serif;` applied by `lang` (`:lang(ckb), :lang(ar) { font-family: var(--font-arabic) }`). Fonts are subset (Arabic + Latin ranges + digits), `font-display: swap`, preloaded by the pre-paint script for the active language; total ≤ 120 kB per family.

**Glyph verification (done in I0, repeated in I6):** a hidden "font check" page renders the string `ڵ ڕ ۆ ێ ە ڤ گ چ پ ژ ئ — هەولێر، سلێمانی، کەرکووک — ١٢٣ ۱۲۳ 123 — د.ع $` in every font size and both themes; screenshots are compared on Android Chrome, Samsung Internet, iOS Safari, desktop Chrome/Firefox/Edge/Safari; any tofu box or wrong joining form fails the check. The Kurdish letters must render as their own glyphs (not fallback shapes) and join correctly in initial/medial/final forms.

### 3.7.2 Sizes and rhythm

| Style | Size (rem) | Line height | Weight | Use |
|---|---|---|---|---|
| Display | 1.75 | 1.25 | 600 | Balance on profile headers |
| Title | 1.25 | 1.3 | 600 | Page titles, sheet titles |
| Heading | 1.0625 | 1.4 | 600 | Card titles, section headings |
| Body | 1 | 1.5 (Latin) / **1.65 (Arabic script)** | 400 | Everything |
| Label | 0.875 | 1.4 / 1.55 | 500 | Field labels, chips |
| Caption | 0.75 | 1.4 / 1.55 | 400 | Secondary amounts, timestamps |
| Amount (primary) | 1.125 | 1.3 | 600, tabular | DualAmount primary |
| Amount (secondary) | 0.875 | 1.3 | 400, tabular, muted | DualAmount secondary |

Arabic-script adjustments: line-height 10 % larger than Latin (ascenders/descenders and diacritics), **letter-spacing always 0** (positive tracking breaks joining), no all-caps transforms (meaningless in Arabic script, and `text-transform` is disabled for `:lang(ar), :lang(ckb)`), slightly heavier weight (500 instead of 400) at Caption size on dark backgrounds for legibility, underline offset increased (`text-underline-offset: 0.2em`) to clear descenders. Latin display sizes may use −0.01 em tracking; body Latin uses 0.

### 3.7.3 Font-size scale (Settings)

| Setting | `--font-scale` | Body size at 16 px base | Notes |
|---|---|---|---|
| Small | 0.875 | 14 px | For dense desktop use |
| Default | 1 | 16 px | |
| Large | 1.125 | 18 px | Recommended for floor tablets |
| Extra large | 1.25 | 20 px | Verified: no horizontal overflow at 360 px; touch targets stay ≥ 44 px (they are in px, text in rem) |

The scale multiplies every `rem` in the app (2.10.9), including spacing that should breathe with text; it stacks with the OS text-size setting (`html { font-size: calc(100% * var(--font-scale)) }` keeps the browser's default as the base). The Settings stepper shows a live preview line in the current language.

### 3.7.4 Numerals

- Setting "Numerals": Western (0–9, default) or Eastern Arabic-Indic. For Arabic the Eastern set is ٠١٢٣٤٥٦٧٨٩ (`nu-arab`); for Kurdish the Persian/Kurdish shapes ۰۱۲۳۴۵۶۷۸۹ (`nu-arabext`), because ۴ ۵ ۶ differ from ٤ ٥ ٦. English always shows Western digits.
- Amounts, quantities, dates, order numbers and phone numbers follow the setting; input fields accept either and normalise (2.10.4).
- Digits are always rendered with tabular figures in tables, totals and ledgers so columns align in both directions.

---

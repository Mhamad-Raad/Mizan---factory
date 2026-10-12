# Review of D-085 (buying from companies) and D-086 (printing) · 2026-10-12

A full pass over everything `feat/buying-and-receipts` changes against `main`: correctness first
(money, ledgers, permissions), then architecture, then clean code. Seventeen findings; fifteen
fixed, two kept on purpose and said why. Each fix has a test that fails without it where a test can
say it.

## Money and ledgers

1. **A void or an undo left the "paid now" payment standing.** Voiding a purchase typed twice and
   paid in full left the company 150,000 "paid ahead" for money that went out once. Orders never
   had this — a void reverses the order's cash settlement. **Fixed:** the paid-now payment carries
   the note `Paid with purchase #N` and is written in the purchase's own transaction; a void or an
   undo reverses the live payment that has *both* (the same words typed on a later payment are
   never taken back). Payments made to the purchase afterwards stay. The sheet says so.
2. **An edit could take a purchase below what was paid on it**, undoing the "never more than the
   purchase" rule of paying now. **Fixed:** refused (`BELOW_PAID`), computed from the live rows that
   name the purchase. Found on the way: `purchase_linked_totals` counts the reversal of the
   purchase's previous version as money paid, so any edit read as an overpayment — the old "settle
   in full" on a purchase read that view too, and so was wrong after any edit. Nothing reads the
   view now; it is left in the database (dropping it is a migration for nothing).
3. **"Settle in full" against a purchase paid its whole total again** when an unlinked payment had
   already covered part of it oldest-first: the sheet said 50,000 and the account was charged
   150,000. The purchase page had a client-side patch that also threw away the currency handed
   over. **Fixed where it belongs:** the server settles what the purchase still owes oldest-first —
   the figure every screen shows — through one `CompaniesService.allocationOf`, which the
   breakdown and a purchase's own figures now share. The patch is gone.
4. **"All of it" recorded the money as leaving in the account's currency** whatever was handed
   over, so the cash-up (FR-1013) counted the wrong drawer. **Fixed:** "Paid in" dinars or dollars,
   opening at the company's currency.
5. **A line's cost opened at the month's bought price in dinars and was sent back as typed**, so a
   price set in dollars became a dinar figure at another company's rate. **Fixed:** an untouched
   line sends no price and the server applies the month's in its own currency (FR-408), as the
   order form does.
6. **"We still owe companies" added each account's *other* column** — for a dollar company paid at a
   higher rate than it bought at, a negative dinar figure that lowered the total (review lesson 4,
   again). **Fixed:** the dinar companies in dinars and the dollar companies in dollars, two
   figures, each with the other side at today's rate. Hidden companies are left out, as the list
   the figure opens leaves them out.

## Permissions and screens

7. **Receipts were offered to readers who could not load them** — a cashier who may take a payment
   but not see balances got a failed print. **Fixed:** `requiredFor(document)` names each
   document's route permissions; the toast offers a receipt only when they are held, and an
   account row prints as a voucher when the reader may not open its order or purchase.
8. **The Companies list's filters read the net figure while its column showed one side**, so a
   company we owe more than it owes us vanished from "They owe us" while its row said it owed.
   **Fixed:** each filter reads the side its column shows and needs only that side's flag; the
   D-054 test now says so.
9. **The overview listed overpaid purchases as owed** (a negative remainder in red). **Fixed:** only
   what is still owed, and the "and N more" total from the same rows.
10. **A refusal the line cards do not show was swallowed** (a material deactivated since it was
    picked: Save did nothing), and removing a line moved the old refusals onto the wrong card.
    **Fixed:** only refusals shown under an input skip the banner; removing a line clears them.
11. **"Buy more" and a new material's first purchase converted at the company's rate while saying
    "the system rate".** **Fixed** with `useDocumentRate`, which names the rate in force.
12. **A purchase just saved re-offered its receipt after a reload.** **Fixed:** the navigation state
    is wiped as the page opens, as the Orders list does.

## Architecture and clean code

13. **Unused work on every request:** the company-wide owed sum ran on a company's own Purchases tab
    and on every page of a printout. **Fixed:** only on the Purchases page; later pages of a
    printout send `totals=false` (both lists).
14. **Five copies of "read this account and its rate"** and two of the "we owe them" label.
    **Fixed:** `lib/accounts.ts` — `useAccount`, `useDocumentRate`, `payableAmount`, `payableLabel`.
15. **Two near-identical number lookups**, one wedged between `statement()` and its doc comment.
    **Fixed:** `common/document-numbers.ts`, and the comment is back on its method.
16. **Leftovers:** page-title juggling in the print host that never set a title, an unused period
    helper, eight unused strings, and comments saying buying happens only in Materials. Removed or
    rewritten.

## Kept on purpose

17. **Single-currency figures that remain:** a statement's running and closing balances are in the
    account's currency, as the account's own page has always shown them (`LedgerList`); the
    material picker's price line is a one-line hint, as the order form's is; a payment sheet's
    purchase choices are option text. Every amount a row or a total is *about* goes through
    `DualAmount`.

Tests added by this review: 8 API cases in `buying-from-companies.test.ts` (18 in all), the
paid-now note in `record-names.test.ts`.

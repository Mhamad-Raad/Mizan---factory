# Mizan — Summary for sign-off

*Companion to the full specification (v1.2). Four pages instead of two hundred: what the system does, the eight decisions we need from you, the defaults we will use if you say nothing, and what we need before we start. Please read this with the glossary table (specification section 1.6) beside you.*

## 1. What Mizan does, in one paragraph

Mizan is a website for your phones, tablets and office computers, in Kurdish, Arabic and English, with a light and a dark look. You record what you buy from your supplier companies (the "Add material" page), and the system keeps your stock and counts what you owe each company at that company's own dollar rate. You record what you sell to customers as orders — by weight or by count, with a note — either paid in cash or "borrowed" (on credit); the system keeps each customer's balance, accepts part-payments, and lets you change an order from borrowed to cash later. Every material has this month's buying price and selling price in dinars and dollars. Damaged goods are recorded with where they came from (a customer order, us, or the company) and whether they can be returned; returns reduce what you owe the company. Every action records who did it and when, nothing is ever silently changed or deleted, and you can see history and reports filtered by employee and date. The admin creates the employee accounts (no e-mail needed) and decides exactly what each employee can see and do.

## 2. What you will see, step by step

| Step | What we show you at the end of it |
|---|---|
| 0 — Foundation | The Mizan look on a phone in all three languages; sign-in; creating employees and choosing what they can do; light/dark; text size; the history list. |
| 1 — Selling | Materials with monthly prices; customers; a full order on a phone in under a minute; part-payments; the customer's balance; receipts, payment slips and statements if you keep them. |
| 2 — Buying | Companies with their own dollar rate; "Add material"; what you paid and what you owe each company, per purchase; payments typed in dinars *or* dollars with the other filled in; changing what you owe with a note. |
| 3 — Damaged goods | Recording damage, who it came from, returnable or not, and returns that reduce what you owe. |
| 4 — Reports & history | Sales, purchases, profit margin, stock, who owes you, who you owe, damage, employee activity, daily cash per employee; full history with filters. |
| 5 — Shared tablets | Quick switching between employees on one tablet with a PIN; the advanced permission screen. |
| 6 — Go-live | Polish, speed on cheap phones, your translations checked, your opening stock and debts entered, backups tested, training. |

## 3. Eight decisions we need from you

For each one we say what we recommend and what changes if you choose differently. Everything else in the specification is already decided in a way that is cheap to change later.

**Decision 1 — How you think about materials (we must settle this in a 30-minute session before step 1).**
Our reading: one entry per material ("Copper wire 2 mm") with a running stock and a price list per month. The other possibility: each purchase is its own batch with its own price, and "date sold" means the day that batch ran out. If you think in batches, the materials page and the profit report are built differently. *Recommendation: the material-with-monthly-prices model; we will show you paper mock-ups of both.*

**Decision 2 — Monthly prices.**
You said "each month's prices bought and sold". We will let you type each material's buying and selling price per month (in one currency; the other fills in at the rate), with a "copy last month" button. If a month has no price yet, the previous month's price is used quietly with a small marker. Alternative: the buying price could be calculated from your actual purchases instead of typed. *Recommendation: typed per month.*

**Decision 3 — Which customers each employee sees.**
"Who assigns to who": we will let the admin assign each customer to an employee, and by default a sales employee sees only their own customers and orders (the admin can open it up per employee). Every action also records who did it. *Recommendation: as described; tell us if all employees should see all customers.*

**Decision 4 — Payments on borrowed orders.**
We support several part-payments per order, payments in dinars or dollars (the other filled in), a "settle in full" button that closes an order exactly even when the last payment is in dollars, and a general payment not tied to one order. Alternative: only "mark as paid". *Recommendation: as described.*

**Decision 5 — Cash sales to unnamed buyers.**
Every order names a customer. For cash sales to walk-in buyers we propose one shared "Walk-in customer" record; cash orders also record whether the customer paid in dinars or dollars, so you can count the cash drawer per employee every evening. *Recommendation: keep both; cut the walk-in record if every buyer is always named.*

**Decision 6 — Damaged goods and returns.**
Damage recorded as "from us" or "from a company" reduces stock; damage that came back with a customer's order does not (it had already left stock), and can be put back in stock if it turns out usable. When damaged goods go back to a company, the amount is taken off what you owe them (you can edit the amount). When a customer returns damaged goods, their debt changes only if an employee records a credit. *Recommendation: as described.*

**Decision 7 — Words.**
The glossary (specification section 1.6) lists every word the screens will use in Kurdish, Arabic and English. Two things matter most: a *sale to a customer* is always "order / طلب بيع / فرۆشتن" and *buying from a company* is always "purchase / شراء / کڕین"; and where two words are common (زبون or عميل, فرۆشتن or ئۆردەر, کەرەستە or کاڵا), you choose. *Please tick each row or write the word you use.*

**Decision 8 — Optional extras.**
You did not ask for these; we recommend the first six strongly and can drop any of them:

| Extra | Why we recommend it | Keep? |
|---|---|---|
| Order receipt to print or send on WhatsApp | A credit sale is handed over with a signed وصل | ☐ |
| Payment slips (سند قبض / سند صرف) with numbers | Every cash movement gets a slip | ☐ |
| Account statement (كشف حساب) per customer or company | How debts are chased | ☐ |
| Discount / "round the total down" on an order | Rounding 801,250 to 800,000 is daily practice | ☐ |
| Daily cash count per employee, per currency | "How much dinar and dollar should Rebaz hand me tonight?" | ☐ |
| Period lock | Stops old months being changed after you have read the reports | ☐ |
| Home page with today's numbers | A useful first screen | ☐ |
| Search box for materials, customers, companies | Faster on phones | ☐ |
| Export reports and history to Excel/PDF | For your accountant | ☐ |
| Import your existing lists from Excel at go-live | Faster start | ☐ |
| Material code and "low stock" badge | Convenience | ☐ |
| Customer credit limit warning | Warns before a customer's debt grows too far | ☐ |
| Payment method (cash / transfer) and one payment split in dinars + dollars | If you receive transfers or mixed payments | ☐ |
| Add-to-home-screen shortcut | Opens faster on the floor | ☐ |

## 4. Defaults we will use unless you tell us otherwise

A new device starts in Kurdish Sorani. The week starts on Saturday; dates look like 18/09/2026; digits are Western (0–9) with Eastern digits available as a setting. Language, look and text size are saved on each device, not on the account, so a shared tablet keeps the last setting (the lock screen remembers each person's language). Two looks: light and dark. Sign-in is by username (or phone number) and password; there is no e-mail anywhere; the admin creates accounts and resets passwords; only admins manage users. Every company has one settlement currency (dinar or dollar) and its own rate; customers settle in dinars at one general rate the admin keeps up to date. An order or purchase can be corrected while it is unpaid and its month is not locked; otherwise it is cancelled with a reason and re-entered, and both actions stay in history. Nothing is ever deleted. The system needs an internet connection but protects half-typed forms and never saves the same order twice if the connection drops. On a shared tablet the screen locks after five minutes; a six-digit PIN unlocks it.

## 5. What we need from you before we start

The person who will decide the eight points above and attend the 30-minute materials session; the names of two admins; a native Kurdish and a native Arabic speaker to tick the glossary; the phones and tablets you actually use (make, model, browser); rough numbers (orders and purchases per day, number of materials, customers, companies, employees); your opening figures at go-live (stock per material, each customer's debt, each company's debt, this month's prices, today's rate); and where you want the encrypted backup copies kept.

## 6. What happens next

You return this summary with the eight decisions and the ticked extras. We hold the materials session. We build step 0 and show it to you on a phone; you approve the look. Each following step ends with a demonstration on your own devices, and your feedback goes straight into the next step.

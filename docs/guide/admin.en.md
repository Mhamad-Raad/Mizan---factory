# Mizan — administrator's guide

For the person who holds the admin account. Everything here is a screen in Mizan; nothing needs
a developer, a database tool or a terminal. Where a rule exists because the system refuses to
break it, the rule is stated plainly — those refusals are the point of the system, not defects.

The guide is in three parts: **the first week** (what to set up, in order), **every day** (the
handful of things an admin does), and **when something is wrong**.

---

## Part 1 — the first week

### 1. Sign in and change the password

The system is handed over with one admin account. At the first sign-in it asks for a new
password before anything else, and it will keep asking until the password is changed. Use a
password nobody else knows: the admin can see every price, every balance and every employee's
actions.

### 2. Settings → System: the rules of the house

Open **Settings** and scroll to **System**. These are the settings that apply to everybody:

| Setting | What it decides | Suggested |
|---|---|---|
| **New rate (IQD per $1)** | Today's dollar, used for every amount typed today | set it every morning |
| **Warn when a new rate differs by (%)** | A typing slip of 13,050 instead of 1,305 is caught here | 5 |
| **Days before the rate is called stale** | After this, the order form asks whether the rate is still today's | 3 |
| **Default customer currency** | The settlement currency a new customer gets | Iraqi dinar |
| **Allow selling below stock** | On: the line warns. Off: the save is refused | on for the first month |
| **Settlement tolerance** | Small change that is allowed to be left on a settled order | 250 IQD / 25 ¢ |
| **Days an order stays editable** | Empty means "until the period is locked" | empty |
| **Allow editing after a payment** | Off means an order with a payment is voided and re-entered | off |
| **Week starts on** | Reports and the day grouping | Saturday |
| **Shortest PIN, shared tablet / own phone** | Everybody holds a shared tablet, so its PINs are longer | 6 and 4 |
| **PIN sign-in on shared tablets** | Off means the lock screen offers passwords only | on |
| **Lock a shared / personal device after (minutes)** | Idle time before the screen locks | 5 and 30 |

Every change here is written to History with the old and new value and your name.

### 3. The exchange rate

Mizan stores every amount **twice** — in dinars and in cents — with the rate that made it. That
is why a rate is asked for and never guessed, and why an old amount never changes when the rate
moves: last month's purchase is still what it cost last month.

- **The global rate** (Settings → System) is today's dollar for customer amounts.
- **A company rate** lives on that company's profile ("Set the company’s rate"), because a supplier's
  dollar is their own and rarely the market's. A purchase from that company uses their rate.
- The order form asks about a rate that has not moved for a few days. Answer it; it takes a tap.

### 4. Materials and their first price

A material is either **per kg** or **per piece**, and that choice is made once, at creation.
Each material carries a **monthly price list**: a bought price and a sale price per month
(Material → Prices). An order line takes its price from the month of the order, so changing this
month's price never rewrites last month's orders.

**Before go-live, every material needs a price for the current month.** The Stock report shows
what is missing, and the Margin report excludes any line without a bought price and says how
many it excluded.

### 5. Opening stock, opening debts, opening balances

Go-live is the day the paper stops. Three things come across from the paper:

1. **Opening stock** — Material → "Opening stock": the count or the weight actually in the yard,
   with a note saying who counted it and when.
2. **What customers owe you** — Customer → "Record the opening balance", in that customer's settlement
   currency, with a note naming the paper it came from.
3. **What you owe suppliers** — Company → "Record the opening balance", the same way.

Each of these is a **ledger entry**, not a number in a box: it shows in the account's history
with your name on it, and the balance is the sum of the entries. If a figure was wrong, add a
correcting entry — never try to edit the old one, because the system will not allow it.

**Reconcile before you start selling.** Open **Reports → Receivables** and compare its total with
your own list of customer debts; **Reports → Payables** against your supplier debts; the **Stock**
report against the count sheets. When the three agree, go live.

### 6. If the lists are long: import from a file

**Settings → Import from a file** (admin only) takes a CSV per kind: materials, customers,
companies, opening stock, customer opening debts, company opening debts. Download the template
for the kind you want, fill it in a spreadsheet, and use **Check the file** first: it reads the
file on your own device and names the row and column of every problem — a duplicate name, a
material it does not know, a date in the future, a figure that is not a number — before anything
is written. Then **Import**.

An import creates exactly what the forms create: the same ledger entries, the same rate, the
same History rows, all attributed to you. The good rows are imported and the bad ones reported,
so a corrected file can simply be imported again — a name that already exists is reported, not
created twice.

### 7. Employees

**Users → New employee.** Give a name, a username and a phone; the system generates the first
password and asks the employee to change it at their first sign-in.

Then choose a **preset** — *Sales*, *Warehouse* or *Accountant* — and adjust it with the six
everyday extras:

| Extra | What it adds |
|---|---|
| Can void | Voiding an order, a purchase or a damage record |
| Sees bought prices | The bought price and anything derived from it |
| Sees all customers | Not only the customers assigned to them |
| Sees balances | What customers owe and what we owe suppliers |
| Can adjust what we owe | Adjustments and credit notes on a supplier account |
| Can set rates | The company rate and the global rate |

A preset is a **starting point, not a role**: the editor shows "differs from preset" once you
change anything, and a permission change takes effect on the employee's very next tap — they do
not need to sign out. The **Advanced** grid, folded away under the presets, holds every single
key for the rare person the presets do not fit.

Two things the system will not let you do, on purpose: change your own role, and deactivate your
own account.

### 8. Shared tablets and PINs

A tablet on the floor is marked **Shared device** in its own Settings (the setting belongs to the
device, not to the account). A shared device locks after a short idle time, and its employees
unlock with a **PIN** instead of typing a password in front of everybody.

- The employee sets their own PIN in **Settings → My account**. You never see it.
- A PIN works only on devices the employee has already signed in on with their password, and
  only for seven days before the password is needed again.
- **Users → an employee → Sessions** shows where they are signed in and which devices may use
  their PIN. You can end one session, or revoke PIN sign-in everywhere with one button.
- Wrong PINs lock the pad and fall back to the password; the attempts are in History.

### 9. Period lock

**Settings → System → Period locked through.** Nothing dated on or before that date can be
written or changed — not an order, not a payment, not a correction, not a reversal. Set it after
the month's figures are agreed, and the paper for that month can never move again.

### 10. Backups and the restore drill

Backups are the operations team's job and they are described in `ops/runbook/README.md`: a
nightly encrypted dump, continuous WAL archiving, and a retention of thirty dailies plus twelve
monthlies. What matters to you as the admin:

- **A backup nobody has restored is not a backup.** A restore drill is run and logged in
  `ops/runbook/restore-drills.md` — the log records the copy, the time it took to restore, and the
  integrity checks that passed (every balance equal to the sum of its ledger, every stock figure
  equal to the sum of its movements).
- Ask for a drill every quarter and read the log. If nobody can show you one, the backups are a
  hope, not a plan.

---

## Part 2 — every day

**Morning.** Set today's rate (Settings → System). If a supplier's rate has changed, set it on
their profile.

**During the day.** Nothing. The employees work; you do not need to be in the system.

**End of the day.** Two screens are worth a minute each:

- **Reports → Daily cash-up** — what each employee should hand over, per currency.
- **Dashboard** — today's sales, unpaid orders, what we owe suppliers, low stock, pending returns.

**End of the month.** Reports → Sales, Purchases, Margin, Receivables, Payables. When the figures
are agreed, move **Period locked through** to the last day of the month.

**Whenever a figure looks wrong.** Open **History**. Every write in the system is there: who,
when, what changed from what to what, and the note they typed. Filter by employee, by record, by
day. A record's own screen has the same story under its **History** tab.

---

## Part 3 — when something is wrong

### "This figure is wrong"

Money and stock are never edited in place. A wrong entry is corrected by a **reversal**: the
original stays, the reversal is written beside it, and the balance is the sum of both. This is
why History always explains a balance, and why nobody — including you, including a developer —
can quietly change a number after the fact.

- An **order** inside the edit window can be edited; outside it, or once it has a payment (with
  the setting off), it is **voided** and re-entered. The void asks for a reason and appears in
  History.
- A **payment** is corrected by a reversing entry on the account, with a note.
- **Stock** is corrected by a stock movement — a damage record, a return, or **Correct the
  stock** on the material — never by typing a new number.

### "An employee cannot see something they need"

Open their **Permissions** tab. If the missing thing is a *field* — a bought price, a balance, a
profit figure — it is one of the extras or a `fields.*` key in the Advanced grid. The change is
live on their next tap.

### "Somebody left the company"

**Users → the employee → Deactivate.** Their sessions end immediately and their PIN stops
working. Nothing they ever did is deleted; History keeps their name on it, which is the point.

### "The tablet says it is offline"

Reading keeps working from what the device already has, with an offline marker; writing waits.
When the connection comes back, try the save again. Nothing is silently lost — a write that did
not happen says so.

### "The screen is in the wrong language"

Language, theme, font size and numerals are **per device** (Settings → This device), so the
tablet on the floor can be in Kurdish while the office laptop is in English, and nobody's choice
disturbs anybody else's.

### Who to call

The support channel agreed at handover. Have ready: what you were doing, the screen you were on,
the exact words of the message, and the time. With the time and the employee's name, History and
the server log can reconstruct exactly what happened.

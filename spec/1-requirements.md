> Extracted from `spec/mizan-factory-system-spec-v1.2.md` (Deliverable 1). Section numbers are unchanged, so cross-references to other deliverables resolve in the full document or in the sibling files of this folder.

# Deliverable 1 — Requirements specification

## 1.1 The business in one paragraph (validated reading)

The factory buys materials from **supplier companies** through **purchases**. A purchase adds the bought quantities (count and/or kilograms) to **stock** and, when a company is named, adds what the factory **owes** that company, valued at that company's own IQD⇄USD rate. The factory sells materials to **customers** through **orders**. An order removes the sold quantities from stock and, when the order is **borrowed** (on credit) rather than **cash**, adds what the customer owes the factory. Purchases and orders are mirror images: a header (counterparty, date, acting employee, notes, rate snapshot) and lines (item, count, kg, unit price, line total). Every material has a **monthly price list** — one bought price and one sale price per calendar month, each in IQD and USD. Goods get **damaged**; each damage record can optionally blame a customer order, the factory itself ("us"), or the supplier company the goods came from, and can be flagged as **returnable** with a return status. Every action is attributed to the employee who performed it, and the admin can view **history** and **reports** filtered by employee and by date. Supplier accounting is per company: what was paid, what is owed per purchase and per item, with a running balance; every manual change to an owed amount carries a note and stays in history forever. Admins **manage users** and decide exactly what each employee can see and do. The interface supports **two themes**, an adjustable **font size** and **three languages**, and those preferences are saved in the browser of each device.

**Terminology decision.** The client uses "order" for both sales to customers and purchases from companies. In this document and in every language of the product, **Order** always means a sale to a customer and **Purchase** always means buying from a supplier company (glossary, section 1.6). Where the client's raw text says "order" in the supplier context (R-25: "how much we owe per order and items") it is read as *purchase*.

**Two refinements to the brief's reading, adopted here and flagged for the client:**

1. *Cash orders also pass through the customer ledger.* Every order creates a receivable entry for the customer; a cash order additionally creates an immediate "cash settlement" payment entry in the same transaction. This keeps one status rule for all orders (balance of the order's entries = 0 → paid), makes "payment type can be changed in the future" (R-14) a reversible ledger operation instead of a special case, and keeps a customer's payment history complete. It is invisible in the UI unless the user opens the ledger. (Assumption A-24, Q-12.)
2. *Damage attributed to a customer order does not move stock.* The goods were already removed from stock when sold; recording them as damaged tells the story without double-counting. Damage attributed to "us" or to a supplier purchase does reduce stock (Assumption A-30, Q-16).

## 1.2 Raw requirement register

Every line of the client's request, verbatim, with an identifier used in the FR "Source" column and in the traceability matrix. Lines from the brief's project context that constrain the product (devices, languages, currencies, no e-mail, and so on) are registered as `C-nn` so they are traced too.

### 1.2.1 Client lines (verbatim)

| ID | Client text (verbatim) | Covered by |
|---|---|---|
| R-01 | "Website." | FR-1301 |
| R-02 | "Admin, admin can control what the employees see and do." | FR-102, FR-103, FR-104, FR-105, FR-204 |
| R-03 | "And employee users meaning authorization." | FR-101, FR-102, FR-104 |
| R-04 | "Support all three languages (Kurdish Sorani, Arabic, English)" | FR-1104, FR-1201, FR-1202, FR-1203, FR-1204 |
| R-05 | "Page: a page to add material." | FR-401, FR-403, FR-307 |
| R-06 | "Items have: quantity, name, bought price and sale price," | FR-301, FR-303, FR-305, FR-1006 |
| R-07 | "date bought and date sold," | FR-304 |
| R-08 | "each months prices bought and sold are prices," | FR-305, FR-306, FR-408, FR-609, FR-1005, FR-1011 |
| R-09 | "prices in iqd and usd," | FR-305, FR-1302 |
| R-10 | "order has notes," | FR-601 |
| R-11 | "items have kgs in the order," | FR-402, FR-602 |
| R-12 | "total per item in the order" | FR-402, FR-602, FR-603 |
| R-13 | "Order has payment types. cash or borrowed." | FR-604, FR-612 |
| R-14 | "Payment type can be change in the future" | FR-605, FR-606, FR-607 |
| R-15 | "Customers have profiles." | FR-501, FR-503, FR-505 |
| R-16 | "Who assigns to who." | FR-205, FR-502, FR-711, FR-1306, FR-902 |
| R-17 | "Page for damaged items," | FR-801, FR-804, FR-807 |
| R-18 | "reason can be assigned to an order or us or the company came from but optional," | FR-802 |
| R-19 | "and show if it can be returned." | FR-803, FR-805, FR-806 |
| R-20 | "Order has notes" (repeated by the client) | FR-601 (same requirement as R-10) |
| R-21 | "History and reports page." | FR-901, FR-1001, FR-1003 to FR-1010 |
| R-22 | "Filter Reports and history page based on user and date." | FR-902, FR-1002 |
| R-23 | "Manage users from the admin." | FR-201, FR-202, FR-203, FR-206 |
| R-24 | "Page for creating other companies" | FR-701, FR-710 |
| R-25 | "what we paid how much we owe per order and items" | FR-704, FR-712 |
| R-26 | "like an accounting page in which you can change how much you owe" | FR-706 |
| R-27 | "of course that should have notes" | FR-706, FR-709 |
| R-28 | "and change the price includes history." | FR-703, FR-706, FR-709, FR-903, FR-904 |
| R-29 | "The date you paid, who made the payment," | FR-705 |
| R-30 | "in iqd and usd should be calculated by itself iqd converts to usd and usd to iqd," | FR-705, FR-1106, FR-1302 |
| R-31 | "the rate conversion is different per company which can be set from the companies profile page." | FR-703, FR-404 |
| R-32 | "Two themes." | FR-1101 |
| R-33 | "And being able to control systems font sizes from the settings," | FR-1102 |
| R-34 | "These preferences will be saved inside of the browser." | FR-1103 |

### 1.2.2 Project-context lines (from our brief)

| ID | Context requirement | Covered by |
|---|---|---|
| C-01 | Single factory, single tenant — no multi-company or multi-tenant design. | FR-1301, section 2.15 |
| C-02 | Materials are sold by weight and by count. | FR-302, FR-402, FR-602 |
| C-03 | Track money owed in both directions (customers → factory, factory → companies). | FR-503, FR-612, FR-704 |
| C-04 | Track who did what. | FR-1306, FR-901 |
| C-05 | Reuse the palette system's stack and patterns; separate application; clearly distinct visual identity. | FR-1311, NFR-12 |
| C-06 | Phones and tablets on the factory floor and desktops in the office; mobile-first; usable one-handed. | FR-1303, NFR-02 |
| C-07 | Shared tablets; poor connectivity on the floor. | FR-106, FR-1304, FR-1305, NFR-11 |
| C-08 | Many employees have no e-mail; admin creates and resets accounts. | FR-101, FR-108, FR-201, FR-202 |
| C-09 | Three first-class languages; RTL is the primary direction, LTR the mirror. | FR-1201, FR-1202, FR-1206, NFR-01 |
| C-10 | Iraq; Asia/Baghdad; Gregorian; week starts Saturday (confirm). | FR-1108, FR-1203 |
| C-11 | IQD and USD; every amount shown in both. | FR-1302, FR-305, FR-603, FR-705 |
| C-12 | Priorities: simplicity/UX, then money-stock-history correctness, then polished UI with purposeful animation; design quality is a functional requirement. | NFR-14, FR-1311 |

## 1.3 Functional requirements by module

Format of each requirement: identifier and title; **Source** (client line `R-nn`, context line `C-nn`, the brief's default interpretation `A-nn`, or **Proposed — not requested**); **Statement**; **Acceptance criteria** (testable). Permission keys named here are defined in section 1.5 and section 2.6.

### 1.3.1 Auth & Permissions

**FR-101 — Sign in with username and password, no e-mail**

Source: C-08, R-03, A-27.

Statement: A user signs in with a username (or their phone number, which is accepted as an alias of the username) and a password. No e-mail address is required anywhere in the system, and no e-mail is ever sent.

Acceptance criteria:

- The login screen has exactly two fields (username or phone, password) and one primary button, and works on a 360 px-wide phone in all three languages.
- A wrong username or password shows a single generic message ("Username or password is incorrect") without revealing which one was wrong.
- After 5 failed attempts for the same username within 15 minutes, further attempts are refused for 15 minutes and the admin sees the lockout in History; a successful login resets the counter.
- A user flagged "must change password" is taken to a change-password screen before anything else.
- A deactivated user cannot sign in and sees "This account is deactivated — contact your admin".

**FR-102 — Two roles: admin and employee**

Source: R-02, R-03.

Statement: Every user is either an *admin* or an *employee*. Admins can do everything, including managing users and permissions. Employees can do only what their permission set allows.

Acceptance criteria:

- The role is set when the account is created and can be changed by an admin (logged in History with old → new).
- An admin implicitly holds every permission in the catalog; no permission row needs to be stored for admins.
- An employee with no permissions can sign in and sees only the Settings page and the lock screen; every other navigation item is hidden and every other endpoint returns 403.

**FR-103 — Per-employee permissions at page, action and field level**

Source: R-02.

Statement: For each employee the admin can grant, individually, (a) which pages they can see, (b) which actions they can perform on each page, and (c) which sensitive fields they can see (bought prices, profit, company balances, customer balances).

Acceptance criteria:

- The permission catalog in section 1.5 is the complete list; each key is either granted or not for a given employee.
- Granting an action implies granting the "view" permission of the same page (the editor enforces this and shows it).
- Field-level flags hide the values everywhere they would appear: lists, detail pages, forms, reports, search results and exports; the API omits the fields, it does not merely blank them in the UI.
- A change to an employee's permissions takes effect at their next request (no re-login required) and is recorded in History as old set → new set with the acting admin.

**FR-104 — The backend enforces permissions; the frontend only hides**

Source: R-02, R-03.

Statement: Every API endpoint checks the caller's role and permissions. The frontend derives its navigation, buttons and visible fields from the same permission set, but hiding is a courtesy, never the control.

Acceptance criteria:

- Calling any endpoint without the required permission returns HTTP 403 with the error code `PERMISSION_DENIED` and the name of the missing permission.
- There is an automated test for every endpoint that asserts the 403 for a user without the permission and success for a user with it (section 2.12).
- Navigation items, primary buttons and row actions are absent (not disabled) when the user lacks the permission.

**FR-105 — Permission presets**

Source: R-02 (brief, section "Roles and a permission catalog": presets an admin can start from).

Statement: When creating or editing an employee, the admin can apply a preset (Sales, Warehouse, Accountant) and then adjust individual permissions.

Acceptance criteria:

- Applying a preset replaces the current permission set with the preset's set and shows a diff before saving.
- After applying a preset, any individual key can be toggled; the user record shows "Preset: Sales (customised)" when it no longer matches the preset exactly.
- Presets are defined in code (section 1.5.3) and versioned; changing a preset later does not retroactively change existing users.

**FR-106 — Idle auto-lock, quick unlock and fast user switching on shared devices**

Source: C-07 (brief: "short idle auto-lock with quick re-login and fast user switching for shared tablets").

Statement: After a short idle period the app locks the screen. The same user can unlock quickly with a personal 4–6 digit PIN (or their password); a different employee can take over the device from the lock screen without the first user signing out manually.

Acceptance criteria:

- Default idle timeout is 5 minutes on devices marked "shared" and 30 minutes otherwise; both are admin settings (system settings, section 1.3.11). The device "shared" flag is a per-browser preference set from Settings. On a shared device a session lives at most 12 hours and expires 4 hours after locking; on a personal phone a session lives up to 30 days and can be unlocked with PIN or password at any time within that, so employees are not asked for their password every morning.
- The lock screen shows the current user's name and the last three users who signed in on this browser; tapping a user asks for that user's PIN (when they have one and signed in with their password on this browser within 7 days) or otherwise their password.
- Unlocking with the PIN keeps the same session; signing in as another user ends the previous user's session on that device and starts a new one. Any unsaved form is discarded with the previous session, and the app warns before locking if a form has unsaved changes (it counts down 30 seconds, then locks).
- While locked, every API call from that session is refused (HTTP 423) until unlocked.
- A PIN is optional, set by the user in Settings and stored hashed together with its length; the minimum is 4 digits, and a PIN shorter than 6 digits is refused on a shared device with a "set a longer PIN" prompt (password fallback) — both minimums are settings. It unlocks the user's own session, and — only on a browser where that user signed in with their password during the last 7 days, and only when the admin has left "PIN switching on shared devices" enabled — it also signs them in from the lock screen's recent-users list (device-bound quick sign-in, section 2.8). A PIN never works on a browser where the user has not recently signed in with a password, and never replaces the password on the Login page.
- Every session records how it was authenticated (password or PIN quick sign-in) and every History entry written from it carries that method, so a disputed payment recorded from a shared tablet can be traced to the sign-in method.

**FR-107 — Admin safety rules**

Source: A-27 (brief default 13).

Statement: An admin cannot remove their own admin role or deactivate themselves, and the system always keeps at least one active admin.

Acceptance criteria:

- The role selector and the "Deactivate" action are disabled with an explanatory tooltip on the admin's own user record.
- The API refuses (HTTP 409, `LAST_ADMIN`) any change that would leave zero active admins, including deactivating or demoting the last other admin.
- Both rules are covered by automated tests.

**FR-108 — Password rules and admin-managed resets**

Source: C-08, A-27.

Statement: Passwords are set by the admin at account creation and on reset, and by the user when changing their own password. There is no self-service "forgot password"; the admin resets it in person.

Acceptance criteria:

- Minimum length 8 characters; no composition rules; the 1,000 most common passwords and the username itself are rejected; passwords are stored with a modern slow hash (section 2.13).
- An admin reset generates or accepts a temporary password, shows it once on screen (with a "copy" action) and flags the account "must change password".
- Password changes and resets are recorded in History (who, when) without the password itself.

### 1.3.2 Users

**FR-201 — Admin creates user accounts**

Source: R-23, C-08.

Statement: The admin creates a user with a display name, a username, an optional phone number, a role, a temporary password and, for employees, an optional preset.

Acceptance criteria:

- Username is unique (case-insensitive), 3–32 characters, letters/digits/underscore/dot; the display name is free text in any script.
- Phone number, when present, is unique and can be used to sign in.
- On save, the temporary password is shown once, and the user record appears in the list immediately.
- Creation is logged in History.

**FR-202 — Admin edits users and resets passwords**

Source: R-23, C-08.

Statement: The admin can edit display name, username, phone, role and preset, and reset the password of any user (except the rules in FR-107).

Acceptance criteria:

- Each edit is logged in History as old → new per field.
- A password reset immediately invalidates the user's active sessions and forces a password change at next sign-in.

**FR-203 — Deactivate and reactivate; never delete**

Source: R-23 (brief: employees are deactivated, never deleted).

Statement: Users are deactivated rather than deleted, so every historical record keeps its author.

Acceptance criteria:

- Deactivation ends all of the user's sessions within one minute and blocks sign-in.
- Deactivated users remain visible in History, reports, "acting employee" fields and assignment history, marked "(deactivated)".
- Reactivation restores the account with its previous permissions; both actions are logged.
- There is no delete action for users anywhere in the UI or the API.

**FR-204 — Permissions editor per employee**

Source: R-02.

Statement: On an employee's record the admin edits the permission set. The default editor is deliberately simple — a preset plus six everyday extras (can void, sees bought prices, sees all customers, sees balances, can adjust what we owe, can set exchange rates); the full page × action grid with field-level flags is one tap away under "Advanced", on a phone as well as on a desktop.

Acceptance criteria:

- Simple mode shows the preset selector and the six extra toggles (on, off, or "partly" when only some of the group's keys are granted); Advanced mode shows every page as a collapsible group with its actions as toggles and a "view" master toggle, with field flags as a separate group. Both modes edit the same permission set (an extra toggle maps to a fixed list of keys, sections 1.5.3 and 2.6.5).
- Turning off "view" for a page turns off that page's actions; turning on any action turns on "view".
- Changes are saved explicitly (Save button) with a summary of what changed, and are logged as old set → new set.
- The editor is usable one-handed on a 360 px-wide phone (wireframe in section 3.4.4).

**FR-205 — Assign customers (and optionally companies) to employees**

Source: R-16 (A-15, reading (a) of "who assigns to who").

Statement: The admin (or a user with `customers.assign` / `companies.assign`) assigns each customer, and optionally each company, to one responsible employee.

Acceptance criteria:

- The assignment is a single field ("Assigned to") on the customer and company profiles; it can be empty.
- Assignment changes are logged in History as old employee → new employee with the acting user and an optional note.
- Filters "assigned employee" on Customers, Orders, Companies, History and Reports use this field; the "acting employee" filter (FR-1306) is offered alongside it and is never confused with it in labels (glossary: "assigned to" vs "done by").
- An employee whose `customers.view_all` permission is off sees only customers assigned to them (and their orders); see section 2.6.4 for the exact scope rule.

**FR-206 — User list**

Source: R-23.

Statement: The admin sees a searchable list of users with role, status (active/deactivated), preset, last sign-in and assigned customer count.

Acceptance criteria:

- Search matches display name, username and phone with script normalisation (FR-1205).
- Deactivated users are hidden by default behind a filter toggle.
- Tapping a row opens the user record with tabs: Details, Permissions, Activity (that user's History entries).

### 1.3.3 Materials & Stock

**FR-301 — Material (item) record**

Source: R-06.

Statement: A material has a name, a pricing unit (FR-302), optional notes and an active flag; its quantity in stock (FR-303), first-bought and last-sold dates (FR-304) and monthly prices (FR-305) are attached to it.

Acceptance criteria:

- Name is required, unique among active materials (compared after script normalisation, FR-1205), free text in any script.
- Optional short code/SKU: **Proposed — not requested** (FR-310).
- Creating and editing a material requires `materials.create` / `materials.edit`; every edit is logged as old → new.
- The material list shows name, stock in the priced measure (and the other measure when every movement carried it), this month's sale price (both currencies) and, for users with `fields.see_bought_price`, this month's bought price.

**FR-302 — Pricing unit per material (per kg or per piece)**

Source: C-02, A-16 (brief default 2).

Statement: Each material declares whether it is priced per kilogram or per piece. Order and purchase lines always allow both count and kg; the line total is unit price × the measure that matches the pricing unit; the other measure is informational and optional.

Acceptance criteria:

- Pricing unit is required on creation and shown on every line and price field ("per kg" / "per piece").
- Changing the pricing unit of a material that already has movements is allowed only by an admin, is logged, and does not recompute existing lines (they keep their snapshot of the priced measure).
- On a line, the measure that drives the price is required; the other measure is optional and clearly labelled "for information".

**FR-303 — Quantity in stock, derived from movements**

Source: R-06, C-02.

Statement: Stock per material is the sum of its stock movements in the material's priced measure. The other measure is summed only while every movement of that material carried it; otherwise it is shown as "—" (a partial sum would be wrong). Stock is never edited directly; corrections are movements with a note.

Acceptance criteria:

- The material detail page shows current stock in the priced measure (and the other measure when complete) and the movement list (type, date, quantity, reference, employee, note).
- Stock can go below zero only with an explicit warning on the line ("Stock is 12, you are selling 15"); an admin setting can block negative stock instead (default: warn and allow — Q-15).
- A stock correction is a movement of type "adjustment" with a mandatory note and `materials.opening_stock` permission (the same permission covers opening stock and corrections).

**FR-304 — Date first bought and date last sold (derived)**

Source: R-07, A-22 (brief default 8).

Statement: Each material shows the date it was first bought (earliest purchase line or opening-stock date) and the date it was last sold (latest active order line). Both are derived; neither is typed by hand.

Acceptance criteria:

- Both dates appear on the material card and detail page and update automatically when purchases and orders are created, edited or voided.
- Voided orders and purchases are excluded from the derivation.
- A material never bought shows "—" for date bought; a material never sold shows "—" for date sold.

**FR-305 — Monthly price list in both currencies**

Source: R-06, R-08, R-09, C-11, A-17 (brief default 3).

Statement: For each material and each calendar month there is one bought price and one sale price, each stored in IQD and USD. The user enters each price in one currency; the other is calculated at the global default rate and can be overridden.

Acceptance criteria:

- The material detail page has a "Prices by month" section listing months in reverse order with bought and sale prices in both currencies; the current month is highlighted.
- Setting or changing a month's prices requires `materials.set_prices`; the entered currency, the calculated currency, the rate used and the acting user are stored; every change is logged as old → new with an optional note.
- Bought prices are hidden entirely from users without `fields.see_bought_price`.
- Prices for past months can be edited (with a warning that existing lines and their cost snapshots keep their values; only new lines and the reports that read the month price directly — stock value and damage value — change).
- A bulk "copy last month's prices to this month" action exists for the start of the month (all materials or a selection) and is logged per material.

**FR-306 — Price fallback and warning when a month has no price**

Source: R-08, A-17 (brief default 3).

Statement: If the current month has no price for a material, new lines silently carry forward the most recent earlier month's price with a small "from July" marker on the line — not a warning, because on a floor with thousands of materials a warning on every line is noise; only when no price exists at all is the price field empty and must be typed, and only then does the document show a warning.

Acceptance criteria:

- The marker names the month the price came from ("from July") and, for users with `materials.set_prices`, links to "Set this month's prices"; a month-start banner on the Materials page ("September prices not set for 120 materials — copy August?") is **Proposed — not requested**.
- The go-live checklist requires a first price for every material so that no first order opens with empty price fields (section 4.8).
- Reports flag values computed from a fallback month (section 2.11).

**FR-307 — Materials list and material detail page**

Source: R-05, R-06.

Statement: The Materials page lists materials with search and filters; a material's detail page shows stock, dates, monthly prices, recent movements, and links to its purchases, orders and damage records.

Acceptance criteria:

- List supports search by name (script-normalised), filter by pricing unit and "in stock / out of stock / inactive", sorted by name by default.
- Detail page tabs: Overview (stock, dates, this month's prices), Prices by month, Movements, History (audit entries for this material).
- Both pages are fully usable on a phone (section 3.3).

**FR-308 — Opening stock**

Source: A-26 (brief default 12: opening balances at go-live).

Statement: At go-live (and later for corrections) a user with `materials.opening_stock` records the opening quantity of a material as a dated stock movement with a note.

Acceptance criteria:

- Opening stock is entered from the material detail page ("Record opening stock"): date, count and/or kg, optional value per unit in both currencies (for stock valuation), note (required).
- It appears in the movement list as "Opening stock" and in History; it never creates a company debt.
- A CSV import of opening stock is **Proposed — not requested** (FR-1312).

**FR-309 — Deactivate a material**

Source: A-32 (brief default 18: soft delete).

Statement: Materials are deactivated, not deleted; a deactivated material cannot be added to new lines but remains in history, reports and old documents.

Acceptance criteria:

- Deactivation requires `materials.edit`, is logged, and is reversible.
- Deactivated materials are hidden from pickers and from the default list, and shown with an "Inactive" badge when filtered in.
- Deletion (admin-only, only for a material with no movements, no lines and no prices) sets `deleted_at` and hides the material everywhere, including from the "inactive" filter; rows are never physically removed; the action is logged with a snapshot of the record.

**FR-310 — Material code and low-stock indicator — Proposed — not requested**

Source: Proposed — not requested.

Statement: An optional short code per material (for quick search and printed documents) and an optional minimum-stock threshold that shows a "Low" badge in the list.

Acceptance criteria:

- Both fields are optional and hidden when empty; no behaviour depends on them except the badge and search.
- Can be removed without affecting any other requirement.

### 1.3.4 Purchases (the "add material" page)

**FR-401 — "Add material" creates a purchase**

Source: R-05, A-19 (brief default 5).

Statement: The page the client calls "add material" creates a purchase with an optional supplier company, a date (default today), the acting employee (the signed-in user), notes, a rate snapshot and one or more lines.

Acceptance criteria:

- Entry point "Add material" is visible in Materials and in the global "+" action for users with `purchases.create`; the created record is titled "Purchase #n".
- Company is optional; when empty the purchase creates no debt and is labelled "No company (stock only)".
- The date cannot be in the future; back-dating is allowed and logged.
- Notes are free text (up to 2,000 characters) and are searchable in the purchase list.
- "Rate for this purchase" (under More) defaults to the company's rate (or the global rate without a company) and can be typed per deal; changing it recomputes the calculated currency of every line that was not overridden, tells the user, and is logged (section 2.3.3).
- Saving on a phone with three lines takes under a minute for a trained employee (section 3.5.2 flow).

**FR-402 — Purchase lines: item, count, kg, bought price, line total**

Source: R-06, R-11, R-12, C-02.

Statement: Each line names a material, the count and/or kg (per FR-302), the bought unit price in IQD and USD, and shows the line total in both currencies.

Acceptance criteria:

- The unit price is entered in one currency; the other is calculated at the purchase's rate (company rate if a company is set, otherwise global default) and may be overridden; entered/calculated flags and the rate are stored per line.
- Line total in the entered currency = unit price × priced measure, rounded; the line total in the other currency is that amount converted at the purchase rate — not the rounded other unit price × quantity, which drifts on large quantities (section 2.3.4). When both unit prices are typed, each total is its own product. Totals in both currencies are visible at all times while editing (sticky footer on phones).
- A line's price defaults to the material's monthly bought price (FR-408) and any override is logged as "price overridden (month price → entered price)".
- The same material may appear on two lines (for example two price tiers); a warning, not a block, is shown.

**FR-403 — A purchase increases stock**

Source: R-05, R-06.

Statement: Saving a purchase creates one stock movement of type "purchase in" per line, with the line's count and kg.

Acceptance criteria:

- Stock on the material updates in the same transaction as the purchase; a failed save leaves no partial movements.
- The movement references the purchase line; the material's movement list links back to the purchase.

**FR-404 — A purchase with a company increases what we owe that company**

Source: R-25, R-31.

Statement: Saving a purchase that names a company creates one company-ledger entry carrying the purchase totals in both currencies exactly as stored on the purchase (sums of the line totals, whose calculated side was computed at the purchase's document rate — the company's rate unless a rate was typed for this purchase), together with that rate.

Acceptance criteria:

- The company's balance (section 1.3.7) increases by the purchase total in the settlement currency immediately; the entry shows date, purchase number, employee, both amounts (copied from the purchase totals, never re-converted) and the rate snapshot.
- If the company's rate changes later, the stored entry never changes.
- A purchase without a company writes no ledger entry.

**FR-405 — Edit and void a purchase with compensating movements**

Source: A-25 (brief default 11).

Statement: A purchase can be edited by its creator or an admin (or a user with `purchases.edit`) while no payment has been linked to it and its date is not in a locked period (FR-1109); an admin may additionally restrict edits to a number of days after the purchase date (setting, off by default). Outside those rules it is voided with a mandatory reason and re-entered. The creator may also undo a purchase within 8 seconds of saving it (toast action); the undo is a void with reason "undo", fully logged, and needs no `purchases.void` key.

Acceptance criteria:

- Editing writes reversal stock movements and a reversal ledger entry for the old version, then new movements and a new ledger entry for the new version, all in one transaction, and logs a field-by-field diff.
- Voiding requires `purchases.void` and a reason; it reverses all live movements and ledger entries, marks the purchase "Void" (kept in lists with a badge, excluded from totals) and logs who/when/why.
- A voided purchase cannot be edited or un-voided; the UI offers "Duplicate as new purchase" instead.
- Attempting to edit outside the allowed window shows why and offers "Void and re-enter".

**FR-406 — Purchase list and detail**

Source: R-24, R-25.

Statement: The Purchases list (a tab within Materials and within a company's profile) shows purchases with filters by company, date range, acting employee and status; the detail page shows header, lines, totals in both currencies, the linked ledger entry and history.

Acceptance criteria:

- Default sort is date descending; pagination 25 per page on phones (infinite scroll) and 50 on desktop.
- Users without `fields.see_bought_price` cannot open purchase prices or totals; the list still shows dates, companies and quantities (Q-08 asks whether such users should see purchases at all).

**FR-407 — Purchase with no company creates no debt**

Source: A-19 (brief default 5).

Statement: See FR-401; recorded separately so that it is traceable.

Acceptance criteria:

- Automated test: a purchase without a company creates stock movements and zero ledger entries.

**FR-408 — Purchase line price defaults to the monthly bought price**

Source: R-08, A-17.

Statement: A new purchase line defaults its unit price to the material's bought price for the purchase's month (with the FR-306 fallback), taken in the currency that price was entered in; the other currency of the line is calculated at the purchase's rate snapshot (the company's rate when a company is set). The price can be overridden per line; overrides are logged.

Acceptance criteria:

- Changing the purchase date re-evaluates the default month for lines that were not overridden and tells the user.
- The line records whether its price came from the month price or was typed.

### 1.3.5 Customers

**FR-501 — Customer profile**

Source: R-15.

Statement: A customer has a name, phone, address, notes, a settlement currency (default IQD), an assigned employee (FR-502) and an active flag.

Acceptance criteria:

- Name is required; phone and address optional; duplicate names are allowed but the form warns when a script-normalised match exists ("A customer named … already exists — open it?").
- A customer created by a user who lacks `customers.view_all` is automatically assigned to that user (so they can see and use it immediately); users with `customers.assign` may choose another assignee at creation.
- The duplicate check runs across **all** customers regardless of the user's scope; when the match is a customer assigned to someone else, the warning says "A customer named … already exists and is assigned to Rebaz — ask your admin to assign it to you" instead of offering to open it, so the directory does not fragment into duplicates.
- **Proposed — not requested** (FR-616): an optional credit limit per customer; a borrowed order that would push the balance above it shows a warning (never a block).
- Creating and editing require `customers.create` / `customers.edit`; every edit is logged old → new.
- The profile page has tabs: Overview (balance, contact, assigned employee), Orders, Payments & ledger, History.
- **Proposed — not requested:** a system customer "Walk-in customer" exists for cash sales to unnamed buyers; it cannot be deactivated or assigned, and borrowed orders cannot be recorded against it (A-33, Q-12). If cut, every order names a real customer.

**FR-502 — Assigned employee on the customer**

Source: R-16 (A-15).

Statement: Each customer can be assigned to one employee; the assignment is shown on the profile and used for filtering and scoping.

Acceptance criteria:

- Set by users with `customers.assign`; changes logged old → new; an optional note can be attached.
- The Customers list can be filtered by assigned employee and shows the assignee's name on each row.

**FR-503 — Customer order history, outstanding balance and payment history**

Source: R-15, C-03.

Statement: The customer profile shows all orders, all payments and credits, and the outstanding balance as the sum of the customer's ledger entries.

Acceptance criteria:

- Balance is shown in the customer's settlement currency with the other currency "≈" at the current global default rate, and is hidden from users without `fields.see_customer_balances`.
- The ledger tab lists entries newest first in posting order: date, type (order, payment, cash settlement, credit, refund, adjustment, opening balance, settlement change, reversal), amount in both currencies, rate, employee, note, and the running balance after each entry (posting order, matching History's before → after; sorting by business date shows the balance as of that date instead). Edited documents, undone entries and cash-order pairs are collapsed per the presentation rules in section 2.4.5.
- The customer's settlement currency can be changed by an admin with a note; the change always writes a re-basing entry (at an agreed rate when the balance is not zero, section 2.3.5), never a silently different balance.
- Unpaid and partially paid orders are listed first in the Orders tab with their remaining amount.

**FR-504 — Opening customer debt**

Source: A-26 (brief default 12).

Statement: At go-live a user with `customers.opening_balance` records the amount a customer already owes (or is owed) as a dated ledger entry with a note.

Acceptance criteria:

- Entered from the customer profile ("Record opening balance"): date, amount in one currency (the other calculated at the global default rate, overridable), note (required).
- Appears in the ledger as "Opening balance"; can only be corrected by a reversal entry plus a new entry, never edited in place.

**FR-505 — Customer list with script-normalised search**

Source: R-15, C-09.

Statement: The Customers page lists customers with search by name and phone and filters by assigned employee, balance state (owes us / settled / credit) and active state.

Acceptance criteria:

- A customer typed on an Arabic keyboard is found when searched from a Kurdish keyboard and vice versa (FR-1205); phone search ignores spaces and leading zeros/country code.
- Each row shows name, phone, assigned employee and (with permission) the balance; sorted by name by default, with "highest balance first" available.

**FR-506 — Customer credit and refund (manual adjustment with note)**

Source: A-31 (brief default 10, customer side).

Statement: A user with `orders.credit` can record a credit that reduces what a customer owes (for example for goods returned damaged), and a refund that records money returned to a customer; both require a note.

Acceptance criteria:

- Credit and refund are ledger entries with date, amount in one currency (the other calculated), note (required), acting employee and an optional link to an order or a damage record.
- Both appear in the ledger and in History with old balance → new balance.

**FR-507 — Deactivate a customer**

Source: A-32.

Statement: Customers are deactivated, not deleted; a deactivated customer cannot receive new orders but keeps all history.

Acceptance criteria:

- Deactivating a customer with a non-zero balance shows a warning and requires a note; the balance remains visible in Receivables.
- The walk-in customer (**Proposed — not requested**) has no ledger tab; its orders are listed only in Orders.
- Deletion (admin-only, only for a customer with no orders and no ledger entries) sets `deleted_at`; rows are never physically removed.

### 1.3.6 Orders & Payments

**FR-601 — Create an order with notes**

Source: R-10, R-20, R-13.

Statement: An order names a customer, a date (default today), the acting employee (signed-in user), a payment type (FR-604), a "rate for this order" (defaults to the global rate; may be typed per deal under More, logged, and recomputes non-overridden lines — section 2.3.3), free-text notes and one or more lines (FR-602).

Acceptance criteria:

- Notes are optional, up to 2,000 characters, shown on the order detail and searchable in the Orders list.
- The date cannot be in the future; back-dating is allowed and logged.
- Requires `orders.create`; saving on a phone with three lines takes under a minute for a trained employee (flow 3.5.1).
- The order receives a sequential number ("Order #1042") and its document rate (the global default rate at creation, FR-1106, unless a rate was typed for this order).

**FR-602 — Order lines: item, count, kg, unit price, line total**

Source: R-11, R-12, C-02.

Statement: Each line names a material, count and/or kg (per the material's pricing unit), a sale unit price in IQD and USD, and shows the line total in both currencies.

Acceptance criteria:

- The unit price defaults to the material's monthly sale price for the order's month (FR-609) and may be overridden per line (logged).
- Line total in the entered currency = unit price × priced measure, rounded; the other currency's line total is that amount converted at the order rate (section 2.3.4); when both unit prices are typed each total is its own product. The informational measure is stored but does not affect the total.
- At save time each line snapshots the material's bought price pair for the order month (cost snapshot, with fallback marker) so that the Profit report is reproducible (FR-1005).
- Stock for the chosen material is shown on the line; selling more than the stock triggers the FR-303 warning.

**FR-603 — Order total in both currencies**

Source: R-12, C-11.

Statement: The order total in each currency is the sum of its line totals in that currency; both totals are visible while entering the order and on every list and detail view.

Acceptance criteria:

- Totals are never obtained by converting the other currency's total; they are sums of stored line values (minus the discount below, when kept).
- **Proposed — not requested** (FR-616): an order-level discount (a pair at the order rate) with a one-tap "round down" that sets it to the rounding difference (801,250 → 800,000); the ledger entry carries the net total; the discount is shown on the receipt and logged, so line prices are never hacked to round a total.
- On phones the totals live in a sticky footer that stays visible while lines are added (wireframe 3.4.1).

**FR-604 — Payment type: cash or borrowed**

Source: R-13.

Statement: Every order is either *cash* (paid at the time of sale) or *borrowed* (on credit, owed by the customer).

Acceptance criteria:

- The payment type is a two-option segmented control on the order form; the default is the customer's last used type (cash for the walk-in customer).
- A cash order creates a receivable entry and an immediate "cash settlement" entry for the same amount in the customer's ledger (A-24); a borrowed order creates only the receivable.
- A cash order records **which currency was physically received** (one-tap "Paid in IQD / USD" next to the segmented control, defaulting to the customer's last choice); the settlement entry stores it as its entered currency. When the received currency differs from the settlement currency, the entry's settlement-side amount is the exact order total (so the order is Paid) and its other side is the amount actually handed over (`received_amount`), with the implied rate stored as `manual`; the amount handed over must be within the settlement tolerance of the order total converted at the order rate — a larger difference is not a rate but a discount (FR-616) or a customer credit, and the form says so. This is what makes a daily cash-up per currency possible (FR-1013).
- The Orders list shows a "Cash" or "Borrowed" chip and the payment status (FR-607).

**FR-605 — Payment type can be changed later, with note and history**

Source: R-14.

Statement: A user with `orders.change_payment_type` can switch an order between cash and borrowed at any time while the order is not void; the change requires a note and is kept in a per-order history.

Acceptance criteria:

- Borrowed → cash: records a cash settlement for the order's remaining balance dated today (or a chosen date), by the acting employee.
- Cash → borrowed: reverses the cash settlement entry (a reversal entry, never a deletion) so the order becomes owed again.
- The order's "Payment type history" shows each change: who, when, old → new, note.
- Both directions are logged in History with old balance → new balance for the customer.

**FR-606 — Payments received against a borrowed order (partial payments)**

Source: R-14, A-21 (brief default 7).

Statement: A borrowed order can receive one or more payments. Each payment records the date, who received it (defaults to the acting employee), the amount entered in either currency with the other calculated at the global default rate at that moment, and a note.

Acceptance criteria:

- "Record payment" on the order shows the remaining balance and pre-fills it; a smaller amount is a partial payment; a larger amount is refused unless the user confirms "record the excess as customer credit".
- **Settle in full**: when the customer pays "the rest" in the other currency, the sheet's "Settle in full" option writes the exact remaining settlement-currency amount with the amount physically received as a manual-rate pair, so no 5-dinar residue keeps the order "partially paid". When the customer pays in the settlement currency itself and the shortfall is within the settlement tolerance (settings: 250 IQD / 25 cents), "Settle in full" records the payment as received plus an automatic credit for the residue (note "settlement tolerance", linked to the order), so the cash-up still counts exactly what was received.
- **Proposed — not requested** (FR-617): a payment received partly in IQD and partly in USD is entered in one "split" sheet and stored as two entries; a payment method (cash / transfer / other) can be recorded.
- Requires `orders.record_payment`; the payment is a ledger entry linked to the order and appears on the order, the customer ledger and History.
- A payment can be recorded from the customer profile without choosing an order ("general payment"); it reduces the customer balance and is shown as "not linked to an order" (Q-10).
- Payments are never edited; a mistaken payment is reversed with a note (`orders.record_payment` covers reversal of one's own payment on the same day; otherwise admin).

**FR-607 — Order status derived from the ledger**

Source: R-14, A-24.

Statement: The status of an order is derived, never set: *Void*; otherwise *Paid* if the sum of entries linked to the order is zero; *Partially paid* if some but not all has been paid; *Unpaid* if nothing has been paid.

Acceptance criteria:

- Status chips appear in the Orders list, the order detail and the customer's Orders tab, with distinct colours in both themes (section 3.2).
- Automated tests cover each transition: cash → paid; borrowed → unpaid → partially paid → paid; change of payment type in both directions; void.

**FR-608 — An order reduces stock**

Source: R-05, R-06, C-02.

Statement: Saving an order creates one stock movement of type "sale out" per line with the line's count and kg.

Acceptance criteria:

- Stock updates in the same transaction as the order; movements reference the order line and appear on the material's movement list.

**FR-609 — Order line price defaults to the monthly sale price**

Source: R-08, A-17.

Statement: A new order line defaults its unit price to the material's sale price for the order's month (with the FR-306 fallback), taken in the currency that price was entered in; the other currency of the line is calculated at the order's document rate (the global default rate unless a rate was typed for this order). The price can be overridden per line; overrides are logged and visibly marked on the line.

Acceptance criteria:

- Changing the order date re-evaluates defaults for lines that were not overridden and tells the user.
- The line stores whether the price came from the month price or was typed, and which month price was used.

**FR-610 — Edit and void an order with compensating movements**

Source: A-25 (brief default 11).

Statement: An order can be edited by its creator or an admin (or a user with `orders.edit`) while no manual payment has been recorded and its date is not in a locked period (FR-1109); an admin may additionally restrict edits to a number of days after the order date (setting, off by default, because a next-morning correction is common and a void changes the order number on a receipt the customer already holds). Outside those rules it is voided with a reason and re-entered. The creator may also undo an order within 8 seconds of saving it (toast action); the undo is a void with reason "undo", fully logged, hidden from lists by default, and needs no `orders.void` key.

Acceptance criteria:

- Editing writes reversal stock movements and reversal ledger entries for the old version and new ones for the new version in one transaction, and logs a field-by-field diff.
- Voiding requires `orders.void` and a reason; it reverses all live stock and ledger entries (including a cash settlement), marks the order "Void" and logs who/when/why. Payments already received against a voided order stay in the customer ledger as credit and the UI says so, offering "Record refund" (FR-506).
- A voided order cannot be edited or un-voided; "Duplicate as new order" is offered.

**FR-611 — Orders list with filters**

Source: R-22, R-13.

Statement: The Orders page lists orders with search (number, customer, notes) and filters by date range, customer, acting employee, assigned employee (of the customer), payment type and status.

Acceptance criteria:

- Default view: today and yesterday, newest first; quick chips "Today", "This week", "This month", "Unpaid".
- Each row shows number, customer, date, total in both currencies, payment chip and status chip; a row opens the order detail.
- Employees without `customers.view_all` see only orders of their assigned customers plus orders they created (section 2.6.4).

**FR-612 — A borrowed order creates money owed by the customer**

Source: R-13, C-03.

Statement: A borrowed order increases the customer's balance by the order total in the customer's settlement currency; the entry carries both currency totals exactly as stored on the order, plus the order's rate snapshot.

Acceptance criteria:

- Automated test: creating a borrowed order whose lines total 100,000 IQD and 7,634 US cents raises the customer's balance by exactly 100,000 IQD and stores 7,634 cents on the entry (copied from the order totals, not re-converted) together with the order's rate snapshot; a later change of the global rate does not change the stored entry.

**FR-613 — Order receipt (print or share) — Proposed — not requested**

Source: Proposed — not requested (strongly recommended: in Iraqi trade a credit sale is handed over with a signed وصل).

Statement: From an order, generate a one-page receipt (PDF or image via the phone's share sheet, typically to WhatsApp) in the current language, showing the order number, lines, discount, totals in both currencies, payment type, amount received and remaining balance, and the customer's balance after the order.

Acceptance criteria:

- Uses the same stored values as the screen; RTL and LTR layouts; the number printed is the order number; can be removed without affecting other requirements, but if kept it is delivered with the order screen in the same iteration (I1), not later.

**FR-614 — Payment voucher (customer and company payments) — Proposed — not requested**

Source: Proposed — not requested (سند قبض / سند صرف are expected for every cash movement).

Statement: Every customer payment, cash settlement, refund and company payment receives a sequential voucher number and can be printed or shared as a one-page voucher in the current language: number, date, counterparty, amount in both currencies with the rate, received/paid by, method (if kept), note, balance after.

Acceptance criteria:

- Voucher numbers come from one sequence, never reused, and appear on the ledger row; a reversed payment's voucher shows "cancelled"; removable without affecting other requirements.

**FR-615 — Account statement (customer or company) — Proposed — not requested**

Source: Proposed — not requested (كشف حساب is how debts are chased).

Statement: From a customer or company profile, generate a statement for a date range: opening balance, every entry with date, description, amounts in both currencies, running balance, closing balance, in the current language, as PDF or shareable image.

Acceptance criteria:

- Totals match the ledger tab for the same range; presentation rules of section 2.4.5 apply (edited documents collapsed); removable without affecting other requirements.

**FR-616 — Order-level discount, "round down" and customer credit limit — Proposed — not requested**

Source: Proposed — not requested (rounding a total down is daily practice; a credit limit is the first thing owners ask for once debts are visible).

Statement: An order (or purchase) can carry a discount stored as a pair at the document rate, with a one-tap "round down" that sets it to the rounding difference; the total and the ledger entry are net of the discount. A customer may have an optional credit limit; a borrowed order that would exceed it shows a warning.

Acceptance criteria:

- Discount ≤ Σ line totals; logged old → new; shown on the receipt; the Sales report shows gross, discount and net; the credit-limit warning never blocks; both removable without affecting other requirements.

**FR-617 — Payment method and split payments — Proposed — not requested**

Source: Proposed — not requested (Q-29).

Statement: A money entry can record a method (cash, transfer, other; default cash), and a payment received or made partly in IQD and partly in USD is entered in one sheet and stored as two entries that share a note.

Acceptance criteria:

- Method is optional and defaults to cash; the split sheet shows the remaining balance after both parts; removable without affecting other requirements.

### 1.3.7 Supplier Companies & Accounting

**FR-701 — Create and edit supplier companies**

Source: R-24.

Statement: A user with `companies.create` creates a company with name, contact person, phone, address, notes; `companies.edit` edits them.

Acceptance criteria:

- Name is required and unique among active companies (script-normalised); all edits are logged old → new.
- The company profile page has tabs: Overview (balance, rate, contact), Accounting (ledger), Purchases, History.

**FR-702 — Settlement currency per company**

Source: A-20 (brief default 6).

Statement: Each company has a settlement currency (IQD or USD) chosen on its profile. Its balance is kept in that currency; the other currency is shown for information at the company's current rate.

Acceptance criteria:

- Settlement currency is required at creation (default IQD); changing it later is admin-only and requires a note. The change always writes one re-basing entry: when the balance is not zero the admin types and confirms the rate ("4,500,000 IQD = $3,435.11 at 1,310"), and when it is zero the entry simply zeroes the new currency's column — either way the balance after the switch is a number somebody agreed, never a sum of old entries at mixed rates (section 2.3.5). Nothing stored is rewritten; the ledger shows the change as a marker row.
- Every amount on the company pages shows both currencies; the settlement currency is visually primary.

**FR-703 — Exchange rate per company, set on the profile, with history**

Source: R-31, R-28.

Statement: Each company has its own IQD-per-USD rate, set from the company profile by a user with `companies.set_rate`; every rate change is kept with who, when, old → new and a note.

Acceptance criteria:

- The current rate is shown on the company profile with "since <date>" and a "Rate history" list.
- A new rate takes effect immediately for new purchases, payments, credits and adjustments; nothing stored is recalculated.
- Setting a rate outside ±20 % of the previous rate asks for confirmation (typo guard).

**FR-704 — Company accounting page: what we paid, what we owe, per purchase and per item**

Source: R-25, R-26, C-03.

Statement: The company's Accounting tab shows the running balance (sum of the company ledger), every ledger entry with a running balance, and per purchase: its total, what has been paid or credited against it, and what remains; per item within a purchase: the line totals.

Acceptance criteria:

- Balance and all amounts are hidden from users without `fields.see_company_balances`.
- The per-purchase view lists each active purchase with total, paid, credited, adjusted and remaining. Payments, credits and adjustments explicitly linked to a purchase count against it; unlinked payments and credits are allocated **oldest purchase first** for display (opening balances, unlinked adjustments and settlement changes are never allocated) (supplier accounts are running accounts — nobody links lump-sum payments), and the rest — the unallocated remainder, opening balances, unlinked adjustments, settlement changes and entries of voided purchases — is shown as "General" (A-29, Q-18). The allocation is presentation only; the balance is always the sum of all entries.
- Entries are shown newest first in posting order with a running balance; edited, undone and re-based entries follow the presentation rules of section 2.4.5.
- Filters: date range, entry type, acting employee.

**FR-705 — Record a payment to a company with automatic conversion**

Source: R-29, R-30, R-31, C-11.

Statement: A user with `companies.record_payment` records a payment to a company: the date paid, who made the payment (defaults to the acting employee, can be another employee), the amount entered in IQD or USD, with the other currency calculated automatically at the company's current rate, an optional link to a purchase, and a note.

Acceptance criteria:

- Typing an amount in one currency fills the other instantly; the filled value can be overridden (then the implied rate is stored and marked "manual"); the rate used is displayed and stored on the entry.
- "Settle in full" writes the exact remaining settlement-currency balance with the amount physically paid in the other currency as a manual-rate pair; a same-currency shortfall within the settlement tolerance is written as paid plus an automatic adjustment for the residue (note "settlement tolerance", linked to the purchase when one is linked), as FR-606.
- Each payment receives a voucher number and can be shared as a voucher (FR-614, **Proposed — not requested**); a method and a split IQD/USD payment are FR-617 (**Proposed — not requested**).
- The payment reduces the company balance in the same transaction and appears in the ledger with date, payer, both amounts, rate, note and running balance.
- Payments are never edited; a mistake is reversed with a note and a new payment recorded.
- The form is usable one-handed on a phone (wireframe 3.4.2).

**FR-706 — Manually change how much we owe, with a mandatory note and history**

Source: R-26, R-27, R-28.

Statement: A user with `companies.adjust_owed` can change a company's owed amount by recording an adjustment: the new balance (or the delta), a mandatory note, an optional link to a purchase. The system records old balance → new balance, who and when, forever.

Acceptance criteria:

- The form shows the current balance, lets the user type either the new balance or the change amount (the other is computed), requires a note of at least 3 characters, and previews the resulting entry before saving.
- The adjustment is an append-only ledger entry; the balance changes by exactly the delta; History shows old → new, note, acting employee and timestamp.
- Adjustments cannot be edited or deleted; a wrong adjustment is corrected by another adjustment with a note.

**FR-707 — Credits for goods returned to a company**

Source: A-31 (brief default 10).

Statement: When a damaged item attributed to a company is marked returned, a user with `companies.record_credit` (or through the damage record's "Mark returned & credit" action) records a credit that reduces what we owe that company.

Acceptance criteria:

- The credit amount defaults to quantity × the bought unit price of the linked purchase line (or the month's bought price when no purchase is linked), in the company's settlement currency with the other currency at the company's rate; it can be edited before saving with a note.
- The credit appears in the company ledger linked to the damage record and, when known, to the purchase.

**FR-708 — Opening company debt**

Source: A-26.

Statement: At go-live a user with `companies.opening_balance` records what the factory already owes a company as a dated ledger entry with a note.

Acceptance criteria:

- Same behaviour as FR-504 with the company's rate for the calculated currency; appears as "Opening balance".

**FR-709 — Company ledger shows who, when, old → new and the note for every change**

Source: R-27, R-28.

Statement: Every entry that changes a company's balance (purchase, payment, adjustment, credit, opening balance, reversal) and every rate change is shown with the acting employee, the timestamp, the balance before and after, and the note.

Acceptance criteria:

- The ledger and the History tab of the company both show these fields; nothing that affected a balance can be missing from either.

**FR-710 — Companies list**

Source: R-24.

Statement: The Companies page lists companies with search, current balance (with permission), settlement currency, rate and assigned employee; sorted by name, with "highest balance first" available.

Acceptance criteria:

- Deactivated companies hidden behind a filter; a company with a non-zero balance cannot be deactivated without a note.

**FR-711 — Assign a company to an employee (optional)**

Source: R-16 (A-15, optional part of reading (a)).

Statement: A company may be assigned to one employee, for filtering and reporting; there is no scoping rule on companies (all users with `companies.view` see all companies).

Acceptance criteria:

- Same behaviour as FR-502 with `companies.assign`.

**FR-712 — Per-purchase and per-item owed/paid breakdown**

Source: R-25.

Statement: For each purchase the system shows total, paid, credited, adjusted and remaining; for each line, its total in both currencies. Payments can be optionally linked to one purchase at recording time; unlinked payments and credits are allocated oldest-first for display.

Acceptance criteria:

- Remaining per active purchase = purchase total − Σ linked entries − its oldest-first share of unlinked payments and credits (negative when over-linked); the "General" bucket = everything not attributable to an active purchase; identity, tested: Σ remaining + General = company balance; explicit links always take precedence over the automatic allocation.
- Automated test for the reconciliation identity.

### 1.3.8 Damaged Items & Returns

**FR-801 — Damaged items page and damage record**

Source: R-17.

Statement: A Damaged items page lists damage records and lets a user with `damages.create` record one: material, count and/or kg, date (default today), acting employee, an optional reason (free text), an optional attribution (FR-802), returnable flag (FR-803) and a note.

Acceptance criteria:

- The form is completable on a phone in under a minute (wireframe 3.4.3); the material picker shows current stock.
- Each record gets a sequential number ("Damage #17") and is logged in History.
- The list shows material, quantity, date, attribution chip, returnable/return-status chip and employee; filters: date range, material, attribution, return status, employee.

**FR-802 — Optional attribution: a customer order, "us", or the company it came from**

Source: R-18, A-23 (brief default 9).

Statement: The reason for damage can optionally be attributed to (a) a customer order (goods came back damaged), (b) "us" (damaged internally, no counterparty), or (c) the supplier company it came from, optionally naming the purchase it arrived in. Attribution is optional; the reason text is optional too.

Acceptance criteria:

- Attribution is a four-way choice: None / Customer order / Us / Company; choosing Customer order opens an order picker (filtered by material), choosing Company opens a company picker and an optional purchase picker (purchases of that company containing the material).
- No lot or batch tracking is used; the employee picks the link (A-23).
- Attribution can be changed later by a user with `damages.edit`; changes are logged old → new.

**FR-803 — Returnable flag and return status**

Source: R-19.

Statement: Each damage record says whether the goods can be returned (Yes/No) and, when yes, tracks a return status: Pending → Returned (→ Credited when a company credit was recorded), or Written off.

Acceptance criteria:

- The list and detail show a chip: "Not returnable", "Returnable — pending", "Returned", "Returned & credited", "Written off".
- "Mark returned" requires `damages.mark_returned`, records date and acting employee, and — when the attribution is a company — offers "and record credit" (FR-805).
- Every status change is logged old → new with note.

**FR-804 — Damage reduces stock (when the goods were in stock)**

Source: R-17 (brief: "Reduces stock"), A-30.

Statement: A damage record attributed to "us", to a company/purchase, or with no attribution creates a stock movement "damage out" for its count and kg. A damage record attributed to a customer order creates no stock movement, because the goods had already left stock when sold.

Acceptance criteria:

- The form states the stock effect explicitly before saving ("This will reduce stock by 15 kg" / "No stock change — goods were already sold").
- Editing quantities or attribution writes compensating movements; voiding the damage record reverses them (`damages.void`, reason required).
- A record attributed to a customer order offers "Return to stock" (`damages.edit`) for goods that turn out to be usable; it writes a `return_in` movement for the record's quantity and is logged.

**FR-805 — Return to a supplier company reduces what we owe (credit)**

Source: R-19, A-31 (brief default 10).

Statement: Marking a company-attributed damage record as returned lets the user record a credit in that company's ledger (FR-707). Stock is not changed by the return (it was already reduced by the damage record).

Acceptance criteria:

- The credit pre-fills from the linked purchase line price or the month's bought price and the company's current rate; the user can edit the amount with a note.
- Return status becomes "Returned & credited"; the credit entry links back to the damage record.

**FR-806 — Goods a customer returned damaged do not change the customer's balance unless a credit is recorded**

Source: R-19, A-31 (brief default 10).

Statement: A damage record attributed to a customer order does not change the customer's balance by itself; a user with `orders.credit` can record a customer credit from the damage record (FR-506).

Acceptance criteria:

- The damage record shows "Customer balance unchanged" and a "Record customer credit" action for users with the permission; the credit links to the damage record and the order.

**FR-807 — Damage list, filters and totals**

Source: R-17.

Statement: The Damaged items list supports the filters in FR-801 and shows period totals (count, kg and, with `fields.see_bought_price`, estimated value in both currencies).

Acceptance criteria:

- Estimated value = quantity × the month's bought price for the damage month (both currencies stored on the price), flagged when a fallback month was used.

### 1.3.9 History

**FR-901 — Audit log of every change**

Source: R-21, R-28, C-04.

Statement: Every create, update, void, delete, sign-in, sign-out, lockout, permission change, rate change, price change and ledger entry across the system is recorded with who, when, which record, what changed (old → new per field) and the note where one was given. Records are never modified or removed.

Acceptance criteria:

- Automated tests assert that every write endpoint produces exactly the expected History entries.
- Entries include the acting user, timestamp (stored UTC, displayed Asia/Baghdad), entity type and identifier, a human-readable label, the diff, the note, and the request identifier for support.
- Nothing in the UI or the API can edit or delete a History entry; database privileges for the application user disallow UPDATE/DELETE on the audit table (section 2.13).

**FR-902 — History page filterable by user and date**

Source: R-21, R-22, R-16 (filter by assigned employee).

Statement: The History page shows the audit log newest first, filterable by acting user ("done by"), by assigned employee ("assigned to", for records that have one), by date range, by entity type and by record.

Acceptance criteria:

- Requires `history.view`; without `history.view_all` the page shows only the user's own actions.
- Each entry expands to show the field diff in the user's language (field labels translated, values formatted per locale, amounts in both currencies).
- Date filter presets: Today, Yesterday, This week, This month, Custom; the "user" filter offers both meanings side by side with distinct labels.
- Infinite scroll on phones; 50 entries per page on desktop.

**FR-903 — History tab on every record**

Source: R-28.

Statement: Orders, purchases, materials, customers, companies, damage records and users each have a History tab showing that record's own audit entries.

Acceptance criteria:

- Same entry format as FR-902; includes ledger entries that reference the record.

**FR-904 — Balance changes are visible as history (old → new, who, when, note)**

Source: R-26, R-27, R-28.

Statement: Every change to any balance (customer or company) is visible as a ledger entry with the balance before and after; no balance can change without such an entry.

Acceptance criteria:

- Automated invariant test: for every customer and company, the running balances in the ledger view equal the cumulative sums of entries; there is no code path that updates a balance column (balances are computed, section 2.4).

### 1.3.10 Reports

**FR-1001 — Reports page**

Source: R-21.

Statement: A Reports page groups the reports FR-1003 to FR-1010; each report opens with the filters in FR-1002 and shows totals in both currencies.

Acceptance criteria:

- Requires `reports.view`; each report card states what it contains in one line; reports render as mobile-friendly summary cards with an expandable table.

**FR-1002 — Filter reports by user and date range**

Source: R-22.

Statement: Every report can be filtered by date range and by user, where "user" offers both the acting employee ("done by") and the assigned employee ("assigned to") where applicable.

Acceptance criteria:

- Without `reports.view_all` the user filter is pinned to the signed-in user, using the filter that makes sense for that report: "done by" for Sales, Purchases, Profit, Damage, Employee activity and the daily cash-up; "assigned to" for Receivables and Payables (a sales employee sees the debts of their own customers); the Stock report has no user filter (section 2.11 lists the pinning per report).
- Date presets as in FR-902; a custom range picker works in RTL with Saturday as the first weekday.

**FR-1003 — Sales report**

Source: R-21.

Statement: Totals of active orders by day/month, by customer, by material and by employee (done by / assigned to), in both currencies from stored line values; counts and kg sold; cash vs borrowed split; money collected in the period.

Acceptance criteria:

- Totals equal the sum of the order totals in the period (independent SQL check in tests); voided orders excluded; month grouping per FR-1011.
- Both currencies shown as separate sums, never converted.

**FR-1004 — Purchases report**

Source: R-21, R-25.

Statement: Totals of active purchases by day/month, by company, by material and by employee; counts and kg bought; money paid to companies in the period.

Acceptance criteria:

- Amount columns are omitted for users without `fields.see_bought_price` (quantities remain); voided purchases excluded; totals reconcile with the Purchases list for the same filters.

**FR-1005 — Profit report**

Source: R-21 (brief), R-08.

Statement: "Margin vs. month price": per material and month, Σ over active order lines of (sale unit price − the line's cost snapshot, i.e. the material's bought price for the order month taken at save time) × priced measure. The margin is computed once, in the line's entered currency, and converted to the other currency at the line's stored rate, so the two currencies never disagree in sign; grouped by month, material, customer and employee. It is a list-price margin — it ignores actual purchase cost and damage losses — and is labelled as such.

Acceptance criteria:

- Requires `fields.see_profit`; lines whose cost snapshot is empty (`cost_source = none`) are listed separately as "no cost price" and excluded from the sum; lines whose snapshot came from an earlier month (`fallback`) are flagged per row.
- Because the cost is snapshotted on the line, the report is reproducible: editing a past month's price never changes a margin already reported. **Proposed — not requested:** a "recompute with current month prices" toggle for comparison, and an actual-average-cost column from purchases.
- The formula is documented in section 2.11 and covered by a unit test with hand-computed expectations.

**FR-1006 — Stock report**

Source: R-21, R-06.

Statement: Current stock per material in its priced measure (and the other measure when complete), movements in the period by type, first-bought and last-sold dates, and stock value (stock × current month bought price, both currencies).

Acceptance criteria:

- Stock equals the sum of the stock ledger per material; value columns omitted without `fields.see_bought_price`; fallback-month prices flagged.

**FR-1007 — Receivables report (customers owe us)**

Source: R-21, C-03.

Statement: Balance per customer (settlement currency and ≈ other currency), unpaid and partially paid orders with remaining amounts, payments received in the period; filterable by assigned employee. Ageing buckets (0–30, 31–60, 61–90, 90+ days) are **Proposed — not requested**.

Acceptance criteria:

- Requires `fields.see_customer_balances`; the sum of balances equals the sum over all customer ledgers; sorted by balance descending by default.

**FR-1008 — Payables report (we owe companies)**

Source: R-21, R-25, C-03.

Statement: Balance per company, purchases, payments, credits and adjustments in the period, per-purchase remaining amounts.

Acceptance criteria:

- Requires `fields.see_company_balances`; the sum of balances equals the sum over all company ledgers; per-purchase remaining reconciles per FR-712.

**FR-1009 — Damage report**

Source: R-21, R-17.

Statement: Damage by material, attribution, return status and month in the period: count, kg, estimated value, and credits obtained from returns.

Acceptance criteria:

- Value columns omitted without `fields.see_bought_price`; voided damage records excluded; totals match the Damaged items list for the same filters.

**FR-1010 — Employee activity report**

Source: R-21, R-22, C-04.

Statement: Per employee in the period: orders created (count, totals), purchases created, customer payments received, company payments made, damage records, adjustments, voids and sign-ins, with links to the filtered History.

Acceptance criteria:

- Counts derived from `done_by`/`performed_by` fields and the audit log; without `reports.view_all` only the signed-in user's row is returned; each cell links to History filtered by that employee, action and period.

**FR-1013 — Daily cash-up per employee — Proposed — not requested**

Source: Proposed — not requested (the owner's nightly question: "how much IQD and how much USD should each employee hand over?").

Statement: For a day (or range) and per employee: cash received (customer payments and cash settlements, by the currency physically received), cash paid out (company payments and refunds, by the currency paid), and the net per physical currency; filterable by method when FR-617 is kept.

Acceptance criteria:

- Figures come from the ledgers' entered-currency column and the manual-rate pairs (FR-604, FR-606), never from conversions; the sales employee sees only their own line; removable without affecting other requirements.

**FR-1011 — Month grouping where prices are monthly**

Source: R-08.

Statement: Reports that involve prices (sales, purchases, profit, stock value, damage value) group by calendar month by default and show which month price was applied.

Acceptance criteria:

- Month headers use the locale's month names (Kurdish month names confirmed with the client, Q-04); a period spanning months shows one group per month plus a grand total.

**FR-1012 — Export of reports and history — Proposed — not requested**

Source: Proposed — not requested.

Statement: Export any report or the History list as CSV/Excel (and PDF for reports) in the current language, respecting field-level permissions.

Acceptance criteria: the export contains exactly the rows and columns the user can see on screen; requires `reports.export` / `history.export`; removable without affecting other requirements.

### 1.3.11 Settings & Preferences

**FR-1101 — Two themes: light and dark**

Source: R-32, A-13.

Statement: The whole interface is available in a light and a dark theme, chosen from Settings; "Follow device" is also offered.

Acceptance criteria:

- Every screen, chip, chart and state is designed in both themes with the contrast targets in NFR-10; theme switches without reload and without a flash of the other theme on load (FR-1103).
- The choice is a per-browser preference (FR-1103).

**FR-1102 — Font size controlled from Settings**

Source: R-33.

Statement: Settings offers four font sizes (Small, Default, Large, Extra large) that scale every text in the interface.

Acceptance criteria:

- The scale applies globally through one root variable (section 2.10.9); no screen overflows horizontally at Extra large on a 360 px phone; touch targets never shrink.
- The choice is a per-browser preference (FR-1103) and applies before first paint.

**FR-1103 — Preferences saved in the browser**

Source: R-34, A-14.

Statement: Language, theme, font size, numeral style and the "shared device" flag are stored in the browser (localStorage) of each device, not in the user's account.

Acceptance criteria:

- Preferences survive sign-out and browser restarts on the same device/browser; a new browser starts from defaults (language Kurdish Sorani, theme follow-device, font Default, Western numerals — Q-03, Q-20).
- If storage is unavailable (private mode, blocked), the app still works with in-memory preferences and shows a one-line notice in Settings.
- Preferences are applied before the first paint: no flash of wrong theme, size or direction.
- Consequence for shared tablets, stated in the UI: "These settings belong to this device, not to your account." To stop Kurdish- and Arabic-speaking colleagues fighting over one tablet, the lock screen remembers the last language each recent user chose (in the same browser storage, next to their name) and applies it on switch or unlock; theme and font size stay device-level.

**FR-1104 — Language switch**

Source: R-04.

Statement: The user can switch between Kurdish Sorani, Arabic and English from Settings and from the login/lock screen.

Acceptance criteria:

- Switching changes all text, direction, number and date formats immediately without reload; the language names are shown in their own script (کوردی، العربية, English).

**FR-1105 — Numeral style setting**

Source: A-09 (brief default 16).

Statement: Users can choose Western digits (0–9, default) or Eastern Arabic-Indic digits (٠–٩ / ۰–۹) for display; input accepts both and normalises.

Acceptance criteria:

- Applies to numbers, amounts and dates everywhere; the setting is per browser; the sign-in and lock screens follow it.

**FR-1106 — Global default exchange rate (customer side) with history**

Source: R-30, R-31 (the customer side needs a rate too), brief.

Statement: An admin (or a user with `settings.set_global_rate`) sets the global IQD-per-USD rate used for orders, customer payments, monthly price entry and any place where no company rate applies; every change is kept with who, when, old → new, note.

Acceptance criteria:

- Shown in Settings → System with its history; the same ±20 % typo guard as FR-703; nothing stored is recalculated when it changes.
- **Proposed — not requested:** when the rate is older than a set number of days (default 3), Settings and the Dashboard (if kept) show "Rate last updated 5 days ago — still 1,310?" with a one-tap confirm or edit, because a stale customer-side rate silently skews every USD figure.

**FR-1107 — Settings page structure**

Source: R-32, R-33, R-34 (brief).

Statement: Settings is split into "This device" (language, theme, font size, numerals, shared-device flag, device label), "My account" (change password, set PIN, "My activity" — the user's own History entries) and "System" (global rate and history — visible to admins and to users with `settings.set_global_rate`; idle-lock timings and PIN policy, negative-stock rule, edit windows, period lock (FR-1109, Proposed), settlement tolerance, week start, go-live date, backups status — admins only).

Acceptance criteria:

- Device preferences are labelled as saved on this device; system settings changes are logged in History; a user with `settings.set_global_rate` but not admin sees only the global-rate card in System.

**FR-1108 — Calendar, week start and date format**

Source: C-10.

Statement: Dates use the Gregorian calendar, Asia/Baghdad time, dd/MM/yyyy display, week starting Saturday.

Acceptance criteria:

- All date pickers start the week on Saturday (system setting, default Saturday, Q-04); timestamps are stored in UTC and displayed in Asia/Baghdad; "today" for defaults and edit windows is computed in Asia/Baghdad.

**FR-1109 — Period lock — Proposed — not requested**

Source: Proposed — not requested (an integrity control: without it, back-dating and past-month price edits silently change reports the owner has already read).

Statement: An admin can set a "locked through" date. Any write whose business date is on or before it — new back-dated orders, purchases, payments, damage records, opening entries, edits and voids of documents in that period, reversals of entries in that period, and price edits for months that had fully ended on or before the lock date — is refused with a clear message; the admin can move the date back with a note (logged).

Acceptance criteria:

- The lock is a system setting shown in Settings → System with who set it and when; the refusal names the lock date and the admin; automated tests cover each write path; removable without affecting other requirements (the edit windows then rely on the day-count settings alone).

### 1.3.12 i18n / RTL

**FR-1201 — All interface text in Kurdish Sorani, Arabic and English**

Source: R-04, C-09.

Statement: Every label, message, validation error, empty state, report header and notification exists in all three languages; there is no English-only corner.

Acceptance criteria:

- A missing translation fails the build; the glossary (section 1.6) is applied to the message catalogs and reviewed by the client before go-live (I6).
- Server-side messages (validation, permission errors) are returned as message keys with parameters and rendered in the user's language.

**FR-1202 — RTL as the primary direction, LTR as the mirror**

Source: R-04, C-09.

Statement: Kurdish and Arabic render right-to-left; English renders left-to-right as a mirror of the same layout.

Acceptance criteria:

- No screen uses physical left/right styling; layouts, icons that imply direction, gestures, progress and animations are mirrored (section 2.10.6); verified on a real phone in each language before an iteration is done (Definition of done, 4.1).

**FR-1203 — Locale-aware numbers, currencies and dates**

Source: R-04, C-10, C-11.

Statement: Numbers use locale separators; IQD shows no decimals, USD two; currency symbols are placed per locale; dates display dd/MM/yyyy and month names in the interface language.

Acceptance criteria:

- Formatting rules in sections 2.10.4 and 2.10.5 are implemented in one shared formatter used by every screen and report; a snapshot test covers each locale × currency × numeral style.

**FR-1204 — Glossary applied; "Order" and "Purchase" never confused**

Source: R-04, brief terminology note.

Statement: The trilingual glossary is the single source of domain terms; in every language a sale to a customer and a purchase from a company have distinct, non-overlapping words.

Acceptance criteria:

- Message catalogs use the glossary terms; a review checklist item in every iteration confirms no new term bypassed the glossary.

**FR-1205 — Search normalisation across Arabic and Kurdish script variants**

Source: C-09 (brief).

Statement: Searching names (materials, customers, companies, users) matches across script variants — ك/ک, ي/ی/ى, ه/ە/ة, أ/إ/آ/ا — and the Kurdish-specific letters ڵ ڕ ۆ ێ ە fold to their base letters, so a name typed on an Arabic keyboard is found from a Kurdish one and vice versa; diacritics, tatweel and digit styles are ignored.

Acceptance criteria:

- The normalisation algorithm in section 2.10.7 is implemented once (shared between the API and the client) with a test table of at least 30 pairs.

**FR-1206 — Direction-aware icons, animations, gestures and inputs**

Source: C-09 (brief).

Statement: Directional icons (back, next, chevrons) flip in RTL; slide animations and swipe gestures follow the reading direction; numeric and phone inputs stay LTR inside RTL forms; currency symbol placement follows the locale.

Acceptance criteria:

- The icon set is classified (mirror / do not mirror) in section 2.10.6; each new screen is checked against it.

### 1.3.13 Cross-cutting

**FR-1301 — A web application for a single factory**

Source: R-01, C-01.

Statement: Mizan is a browser-based web application (no app-store install required) for one factory; there is no multi-company or multi-tenant model.

Acceptance criteria:

- Runs in the browsers listed in NFR-09 on phones, tablets and desktops from a single URL over HTTPS.
- An installable PWA shortcut (home-screen icon, static-asset caching) is **Proposed — not requested** (FR-1313).

**FR-1302 — Every amount is shown in both currencies**

Source: C-11, R-09, R-30.

Statement: Every price, total, payment, balance and report figure is displayed in IQD and USD, from stored values where they exist and marked "≈" where derived at a current rate for information.

Acceptance criteria:

- A UI component "DualAmount" is the only way amounts are rendered; a screen that shows a single currency fails review.

**FR-1303 — Mobile-first and one-handed**

Source: C-06.

Statement: Every page is designed for a 360 px-wide phone first, with primary actions reachable by the thumb, and scales up to tablet and desktop.

Acceptance criteria:

- Primary action within the bottom 40 % of the screen on phones; bottom sheets instead of centred modals; no horizontal scrolling at any font size; tested on a real Android phone.

**FR-1304 — Shared tablets**

Source: C-07.

Statement: The lock and switch-user behaviour of FR-106 plus the "shared device" flag make one tablet safe for several employees.

Acceptance criteria:

- With the flag on, the idle timeout is short (FR-106), PINs must have six digits, PIN switching can be disabled by the admin, sessions expire 12 hours after sign-in, and the lock screen lists recent users with their last language; unsaved forms warn before locking.

**FR-1305 — Poor connectivity handling**

Source: C-07, A-12 (brief default 17).

Statement: The app is online-only but degrades gracefully: slow requests show progress, failed saves can be retried without retyping, forms are protected against loss, and the same save is never applied twice.

Acceptance criteria:

- Every save uses an idempotency key so a retry after a timeout cannot duplicate an order, purchase or payment.
- A draft of an in-progress order/purchase/damage/payment form is kept in the browser until saved or discarded (survives reload).
- A visible offline/online indicator; reads fall back to the last loaded list with a "may be out of date" notice.

**FR-1306 — Attribution: who did what**

Source: C-04, R-16 (reading (b)).

Statement: Every record stores who created it and who last updated it; every order, purchase, payment, damage record, adjustment and rate change records the acting employee; "who made the payment" can differ from the recorder.

Acceptance criteria:

- `created_by`/`updated_by` on every table (section 2.2); filters "done by" on lists, History and reports.

**FR-1307 — Soft delete everywhere**

Source: A-32.

Statement: Nothing is ever physically deleted; records are deactivated or voided, and the admin-only "delete" of an unreferenced record sets `deleted_at` (the record disappears from every list and picker but stays in the database and in History).

Acceptance criteria:

- Every mutable table has a `deleted_at` column; list endpoints exclude soft-deleted rows by default; delete endpoints check references, set `deleted_at` and are logged with a snapshot of the record; no code path issues a SQL DELETE on business tables.

**FR-1308 — Concurrency: two employees editing the same record**

Source: brief (NFR list) — A-11.

Statement: Editable records carry a version; a save with a stale version is rejected with a clear message and the current values, never silently overwritten. Ledgers are append-only, so concurrent payments never conflict.

Acceptance criteria:

- Orders, purchases, materials, customers, companies, users and damage records use optimistic locking; the UI shows "Someone changed this while you were editing" with a side-by-side view and "Reload".

**FR-1309 — Global search — Proposed — not requested**

Source: Proposed — not requested.

Statement: A single search box (header on desktop, search tab on phones) finds materials, customers and companies (and order/purchase numbers) the user is permitted to see, with script normalisation.

Acceptance criteria: results grouped by type, at most 5 per group with "show all"; removable without affecting other requirements.

**FR-1310 — Dashboard — Proposed — not requested**

Source: Proposed — not requested.

Statement: A home page with today's sales and purchases, unpaid orders, low stock (if FR-310 kept), company balances due, and the user's recent actions — each tile only when the user has the matching permission.

Acceptance criteria: every tile links to the filtered list behind it; removable — the home tab then opens Orders.

**FR-1311 — Distinct visual identity from the palette system**

Source: C-05, C-12.

Statement: Mizan reuses the palette system's component library and interaction patterns but has its own name, logo mark, favicon, primary hue, accent palette, login screen and header colour, so staff never confuse the two.

Acceptance criteria:

- Side-by-side screenshots of both apps' login, list and form screens are reviewed by the client in I0; the primary hue differs by at least 90° from the palette system's; the app name and logo appear on the login screen, the lock screen, the header and the browser tab.

**FR-1312 — CSV import for opening data — Proposed — not requested**

Source: Proposed — not requested (brief default 12 mentions it as Proposed).

Statement: Import materials, customers, companies, opening stock and opening balances from CSV templates at go-live, with a preview and per-row errors.

Acceptance criteria: imports create the same records and ledger entries as manual entry, attributed to the importing admin; removable without affecting other requirements.

**FR-1313 — Installable PWA shortcut — Proposed — not requested**

Source: Proposed — not requested.

Statement: A web manifest and static-asset caching so the app can be added to the home screen and opens instantly; data is never cached for offline editing (A-12).

Acceptance criteria: removable without affecting other requirements.

## 1.4 Non-functional requirements

**NFR-01 — Three languages and RTL as the primary direction**

Kurdish Sorani (`ckb-IQ`), Arabic (`ar-IQ`) and English (`en`) are complete and equal; RTL is designed first and LTR is the mirror. Acceptance: every screen passes a visual check in all three languages and both directions on a phone before its iteration is done; no untranslated key reaches production (build fails); font rendering of ڵ ڕ ۆ ێ ە is verified on Android Chrome, iOS Safari and desktop Chrome/Firefox/Edge.

**NFR-02 — Mobile-first and touch-friendly**

Designed for a 360 × 640 CSS-px phone first. Acceptance: no horizontal scroll at any font size; touch targets ≥ 44 × 44 CSS px with ≥ 8 px spacing; primary actions reachable one-handed; keyboards match the field (`inputmode="decimal"` for amounts, `tel` for phones); no hover-only affordances.

**NFR-03 — Performance on low-end Android phones and slow connections**

Reference device: a 2 GB-RAM Android phone with Chrome, on a throttled "slow 4G" profile (400 kbps, 400 ms RTT). Targets: first load of the app shell ≤ 5 s to interactive; repeat load ≤ 2 s (cached static assets); route change ≤ 300 ms; initial JavaScript ≤ 250 kB gzipped with route-level code splitting; fonts subset and preloaded (≤ 120 kB per script family); list endpoints p95 ≤ 300 ms and write endpoints p95 ≤ 500 ms at the volumes in NFR-13; saving an order round trip ≤ 1.5 s on the throttled profile; Lighthouse mobile performance ≥ 80 on the reference device. Measured in I6 and regression-checked in CI with a bundle-size budget.

**NFR-04 — Security**

HTTPS only (HSTS); passwords hashed with Argon2id; sessions server-side, revocable, httpOnly/secure cookies; CSRF protection; login rate limiting and lockout (FR-101); every endpoint enforces permissions (FR-104); all input validated server-side with allow-lists; parameterised queries only; security headers (CSP, frame-ancestors none, no-sniff); dependency vulnerability scanning in CI; secrets only in environment/secret store, never in the repository; admin actions audited. Detailed in section 2.13.

**NFR-05 — Auditability**

Every state change is attributable to a user and a time and is reconstructible from the audit log and ledgers (FR-901, FR-904). Acceptance: given the database, a developer can explain any balance and any stock quantity as a list of entries with authors; History cannot be altered by the application.

**NFR-06 — Money and stock integrity**

Money is stored as integers in minor units (IQD whole dinars, USD cents) — never floating point; every stored amount carries both currencies and the rate used; historical amounts are never recalculated from a later rate; balances and stock quantities are sums over append-only ledgers; every write that touches a ledger happens in one database transaction with the record it belongs to. Acceptance: property-based tests for rounding, reversal symmetry (entry + reversal = 0) and reconciliation identities (section 2.12).

**NFR-07 — Concurrency**

Two employees editing the same order, purchase, material, customer, company or user record cannot overwrite each other's changes: optimistic locking with a version number (FR-1308); ledger writes are append-only and serialised per counterparty by the database transaction; sequential numbers never collide; a gap left by a rolled-back transaction is acceptable and documented (2.9.5).

**NFR-08 — Backup and restore**

Automated nightly database backups with 30 daily and 12 monthly copies kept off the application server, plus continuous WAL archiving as standard (a cash ledger cannot afford to lose a day); restore procedure written and rehearsed before go-live and every quarter; recovery point objective 15 minutes; recovery time objective 4 hours. Backups include uploaded assets (none in v1 besides the database).

**NFR-09 — Browser support**

Chrome and Samsung Internet on Android 10+, Safari on iOS 15+, and the last two versions of Chrome, Edge, Firefox and Safari on desktop. Acceptance: the smoke tests in section 2.12 pass on Android Chrome (real device), iOS Safari (real device or simulator) and desktop Chrome; the app tells older browsers what to update.

**NFR-10 — Accessibility**

Font scaling to Extra large (125 %) and OS-level text scaling without layout breakage; WCAG 2.1 AA contrast in both themes (≥ 4.5:1 for text, ≥ 3:1 for large text, icons and control boundaries — token sheet in section 3.2 lists measured ratios); `prefers-reduced-motion` honoured (animations reduced to fades ≤ 100 ms); visible focus rings; every control labelled for screen readers in the current language; touch targets per NFR-02; colour never the only carrier of meaning (status chips have text and icon).

**NFR-11 — Availability and resilience on the factory floor**

Online-only with graceful degradation (FR-1305): idempotent saves, retry with backoff, draft protection, clear error states. Target availability during working hours 99.5 % monthly; planned maintenance outside 07:00–19:00 Asia/Baghdad; health endpoint and uptime monitoring (section 2.14).

**NFR-12 — Maintainability and reuse**

Mizan is built from the palette system's component library, auth pattern, i18n pipeline and theming tokens; only tokens, naming and branding differ (section 2.10.11). Code is TypeScript end to end; the permission catalog, glossary and message catalogs are single sources of truth shared by API and client; every ledger and money rule lives in one module with tests.

**NFR-13 — Data volumes and scalability**

Design point (A-11, Q-02): up to 500 orders and purchases per day, 5,000 materials, 10,000 customers, 500 companies, 2 million audit entries over five years, 30 concurrent users. Acceptance: indices and pagination in section 2.2 and 2.9; list endpoints meet NFR-03 at these volumes in a seeded load test (I6).

**NFR-14 — Design quality as a functional requirement**

The client's satisfaction with the look and feel is a delivery criterion (C-12). Acceptance: the identity, token sheet, animation guidelines and typography in Deliverable 3 are implemented as specified; the client reviews the visual design in I0 and signs off the polished product in I6; the signature moments in section 3.6 are demonstrated.

## 1.5 Roles and permission catalog

### 1.5.1 Roles

| Role | Description |
|---|---|
| **Admin** | Holds every permission implicitly. Manages users, permissions, system settings, opening balances and deletes (soft, unreferenced records only). Subject to the admin-safety rules (FR-107). |
| **Employee** | Holds exactly the permissions granted in their permission set. Starts from a preset (optional) and is customised per person. |

Only two roles exist (R-02). Anything finer is expressed through the permission set, so "supervisor", "cashier" or "storekeeper" are presets or custom sets, not roles.

### 1.5.2 Permission catalog (page × action, plus field-level flags)

Key naming: `<page>.<action>`; field-level flags are `fields.<flag>`. "Implied" means the editor turns it on automatically. Presets: **S** = Sales, **W** = Warehouse, **A** = Accountant (● granted, — not granted). Admin holds all keys.

| Page | Key | What it allows | Implied | S | W | A |
|---|---|---|---|---|---|---|
| Materials | `materials.view` | See the Materials page, material details, stock, sale prices | — | ● | ● | ● |
| Materials | `materials.create` | Create materials | `materials.view` | — | ● | — |
| Materials | `materials.edit` | Edit materials, deactivate/reactivate, change pricing unit (admin only for items with movements) | `materials.view` | — | ● | — |
| Materials | `materials.set_prices` | Set or change monthly bought and sale prices; copy last month's prices | `materials.view`, `fields.see_bought_price` | — | — | ● |
| Materials | `materials.opening_stock` | Record opening stock and stock corrections (adjustment movements) | `materials.view` | — | ● | — |
| Purchases | `purchases.view` | See purchases list and purchase details (amounts require `fields.see_bought_price`) | — | — | ● | ● |
| Purchases | `purchases.create` | Create a purchase ("Add material") | `purchases.view`, `materials.view`, `fields.see_bought_price` (a purchase cannot be typed without its prices) | — | ● | — |
| Purchases | `purchases.edit` | Edit a purchase within the edit window (creator can always edit own within the window) | `purchases.view` | — | ● | — |
| Purchases | `purchases.void` | Void a purchase with a reason | `purchases.view` | — | — | — |
| Orders | `orders.view` | See orders list and order details | — | ● | — | ● |
| Orders | `orders.create` | Create orders | `orders.view`, `customers.view`, `materials.view` | ● | — | — |
| Orders | `orders.edit` | Edit an order within the edit window | `orders.view` | ● | — | — |
| Orders | `orders.void` | Void an order with a reason | `orders.view` | — | — | — |
| Orders | `orders.change_payment_type` | Switch an order between cash and borrowed (note required) | `orders.view` | ● | — | ● |
| Orders | `orders.record_payment` | Record customer payments (against an order or general) and reverse own same-day payment | `orders.view`, `customers.view` | ● | — | ● |
| Orders | `orders.credit` | Record customer credits and refunds (note required) | `orders.view`, `customers.view` | — | — | ● |
| Customers | `customers.view` | See customers (scoped to assigned unless `customers.view_all`) | — | ● | — | ● |
| Customers | `customers.view_all` | See all customers and all orders, not only assigned ones | `customers.view` | — | — | ● |
| Customers | `customers.create` | Create customers | `customers.view` | ● | — | — |
| Customers | `customers.edit` | Edit, deactivate/reactivate customers | `customers.view` | ● | — | — |
| Customers | `customers.assign` | Change a customer's assigned employee | `customers.view` | — | — | — |
| Customers | `customers.opening_balance` | Record a customer's opening balance | `customers.view`, `fields.see_customer_balances` | — | — | ● |
| Companies | `companies.view` | See companies list and profiles (balances require `fields.see_company_balances`) | — | — | ● | ● |
| Companies | `companies.create` | Create companies | `companies.view` | — | — | ● |
| Companies | `companies.edit` | Edit, deactivate/reactivate companies; change settlement currency (admin only) | `companies.view` | — | — | ● |
| Companies | `companies.assign` | Change a company's assigned employee | `companies.view` | — | — | — |
| Companies | `companies.set_rate` | Set the company's exchange rate | `companies.view` | — | — | ● |
| Companies | `companies.record_payment` | Record payments to a company; reverse own same-day payment | `companies.view`, `fields.see_company_balances` | — | — | ● |
| Companies | `companies.adjust_owed` | Manually adjust what we owe (note required) | `companies.view`, `fields.see_company_balances` | — | — | ● |
| Companies | `companies.record_credit` | Record a credit for goods returned to a company | `companies.view`, `fields.see_company_balances` | — | — | ● |
| Companies | `companies.opening_balance` | Record a company's opening balance | `companies.view`, `fields.see_company_balances` | — | — | ● |
| Damaged items | `damages.view` | See the Damaged items page and records | — | ● | ● | ● |
| Damaged items | `damages.create` | Record damage | `damages.view`, `materials.view` | ● | ● | — |
| Damaged items | `damages.edit` | Edit a damage record (quantity, reason, attribution, returnable) | `damages.view` | — | ● | — |
| Damaged items | `damages.void` | Void a damage record with a reason | `damages.view` | — | — | — |
| Damaged items | `damages.mark_returned` | Mark returned / written off (credit needs `companies.record_credit`) | `damages.view` | — | ● | ● |
| History | `history.view` | See the History page (own actions only unless `history.view_all`) | — | ● | ● | ● |
| History | `history.view_all` | See everyone's actions | `history.view` | — | — | ● |
| History | `history.export` | Export History (**Proposed — not requested**) | `history.view` | — | — | — |
| Reports | `reports.view` | See the Reports page (own data only unless `reports.view_all`) | — | ● | — | ● |
| Reports | `reports.view_all` | Reports across all employees | `reports.view` | — | — | ● |
| Reports | `reports.export` | Export reports (**Proposed — not requested**) | `reports.view` | — | — | — |
| Settings | `settings.set_global_rate` | Set the global default exchange rate | — | — | — | ● |
| Dashboard | `dashboard.view` | See the Dashboard (**Proposed — not requested**) | — | ● | ● | ● |
| Fields | `fields.see_bought_price` | See bought prices, purchase amounts, stock value, damage value | — | — | ● | ● |
| Fields | `fields.see_profit` | See the Profit report and margins | `fields.see_bought_price` | — | — | ● |
| Fields | `fields.see_company_balances` | See company balances, ledgers and payables | — | — | — | ● |
| Fields | `fields.see_customer_balances` | See customer balances, ledgers and receivables (**Proposed — not requested**: a fourth flag for symmetry with the three in the brief; if cut, customer balances follow `customers.view`) | — | ● | — | ● |

Rules that apply to the whole catalog:

1. Users, permissions, system settings other than the global rate, deletes and settlement-currency changes are **admin-only** and have no grantable key (A-28, Q-24).
2. Personal settings (device preferences, own password, own PIN) need no permission.
3. Every user may always see their own History entries through "My activity" on their profile, even without `history.view` (it is their own audit trail); the History *page* still needs `history.view`.
4. Voiding is separated from editing on purpose: a preset never includes a void key; admins grant it individually. The only exception is the creator's 8-second Undo right after saving (a logged void with reason "undo"), which is part of the create permission (section 3.1, principle 5).
5. A key that is turned on turns on its implied keys; turning off a `*.view` key turns off every key of that page.

### 1.5.3 Presets

| Preset | Intended for | Summary of the set (see ● marks above) |
|---|---|---|
| **Sales** | Employees who sell on the floor and collect money | Orders (view, create, edit, change payment type, record payment), Customers (view assigned only, create, edit), Materials view, Damaged (view, create), History own, Reports own, Dashboard; sees customer balances, not bought prices |
| **Warehouse** | Storekeepers who receive material and handle damage | Materials (view, create, edit, opening stock), Purchases (view, create, edit), Companies view, Damaged (view, create, edit, mark returned), History own, Dashboard; sees bought prices, not balances |
| **Accountant** | The person who settles with companies and follows debts | Companies (all money actions, set rate, opening balances), Purchases view, Orders (view, change payment type, record payment, credit), Customers (view all, opening balance), Materials (view, set prices), History all, Reports all, global rate; sees every field flag |

Applying a preset is a starting point; the admin can then toggle any key (FR-105). Presets are code constants with a version, so the editor can show "differs from preset". The default editor shows the preset plus six everyday extras that map to fixed key groups — *can void* (`orders.void`, `purchases.void`, `damages.void`), *sees bought prices* (`fields.see_bought_price`), *sees all customers* (`customers.view_all`), *sees balances* (`fields.see_company_balances`, `fields.see_customer_balances`), *can adjust what we owe* (`companies.adjust_owed`, `companies.record_credit`), *can set exchange rates* (`companies.set_rate`, `settings.set_global_rate`) — and the full grid under "Advanced" (FR-204). An extra is shown *on* only when every key in its group is granted, *partly* (indeterminate, "see Advanced") when some are — a Sales employee, whose preset grants customer balances but not company balances, shows "Sees balances: partly" — and turning an extra off is refused with an inline note while another granted key still implies one of its keys (for example `purchases.create` implies bought prices).

## 1.6 Trilingual glossary (for client sign-off)

The glossary is the single source of domain terms for the message catalogs (FR-1204). Arabic follows Iraqi usage where it differs from formal Arabic (e.g. زبون rather than عميل). Kurdish Sorani terms use the standard Sorani orthography (ە، ێ، ۆ، ڕ، ڵ، ڤ). **Every row needs a tick from the client's native speakers**; where two candidates are common we list the alternative in the note and ask the client to choose (Q-26). The critical row is the separation of **Order** (sale to a customer) from **Purchase** (buying from a company): the three languages must never use one word for both.

| # | English (`en`) | Arabic (`ar-IQ`) | Kurdish Sorani (`ckb-IQ`) | Used for / note | Client OK |
|---|---|---|---|---|---|
| 1 | Material (item) | مادة | کەرەستە | Page "Materials" = المواد / کەرەستەکان. Alternative Kurdish: کاڵا (goods). | ☐ |
| 2 | Add material | إضافة مادة | زیادکردنی کەرەستە | The client's "page to add material"; it creates a Purchase. | ☐ |
| 3 | **Purchase** (from a company) | **شراء** | **کڕین** | Buying from a supplier. Never "طلب" / "ئۆردەر". List: المشتريات / کڕینەکان. | ☐ |
| 4 | **Order** (sale to a customer) | **طلب بيع** | **فرۆشتن** | Selling to a customer. Alternative Arabic: قائمة بيع; Kurdish loanword ئۆردەر is avoided unless the client prefers it. List: طلبات البيع / فرۆشتنەکان. | ☐ |
| 5 | Customer | زبون | کڕیار | Alternative Arabic: عميل. | ☐ |
| 6 | Supplier company / Company | شركة (مورّدة) | کۆمپانیا (دابینکەر) | Page "Companies" = الشركات / کۆمپانیاکان. | ☐ |
| 7 | Cash (payment type) | نقد | نەقد | Chip on orders. Kurdish colloquial: کاش. | ☐ |
| 8 | Borrowed (on credit) | آجل (دين) | قەرز | Chip on orders. The client's word "borrowed". | ☐ |
| 9 | Payment type | نوع الدفع | جۆری پارەدان | Order form field. | ☐ |
| 10 | Payment (received from a customer) | دفعة مستلمة | پارەی وەرگیراو | Customer ledger. | ☐ |
| 11 | Payment (paid to a company) | دفعة مدفوعة | پارەی دراو | Company ledger; "what we paid" = ما دفعناه / ئەوەی داومانە. | ☐ |
| 12 | Record payment | تسجيل دفعة | تۆمارکردنی پارەدان | Primary action. | ☐ |
| 13 | Paid | مدفوع | دراوە | Status chip. | ☐ |
| 14 | Unpaid | غير مدفوع | نەدراوە | Status chip. | ☐ |
| 15 | Partially paid | مدفوع جزئياً | بەشێکی دراوە | Status chip. | ☐ |
| 16 | We owe (to a company) | علينا | قەرزی ئێمە | "how much we owe" = كم علينا / چەند قەرزدارین. | ☐ |
| 17 | Owed to us (by a customer) | لنا | قەرزی کڕیار | Customer balance label. | ☐ |
| 18 | Balance | الرصيد | باڵانس | Alternative Kurdish: ماوە (remaining). | ☐ |
| 19 | Running balance | الرصيد الجاري | باڵانسی بەردەوام | Ledger column. | ☐ |
| 20 | Opening balance | الرصيد الافتتاحي | باڵانسی سەرەتایی | Go-live entries. | ☐ |
| 21 | Opening stock | المخزون الافتتاحي | کۆگای سەرەتایی | Go-live entries. | ☐ |
| 22 | Stock / In stock | المخزون / بالمخزون | کۆگا / لە کۆگادا | Material card. | ☐ |
| 23 | Quantity | الكمية | بڕ | Generic. | ☐ |
| 24 | Count (pieces) | العدد (قطعة) | ژمارە (دانە) | Line field. | ☐ |
| 25 | Weight (kg) | الوزن (كغم) | کێش (کگم) | Line field; the client's "kgs". | ☐ |
| 26 | Per piece | للقطعة | بۆ هەر دانەیەک | Pricing unit. | ☐ |
| 27 | Per kg | للكيلو | بۆ هەر کیلۆیەک | Pricing unit. | ☐ |
| 28 | Unit price | سعر الوحدة | نرخی یەکە | Line field. | ☐ |
| 29 | Bought price | سعر الشراء | نرخی کڕین | Monthly price; field-level permission. | ☐ |
| 30 | Sale price | سعر البيع | نرخی فرۆشتن | Monthly price. | ☐ |
| 31 | Monthly prices | الأسعار الشهرية | نرخە مانگانەکان | Material tab. | ☐ |
| 32 | Line total (total per item) | مجموع المادة | کۆی کاڵا | The client's "total per item in the order". | ☐ |
| 33 | Total | المجموع | کۆی گشتی | Order/purchase total. | ☐ |
| 34 | Notes | ملاحظات | تێبینییەکان | Everywhere. | ☐ |
| 35 | Reason | السبب | هۆکار | Damage record, void. | ☐ |
| 36 | Date bought | تاريخ الشراء | بەرواری کڕین | Derived on material. | ☐ |
| 37 | Date sold | تاريخ البيع | بەرواری فرۆشتن | Derived on material. | ☐ |
| 38 | Date paid | تاريخ الدفع | بەرواری پارەدان | Payment field. | ☐ |
| 39 | Who made the payment | من دفع | کێ پارەی داوە | Payment field ("done by"). | ☐ |
| 40 | Damaged | تالف | زیانلێکەوتوو | Chip. Alternative Kurdish: خراپبوو. | ☐ |
| 41 | Damaged items | المواد التالفة | کاڵا زیانلێکەوتووەکان | Page title. | ☐ |
| 42 | Us (the factory) | نحن (المعمل) | ئێمە (کارگە) | Attribution option. | ☐ |
| 43 | The company it came from | الشركة المصدر | کۆمپانیای سەرچاوە | Attribution option. | ☐ |
| 44 | Returnable | قابل للإرجاع | دەگەڕێنرێتەوە | Flag. | ☐ |
| 45 | Not returnable | غير قابل للإرجاع | ناگەڕێنرێتەوە | Flag. | ☐ |
| 46 | Returned | مُرجَع | گەڕێنراوەتەوە | Status. | ☐ |
| 47 | Written off | مشطوب | بە زیان تۆمارکراو | Status. | ☐ |
| 48 | Void (annul a record) | إبطال / مُبطَل | هەڵوەشاندنەوە / هەڵوەشێنراوە | Distinct from "Cancel" (a form). | ☐ |
| 49 | Cancel (a form) | إلغاء | پاشگەزبوونەوە | Secondary button. | ☐ |
| 50 | Adjustment (manual change of owed amount) | تعديل الرصيد | ڕاستکردنەوەی باڵانس | The client's "change how much you owe". | ☐ |
| 51 | Credit (reduces what is owed) | إشعار دائن (ينقص المستحق) | کەمکردنەوەی قەرز | Returns; customer credits. "خصم" is reserved for *discount* (row 91). | ☐ |
| 52 | Refund | استرجاع مبلغ | گەڕاندنەوەی پارە | Money returned to a customer. | ☐ |
| 53 | Reversal | قيد عكسي | پێچەوانەکردنەوە | Ledger entry type (shown in ledgers only). | ☐ |
| 54 | Exchange rate | سعر الصرف | نرخی ئاڵوگۆڕ | Rate fields; "IQD per USD". | ☐ |
| 55 | Company rate | سعر صرف الشركة | نرخی ئاڵوگۆڕی کۆمپانیا | Company profile. | ☐ |
| 56 | Global default rate | سعر الصرف العام | نرخی ئاڵوگۆڕی گشتی | Settings. | ☐ |
| 57 | Settlement currency | عملة الحساب | دراوی حیساب | Company/customer profile. | ☐ |
| 58 | Iraqi dinar (IQD) | دينار عراقي (د.ع) | دیناری عێراقی (د.ع) | Symbol د.ع after the number. | ☐ |
| 59 | US dollar (USD) | دولار أمريكي ($) | دۆلاری ئەمریکی ($) | Symbol $ ; placement per locale (2.10.5). | ☐ |
| 60 | History | السجل | مێژوو | Page title and tabs. | ☐ |
| 61 | Reports | التقارير | ڕاپۆرتەکان | Page title. | ☐ |
| 62 | Sales report | تقرير المبيعات | ڕاپۆرتی فرۆشتن | | ☐ |
| 63 | Purchases report | تقرير المشتريات | ڕاپۆرتی کڕین | | ☐ |
| 64 | Profit | الربح | قازانج | Field-level permission. | ☐ |
| 65 | Customers owe us (receivables) | ما لنا على الزبائن | قەرزی کڕیاران بۆ ئێمە | No accounting jargon in the UI. | ☐ |
| 66 | We owe companies (payables) | ما علينا للشركات | قەرزی ئێمە بۆ کۆمپانیاکان | | ☐ |
| 67 | Employee activity | نشاط الموظفين | چالاکی کارمەندان | Report. | ☐ |
| 68 | Users | المستخدمون | بەکارهێنەران | Admin page. | ☐ |
| 69 | Admin | مدير النظام | بەڕێوەبەر | Role. | ☐ |
| 70 | Employee | موظف | کارمەند | Role. | ☐ |
| 71 | Permissions | الصلاحيات | دەسەڵاتەکان | Editor. | ☐ |
| 72 | Preset | قالب صلاحيات | قاڵبی دەسەڵات | Editor. | ☐ |
| 73 | Assigned to | مُسنَد إلى | سپێردراوە بە | Assignment (reading (a) of R-16). | ☐ |
| 74 | Done by | بواسطة | لەلایەن | Acting employee (reading (b) of R-16). | ☐ |
| 75 | Active / Deactivated | نشط / معطّل | چالاک / ناچالاک | Users, customers, companies, materials. | ☐ |
| 76 | Settings | الإعدادات | ڕێکخستنەکان | Page title. | ☐ |
| 77 | Theme: Light / Dark / Follow device | المظهر: فاتح / داكن / حسب الجهاز | ڕووکار: ڕوون / تاریک / بەپێی ئامێر | Settings. | ☐ |
| 78 | Font size: Small / Default / Large / Extra large | حجم الخط: صغير / افتراضي / كبير / كبير جداً | قەبارەی فۆنت: بچووک / ئاسایی / گەورە / زۆر گەورە | Settings. | ☐ |
| 79 | Language | اللغة | زمان | Settings; names shown in their own script. | ☐ |
| 80 | Numerals | الأرقام | ژمارەکان | Settings. | ☐ |
| 81 | This device / Shared device | هذا الجهاز / جهاز مشترك | ئەم ئامێرە / ئامێری هاوبەش | Settings. | ☐ |
| 82 | Lock / Unlock | قفل / فتح القفل | داخستن / کردنەوە | Lock screen. | ☐ |
| 83 | Switch user | تبديل المستخدم | گۆڕینی بەکارهێنەر | Lock screen. | ☐ |
| 84 | PIN | رمز PIN | کۆدی PIN | Quick unlock. | ☐ |
| 85 | Search | بحث | گەڕان | Everywhere. | ☐ |
| 86 | Save / Undo / Edit | حفظ / تراجع / تعديل | پاشەکەوتکردن / گەڕانەوە / دەستکاریکردن | Buttons. | ☐ |
| 87 | Walk-in customer (**Proposed — not requested**) | زبون نقدي | کڕیاری نەقد | System customer for unnamed cash sales; only if kept. | ☐ |
| 88 | Dashboard (**Proposed — not requested**) | لوحة المعلومات | داشبۆرد | Only if kept. | ☐ |
| 89 | Export (**Proposed — not requested**) | تصدير | هەناردەکردن | Only if kept. | ☐ |
| 90 | Mizan (product name) | ميزان | میزان | Working name; Q-01. | ☐ |
| 91 | Discount / round down (**Proposed — not requested**) | خصم / تقريب للأدنى | داشکاندن / خڕکردنەوە بۆ خوارەوە | Order-level discount, FR-616. | ☐ |
| 92 | Receipt (order) (**Proposed — not requested**) | وصل | پسوولە | FR-613. | ☐ |
| 93 | Payment voucher (**Proposed — not requested**) | سند قبض / سند صرف | پسوولەی وەرگرتن / پسوولەی پارەدان | Received / paid, FR-614. | ☐ |
| 94 | Account statement (**Proposed — not requested**) | كشف حساب | کەشفی حیساب | FR-615. | ☐ |
| 95 | Settle in full | تسديد كامل | یەکلاکردنەوەی تەواو | FR-606, FR-705. | ☐ |
| 96 | Rate for this document | سعر الصرف لهذه العملية | نرخی ئاڵوگۆڕی ئەم مامەڵەیە | Per-deal rate, section 2.3.3. | ☐ |
| 97 | Paid in (currency received) | مدفوع بـ | پارەدراوە بە | Cash orders, FR-604. | ☐ |
| 98 | Period lock (**Proposed — not requested**) | إقفال الفترة | داخستنی ماوە | FR-1109. | ☐ |
| 99 | Daily cash-up (**Proposed — not requested**) | جرد الصندوق اليومي | ژمێرەی ڕۆژانەی سندوق | FR-1013. | ☐ |

Month names: Arabic uses the Iraqi/Levantine names (كانون الثاني، شباط، آذار، نيسان، أيار، حزيران، تموز، آب، أيلول، تشرين الأول، تشرين الثاني، كانون الأول). Kurdish Sorani uses the Kurdish names of the Gregorian months as commonly used in Iraqi Kurdistan (کانوونی دووەم، شوبات، ئازار، نیسان، ئایار، حوزەیران، تەممووز، ئاب، ئەیلوول، تشرینی یەکەم، تشرینی دووەم، کانوونی یەکەم) — to confirm (Q-04). Weekday names start with Saturday (السبت / شەممە).

## 1.7 Out of scope for v1

These are excluded from v1 by decision, not by omission. Each can be added later without changing the v1 data model (section 2.15 explains what keeps them cheap).

1. Lot/batch tracking of materials (which purchase a sold item physically came from).
2. Multiple warehouses or locations; stock is one pool.
3. Multi-company or multi-tenant operation.
4. Full offline mode with synchronisation; v1 is online-only with graceful degradation (FR-1305).
5. Double-entry accounting presentation (debits/credits, chart of accounts) in the UI; ledgers are shown in plain language.
6. E-mail or SMS notifications and reminders.
7. Self-service password recovery (no e-mail); the admin resets passwords.
8. Integrations with external accounting software, banks, or payment gateways.
9. Barcode/QR scanning and label printing.
10. Manufacturing/bill-of-materials (converting materials into products); Mizan tracks bought and sold materials only.
11. Customer-facing portal or public pages.
12. Native mobile apps; the web app is used on phones.

## 1.8 Proposed — not requested (consolidated list)

Everything below was added by us, is labelled at every appearance, and can be removed without touching a client requirement.

| Item | Where it appears | Why we propose it |
|---|---|---|
| Dashboard / home page | FR-1310, page map 3.3, I4 (optional) | Gives every role a useful first screen; costs one page. |
| Global search across materials, customers, companies | FR-1309, 3.3, I4 (optional) | Fast access on phones; reuses the script-normalised search already built. |
| Exports (CSV/Excel/PDF) of reports and History | FR-1012, permissions `reports.export`/`history.export`, 2.11, I4 (optional) | Clients usually ask for it after go-live; the design reserves permission keys so it can be added cleanly. |
| CSV import of opening data | FR-1312, I6 | Faster go-live if the client has lists in Excel. |
| Material code/SKU and low-stock threshold | FR-310 | Convenience only. |
| Order receipt (print/share) | FR-613 | Customers often want paper; cheap once the order screen exists. |
| Receivables ageing buckets | FR-1007 | Standard collections view. |
| Installable PWA shortcut with static caching | FR-1313 | Faster launches on the floor; no offline data. |
| "Walk-in customer" system record | FR-501, FR-604, A-33, glossary row 87 | Lets cash sales to unnamed buyers be recorded without inventing customers; if cut, every order names a real customer. |
| Fourth field flag `fields.see_customer_balances` | 1.5.2, FR-503, FR-1007 | Symmetry with "see company balances"; if cut, customer balances are visible to anyone with `customers.view`. |
| Payment vouchers with sequential numbers | FR-614, `voucher_number`, I1/I2 | سند قبض / سند صرف are expected for every cash movement; strongly recommended. |
| Account statements | FR-615, I1/I2 | كشف حساب is how debts are chased; strongly recommended. |
| Order-level discount / round down, customer credit limit | FR-616, `discount_*`, `credit_limit_*` | Rounding a total down is daily practice; a credit limit is asked for in week one. |
| Payment method and split IQD/USD payments | FR-617, `method` | Cash vs transfer, and one payment in two currencies. |
| Daily cash-up per employee | FR-1013, `/reports/cash-up` | "How much IQD and USD should each employee hand over tonight?" |
| Period lock | FR-1109, `locked_through` | Stops back-dating and past-month edits from silently changing reports already read. |
| Stale-rate prompt | FR-1106 | A forgotten customer-side rate skews every USD figure. |
| Month-start price banner | FR-306 | Reminds to copy last month's prices. |
| Profit "recompute with current prices" toggle and actual-average-cost column | FR-1005 | Comparison views over the snapshot-based margin. |

## 1.9 Assumptions

Each assumption states the decision built into this document and the design choice that keeps it cheap to reverse.

| # | Assumption | Reversal cost / design hedge |
|---|---|---|
| A-01 | The palette system's frontend is React 18 + TypeScript on Vite with React Router, TanStack Query, react-i18next (i18next) and an internal component library (referred to here as `@factory/ui`, built on accessible headless primitives and CSS variables). Mizan uses the same. | If the real libraries differ, only section 2.10 wording changes; the architecture is library-agnostic (tokens, message keys, query hooks). |
| A-02 | The backend is NestJS (TypeScript) with Prisma on PostgreSQL 15+, `argon2` for passwords and schema-based validation (zod/class-validator). | Any Node framework works; the ledger/money module is plain TypeScript. |
| A-03 | Hosting mirrors the palette system: Docker Compose on a Linux VPS behind Nginx/Caddy with Let's Encrypt TLS, PostgreSQL on the same host, off-site backup copies to object storage. | Section 2.14 lists what changes for a PaaS. |
| A-04 | The palette system uses cookie-based sessions; Mizan uses server-side opaque sessions in an httpOnly cookie. | If the palette uses JWTs, the session table still exists for revocation and lock state; only the transport changes. |
| A-05 | Working product name "Mizan"; identity built on a deep plum primary with warm neutral surfaces. | Name and colours are tokens and strings; changeable in one file each. |
| A-06 | The palette system's exact hex is unknown beyond "blue/teal"; Mizan's primary (hue ≈ 320°) is at least 90° away from any blue (≈ 200–250°) or teal (≈ 170–190°). | If the palette turns out to be purple-ish blue, switch Mizan to the alternative warm identity in 3.2.6. |
| A-07 | First visit on a new browser starts in Kurdish Sorani. | One constant. |
| A-08 | Gregorian calendar, Saturday week start, dd/MM/yyyy, Asia/Baghdad. | System settings for week start and date format. |
| A-09 | Western digits by default in all three languages; Eastern Arabic-Indic digits as a per-device setting. | One preference key. |
| A-10 | IQD stored as whole dinars (scale 0), USD as cents (scale 2), rates as IQD per USD with 4 decimals; rounding half away from zero at the line and entry level. | Scales are constants in the money module; a migration multiplies stored integers if scale changes. |
| A-11 | Volumes per NFR-13; concurrency handled by optimistic locking and append-only ledgers. | Indices and pagination sized for 10× the design point. |
| A-12 | Online-only with graceful degradation; no offline sync in v1. | Idempotency keys and drafts already exist, which is the base of a later offline queue. |
| A-13 | "Two themes" means light and dark. | Token-based theming supports any second colour scheme. |
| A-14 | Language, theme, font size and numerals are stored per browser in localStorage, as the client asked; on shared tablets, employees share them. | A per-user override could be added as a nullable account field later. |
| A-15 | "Who assigns to who" = (a) admin assigns customers (and optionally companies) to employees and (b) every action records the acting employee; (c) permissions are covered by the permission model. Filters offer both "assigned to" and "done by". | Assignment is one nullable column per table; scoping is one permission key. |
| A-16 | Each material has one pricing unit (per kg or per piece); the other measure is informational. | A per-line "priced measure" snapshot means a later "price both ways" option only adds a choice on the line. |
| A-17 | Monthly prices are entered manually (with "copy last month"); when a month has no price the latest earlier month's price is carried forward silently with a small marker (a warning only when no price exists at all); the monthly bought price is not derived from purchases. | An effective-dated price table with a derived monthly view is the cleaner engine if the client agrees; a derived (average) bought price can be added as a report column first. |
| A-18 | Amounts are entered in one currency; the other is calculated at the applicable rate and can be overridden; both values and the rate are stored; nothing is recomputed later. | Core rule of the money model; not intended to be reversed. |
| A-19 | "Add material" creates a purchase; a purchase without a company is allowed and creates no debt. | — |
| A-20 | Each company (and each customer) has a settlement currency; the balance is the sum of that currency's column, shown in the other currency only as ≈ at the current rate. Customers default to IQD. Changing the currency always writes an explicit re-basing entry (at an agreed rate when the balance is not zero) so the new column never shows a mixed-rate sum (2.3.5). | Settlement currency is a column; the ledger stores both currencies on every row, so the re-basing entry is the only cost of a switch. |
| A-21 | Borrowed orders accept multiple (partial) payments; payment type can be switched with a note. | If the client does not want partial payments, hide the amount field and pre-fill the full balance. |
| A-22 | "Date sold" and "date bought" on materials are derived. | — |
| A-23 | Damage attribution "order" means a customer order (came back damaged) and also allows a supplier purchase (arrived damaged); "us" is internal; "company" is the supplier; no lot tracking. | — |
| A-24 | Every order creates a receivable entry; cash orders add an immediate cash-settlement entry; status is derived from the order's entries. | Presentation hides these entries unless the ledger is opened. |
| A-25 | Orders and purchases are editable by the creator/admin (or with the edit permission) while no manual payment is linked and the period is not locked; the admin may add a day-count window; otherwise void with a note and re-enter; edits and voids write compensating movements and the creator has an 8-second undo. | Window rules are settings (`order_edit_window_days`, `purchase_edit_window_days`, `allow_edit_after_payment`, `locked_through`). |
| A-26 | Opening balances are dated ledger entries with notes, entered per material, customer and company at go-live. | CSV import is Proposed. |
| A-27 | Sign-in with username or phone + password; admins create and reset; an admin cannot deactivate or demote themselves; at least one active admin always exists. | — |
| A-28 | User and permission management is admin-only and not delegable to employees. | Adding `users.*` keys later is additive. |
| A-29 | "How much we owe per order (purchase)" is shown per purchase: explicitly linked entries first, then unlinked payments and credits allocated oldest-first for display; opening balances, unlinked adjustments, settlement changes, entries of voided purchases and the unallocated remainder form the "General" bucket; Σ remaining + General = balance. | The allocation is presentation only, never stored, so the rule can change without data migration. |
| A-30 | Damage attributed to a customer order does not move stock; other attributions reduce stock. | A per-record "affects stock" flag is stored on the movement, so the rule can change without data migration. |
| A-31 | Return to a supplier creates a credit that reduces what we owe (stock unchanged); goods a customer returned damaged do not change the customer's balance unless a credit is recorded. | Both are explicit actions with permissions. |
| A-32 | Soft delete everywhere; even the admin-only delete of an unreferenced record only sets `deleted_at`; nothing is physically removed. | — |
| A-33 | A system "Walk-in customer" record exists for cash sales to unnamed buyers (**Proposed — not requested**). | Can be removed if the client always names customers. |
| A-34 | Selling below stock is allowed with a warning; a system setting can block it. | One setting. |
| A-35 | Idle lock after 5 minutes on shared devices and 30 minutes otherwise; optional 4–6 digit PIN for unlocking. | Two settings; PIN is optional. |
| A-36 | Rates are expressed as IQD per 1 USD (e.g. 1,310). | Display only; the stored number is the same. |
| A-37 | Monthly prices convert the calculated currency at the global default rate at the time of entry. | A per-price manual override is stored. |
| A-38 | Past months' prices can be edited by users with `materials.set_prices`; existing lines keep their snapshots. | — |
| A-39 | Credits for supplier returns are valued at the linked purchase line's bought price, or the month's bought price when no purchase is linked, editable before saving. | — |
| A-40 | The team supplies no calendar dates; iterations are sized relatively (S/M/L). | — |
| A-41 | The entered currency of a line is authoritative: its total is unit price × measure; the other currency's line total is that amount converted at the document rate (never a rounded other unit price × quantity). | One rule in the `money` module. |
| A-42 | Each order line snapshots the material's bought price for the order month at save time; the Profit report reads the snapshot, so it is reproducible. | A "recompute with current prices" view is Proposed. |
| A-43 | Running balances follow posting order so they match History's before → after; date-sorted views show an "as of" balance instead. | Presentation only. |
| A-44 | Sessions: shared devices 12 h with a 4 h grace after locking; personal devices 30 days with PIN/password unlock; PIN quick sign-in is device-bound, 6 digits on shared devices, and can be disabled by the admin; every session and audit row records the authentication method. | All are settings. |

## 1.10 Open questions for the client (with the default designed for)

| # | Question | Default if unanswered |
|---|---|---|
| Q-01 | Is "Mizan" (ميزان / میزان) acceptable as the product name, and what exactly are the palette system's name and primary colour (hex)? | Mizan; plum identity per section 3.2. |
| Q-02 | Real volumes: orders and purchases per day, number of materials, customers, companies, employees, devices? | NFR-13 design point. |
| Q-03 | Should a new browser start in Kurdish Sorani? | Yes. |
| Q-04 | Week starts on Saturday? Date format dd/MM/yyyy? Are the Kurdish month names in section 1.6 the ones you use? | Saturday; dd/MM/yyyy; listed names. |
| Q-05 | "Who assigns to who": do you want customers assigned to employees, and should employees see only their assigned customers unless the admin allows more? Should companies also be assignable? | Both built; scoping via `customers.view_all`; companies assignable without scoping. |
| Q-06 | Is one pricing unit per material right (per kg or per piece), with the other measure recorded for information? Any material priced both ways? | One pricing unit per material. |
| **Q-37 — blocking for I1** | Do you think of materials as a **catalog** (one "Copper wire 2 mm" with a price list per month and a running stock — our reading) or as **batches** (each purchase is its own lot with its own bought price, "date bought" and "date sold" when it is gone)? We will settle this in a 30-minute session with a paper mock of both Materials pages before I1 starts. | Catalog with monthly prices; batch tracking stays out of v1 (section 2.15). |
| Q-07 | Monthly bought price: typed at the start of the month, or derived from actual purchases (average)? Should sale prices be typed per month or can they change any time? | Typed per month with "copy last month"; sale prices per month with per-line override. |
| Q-08 | Should an employee who may not see bought prices see purchases at all (quantities, companies, dates)? | Yes, without amounts. |
| Q-09 | Is a settlement currency per company (IQD or USD) right? Do customers settle in IQD by default, with USD payments converted at the global rate? | Yes to both. |
| Q-10 | Do you need partial payments on borrowed orders and general (unallocated) customer payments, or only "mark as paid"? | Partial and general payments supported. |
| Q-11 | Company rate: is it "IQD per 1 USD", who may set it, and how often does it change? | IQD per USD; accountant preset; unlimited changes with history. |
| Q-12 | Is it acceptable that cash orders appear in the customer's ledger as an order plus a cash settlement, and that unnamed cash buyers go to a "Walk-in customer"? | Yes. |
| Q-13 | Editing orders and purchases: allowed by the creator or admin while unpaid and while the period is not locked (no same-day limit unless you want one); otherwise void with a reason and re-enter? | As stated; a day-count limit is a setting. |
| Q-14 | How will opening balances be entered: typed by the admin, or from Excel/CSV lists (Proposed import)? | Typed. |
| Q-15 | May an employee sell more than the recorded stock (with a warning), or must it be blocked? | Warn and allow. |
| Q-16 | Damage attributed to a customer order: no stock change (goods were already sold)? Damage attributed to "us" or to a company: reduce stock? Should "order" also allow attributing to a supplier purchase (arrived damaged)? | As stated; yes. |
| Q-17 | When damaged goods are returned to a company, should what we owe them be reduced automatically (with an editable amount)? When a customer returns damaged goods, should their debt be reduced only when an employee records a credit? | Yes; yes. |
| Q-18 | "How much we owe per order and items": is "per purchase" (total, paid against it, remaining) plus line totals per material what you mean? Should lump-sum payments be applied to the oldest purchases first when they are not linked to one? | Yes; optional link; oldest-first display for unlinked payments. |
| Q-19 | "Two themes" = light and dark? | Yes. |
| Q-20 | Default digits: Western (0–9) or Eastern Arabic-Indic (٠–٩)? | Western, switchable. |
| Q-21 | Is online-only acceptable on the floor, with retry and draft protection, or is offline entry required in v1? | Online-only. |
| Q-22 | Which phones, tablets and browsers are in use (Android versions, iPads)? | NFR-09 list. |
| Q-23 | Which Proposed items do you want: order receipt, payment vouchers, account statements, discount / round down, credit limit, payment method and split payments, daily cash-up, period lock, dashboard, global search, exports, CSV import, material code and low-stock badge, ageing buckets, home-screen install, stale-rate prompt, month-start price banner? | Receipt, vouchers, statements, discount, cash-up and period lock strongly recommended; the rest built as listed unless cut. |
| Q-24 | Should any employee be able to manage users or permissions, or only admins? | Admins only. |
| Q-25 | Idle lock after 5 minutes on shared tablets and 30 minutes elsewhere, with an optional PIN for quick unlock? | As stated. |
| Q-26 | Glossary: please tick each row in section 1.6 and choose between alternatives (زبون/عميل, طلب بيع/قائمة بيع, فرۆشتن/ئۆردەر, کەرەستە/کاڵا, باڵانس/ماوە). | Left column terms. |
| Q-27 | Where may off-site backups be stored (cloud object storage) and who holds the admin credentials and the backup encryption key? | Object storage in the same region as hosting; two named admins. |
| Q-28 | Are USD unit prices with two decimals enough (e.g. $0.85 per kg), or do you price in fractions of a cent? | Two decimals. |
| Q-29 | Do payments need a method (cash / bank transfer / other), and do customers sometimes pay one debt partly in IQD and partly in USD? | Both offered as FR-617 (Proposed); if cut, the note field is used and two payments are recorded. |
| Q-30 | Should the customer-side rate be one global rate, or could some customers have their own rate like companies? | Global rate (a per-customer rate is a nullable column away). |
| Q-31 | Entering amounts: you type one currency and the other is calculated at the applicable rate — may the calculated value be overridden by hand (stored as a manual rate), or should it be locked? | Overridable, marked "manual". |
| Q-32 | "Add material" creates a purchase; a purchase with no company (opening stock, cash buy) is allowed and creates no debt — correct? | Yes. |
| Q-33 | "Date bought" and "date sold" on a material are derived from purchases and orders (never typed) — correct? | Derived. |
| Q-34 | Sign-in with username or phone + password, no e-mail, passwords reset only by an admin, and an admin can never remove their own admin rights — acceptable? | Yes. |
| Q-35 | Language, theme and font size are saved per device (browser), so on a shared tablet everyone shares them and a new browser starts from defaults — acceptable, or should they follow the user's account? | Per device, as requested. |
| Q-36 | Nothing is ever physically deleted: records are deactivated or voided and stay in history; only an admin can hide (soft-delete) an unreferenced record — acceptable? | Yes. |

---

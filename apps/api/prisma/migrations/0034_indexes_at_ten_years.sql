-- Performance review at ten years of data (D-075) — the indexes the rewritten queries read, and
-- the ones nothing reads.
--
-- Every index below was chosen by EXPLAIN (ANALYZE, BUFFERS) on the ten-year volume database
-- (1.8 million orders, 2.6 million buys, 3.65 million audit rows). Every drop follows the rule of
-- migration 0020: an index is paid for on every INSERT for ever, so one that is never chosen goes
-- — but only after dropping it inside a transaction and re-planning the queries that could have
-- wanted it, and the fallback plan is written beside the drop.

-- ── the lists, newest first (Orders, Purchases, Accounts › Sales) ──
--
-- Every list is ordered by (date DESC, number DESC). The date-only indexes left the planner an
-- incremental sort on top, and a deep page walked the date index and sorted each day's orders;
-- with both columns the page's ids come straight off the index (the page-first queries, D-075).
-- Date ranges (reports, the dashboard trend, Accounts) lead with the same column and read this
-- index exactly as they read the old one.
CREATE INDEX orders_date_number_idx ON orders (order_date DESC, number DESC);
DROP INDEX orders_date_idx;
CREATE INDEX purchases_date_number_idx ON purchases (purchase_date DESC, number DESC);
DROP INDEX purchases_date_idx;

-- ── voided documents ──
--
-- `orders_status_idx` and `purchases_status_idx` indexed a two-value column over every row and
-- were chosen 3 times in the reviewer's whole sweep — each time for the one question they can
-- answer, "the voided ones", which is a sliver of the table. A partial index of just the voided
-- documents, in the list's order, answers that question better and costs nothing for an active
-- document. The Orders list's Void filter now says `o.status = 'void'` in so many words so it can
-- use it; `purchases.status = 'void'` already did. An active-only query never used either index
-- (active is almost every row: a sequential or date-index read is cheaper).
CREATE INDEX orders_void_idx ON orders (order_date DESC, number DESC) WHERE status = 'void';
DROP INDEX orders_status_idx;
CREATE INDEX purchases_void_idx ON purchases (purchase_date DESC, number DESC) WHERE status = 'void';
DROP INDEX purchases_status_idx;

-- ── who created a document ──
--
-- `orders_creator_idx` and `purchases_creator_idx` (created_by, date DESC): **0 scans** in the
-- reviewer's sweep, 15 MB each at ten years. No query filters or sorts by `created_by` — the
-- "done by" filter reads `acting_user_id`, served by `orders_acting_idx`/`purchases_acting_idx`;
-- `created_by` is only ever read from a row already found by its primary key (the edit-window
-- rule of FR-610). Re-planned without them: nothing changed.
DROP INDEX orders_creator_idx;
DROP INDEX purchases_creator_idx;

-- ── what is still owed on an order ──
--
-- `order_remaining_owed_idx` (remaining_iqd, remaining_usd_cents): chosen **twice** in the sweep
-- — no query asks for a range of amounts. What is asked is "which orders still owe something",
-- which the Orders list's status filter, its totals and the dashboard's unpaid tile now spell
-- `remaining_iqd > 0 OR remaining_usd_cents > 0` (D-075): a partial index of exactly those rows,
-- covering both amounts, so the owing orders are read without the paid ones.
CREATE INDEX order_remaining_owing_idx ON order_remaining (order_id) INCLUDE (remaining_iqd, remaining_usd_cents)
  WHERE remaining_iqd > 0 OR remaining_usd_cents > 0;
DROP INDEX order_remaining_owed_idx;

-- ── the lines of a period's documents (Accounts › Materials, the sales and profit reports) ──
--
-- The lines of an order, with every column a period total reads, from the index alone. It
-- replaces two: `order_lines_margin_idx` (the same key, fewer columns — the materials tab had to
-- visit the heap for the quantities) and `order_lines_order_idx`, which was the same key with no
-- columns at all, a strict duplicate (every query that chose it re-plans onto this one: the
-- line count of a list row, `linesOf`, the damage pickers).
CREATE INDEX order_lines_order_cover_idx ON order_lines (order_id)
  INCLUDE (item_id, priced_measure, qty_count, qty_kg, line_total_iqd, line_total_usd_cents,
           margin_iqd, margin_usd_cents, cost_source)
  WHERE deleted_at IS NULL;
DROP INDEX order_lines_margin_idx;
DROP INDEX order_lines_order_idx;

CREATE INDEX purchase_lines_purchase_cover_idx ON purchase_lines (purchase_id)
  INCLUDE (item_id, priced_measure, qty_count, qty_kg, line_total_iqd, line_total_usd_cents)
  WHERE deleted_at IS NULL;
DROP INDEX purchase_lines_purchase_idx;

-- ── Payables: one index range per company ──
--
-- The report reads each company's rows from the start of the period on (the balance is the
-- maintained total less what came after the range, migration 0033). The same key as
-- `company_ledger_date_idx`, carrying what the report sums, so the range is read from the index
-- alone — as `customer_ledger_receivables_idx` already does for Receivables.
CREATE INDEX company_ledger_payables_idx ON company_ledger (company_id, entry_date)
  INCLUDE (entry_type, amount_iqd, amount_usd_cents);
DROP INDEX company_ledger_date_idx;

-- ── History by action, and the employee-activity report ──
--
-- "Show me the voids" compared the text of every audit row's action, newest first, until it had
-- a page: 823 ms at 3.65 million rows. Compared as the enum (D-075) it is a range of this index;
-- the employee-activity report counts voids and sign-ins over a period from the same index.
CREATE INDEX audit_log_action_idx ON audit_log (action, occurred_at DESC, id DESC);

-- ── search: the notes of an order or a purchase ──
--
-- The Orders and Purchases searches are now a union of three index reads (the account's name,
-- the notes, the number). The name and the number had theirs; the notes did not, so every search
-- read every order's notes. Trigram, as the names are (0001), so "contains" is indexed.
CREATE INDEX orders_notes_trgm_idx ON orders USING gin (notes gin_trgm_ops) WHERE notes IS NOT NULL;
CREATE INDEX purchases_notes_trgm_idx ON purchases USING gin (notes gin_trgm_ops) WHERE notes IS NOT NULL;

-- ── stock totals: let the counter update in place ──
--
-- `item_stock_totals_levels_idx` (stock_count, stock_kg): **0 scans**, and 43 MB for 5,000 rows,
-- because every stock movement changes both indexed columns, so no update of this table could
-- ever be HOT and each left a dead index entry behind. The low-stock tile compares each
-- material's stock with its own minimum — a join over all 5,000 rows, primary key and heap; with
-- the index dropped inside a transaction the tile's plan and time did not change. Without it,
-- and with room left on each page (fillfactor 70; existing pages take it as they are rewritten
-- by vacuum), the trigger's update is a heap-only tuple: no index write at all.
DROP INDEX item_stock_totals_levels_idx;
ALTER TABLE item_stock_totals SET (fillfactor = 70);

ANALYZE orders;
ANALYZE purchases;
ANALYZE order_lines;
ANALYZE purchase_lines;
ANALYZE order_remaining;
ANALYZE company_ledger;
ANALYZE audit_log;

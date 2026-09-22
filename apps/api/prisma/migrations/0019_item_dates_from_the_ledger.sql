-- Iteration 6 review — the two dates of FR-304 read from the stock ledger.
--
-- "First bought" and "last sold" were the last two per-material figures computed from the
-- documents rather than from the ledger: `last_sold_on` was `max(order_date)` over every active
-- line of that material, joined to its order. At the design point of NFR-13 — 1,227,007 order
-- lines over 5,014 materials, so roughly 245 lines each — that is 245 index entries plus 245
-- random heap lookups **per material shown**, and it is the reason the Stock report still spent
-- 200 of its 430 ms after the maintained stock sum of 0017, and the materials list 280 ms of
-- its 300 ms budget. In ten years of trading it is ten times that.
--
-- A sale always writes a `sale_out` movement dated with the order (2.2.4), a void writes its
-- reversal, and an edit that removes a line writes a correction — so the ledger already knows
-- both dates, and asking it is one index scan with a `LIMIT 1` instead of an aggregate over a
-- material's whole trading history. It is also the rule the system is built on: stock questions
-- are answered by the stock ledger (rule 2).

-- Newest movement of a kind, per material: what both dates need, and what the reversal check
-- rides along on.
CREATE INDEX stock_ledger_item_kind_date_idx
  ON stock_ledger (item_id, movement_type, entry_date DESC);

CREATE OR REPLACE VIEW item_stats AS
SELECT st.*,
       (SELECT s.entry_date
          FROM stock_ledger s
         WHERE s.item_id = st.item_id
           AND s.movement_type IN ('purchase_in', 'opening')
           AND NOT EXISTS (SELECT 1 FROM stock_ledger r WHERE r.reverses_entry_id = s.id)
         ORDER BY s.entry_date ASC
         LIMIT 1
       ) AS first_bought_on,
       (SELECT s.entry_date
          FROM stock_ledger s
         WHERE s.item_id = st.item_id
           AND s.movement_type = 'sale_out'
           AND NOT EXISTS (SELECT 1 FROM stock_ledger r WHERE r.reverses_entry_id = s.id)
         ORDER BY s.entry_date DESC
         LIMIT 1
       ) AS last_sold_on
  FROM item_stock st;

ANALYZE stock_ledger;

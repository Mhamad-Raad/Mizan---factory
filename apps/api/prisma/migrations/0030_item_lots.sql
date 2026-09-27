-- What is left of every buy, kept true to the stock (review of 2026-09-27).
--
-- A buy's remaining quantity was its quantity less what sales and damages took from it
-- (`lot_allocations`). Stock can also leave without taking from a buy — a sale past every buy
-- (negative stock is a warning, A-34), a stock correction — and then the buys said more was
-- left than the stock ledger: the Stock report valued goods that were gone, and the next sale
-- took "phantom" units at their price.
--
-- `item_lots` keeps that remaining figure, and trims it so the buys never hold more than the
-- material's stock on hand: the excess comes off the oldest buys first, as first-in-first-out
-- says it would have been taken. Stock with no buy behind it (opening stock, a return) is the
-- other way round and needs no trim — it is simply not costed from a buy.
--
-- One definition, read by the sale planner, the material page and the Stock report alike.

CREATE VIEW item_lots AS
WITH raw AS (
  SELECT l.id AS purchase_line_id,
         l.item_id,
         p.id AS purchase_id,
         p.number AS purchase_number,
         p.purchase_date,
         l.line_no,
         (CASE WHEN l.priced_measure = 'count' THEN l.qty_count::numeric ELSE l.qty_kg END) AS quantity,
         coalesce((SELECT sum(a.qty) FROM lot_allocations a WHERE a.purchase_line_id = l.id), 0) AS taken,
         l.unit_price_iqd,
         l.unit_price_usd_cents,
         l.line_total_iqd,
         l.line_total_usd_cents,
         l.price_entered_currency,
         l.rate_iqd_per_usd
    FROM purchase_lines l
    JOIN purchases p ON p.id = l.purchase_id
   WHERE l.deleted_at IS NULL AND p.status = 'active' AND p.deleted_at IS NULL
),
ranked AS (
  SELECT raw.*,
         greatest(raw.quantity - raw.taken, 0) AS untaken,
         sum(greatest(raw.quantity - raw.taken, 0)) OVER (
           PARTITION BY raw.item_id ORDER BY raw.purchase_date, raw.purchase_number, raw.line_no
           ROWS UNBOUNDED PRECEDING
         ) AS running,
         sum(greatest(raw.quantity - raw.taken, 0)) OVER (PARTITION BY raw.item_id) AS untaken_total
    FROM raw
)
SELECT r.purchase_line_id, r.item_id, r.purchase_id, r.purchase_number, r.purchase_date, r.line_no,
       r.quantity, r.taken, r.unit_price_iqd, r.unit_price_usd_cents, r.line_total_iqd,
       r.line_total_usd_cents, r.price_entered_currency, r.rate_iqd_per_usd,
       -- What the buys hold beyond the stock on hand comes off the oldest first.
       greatest(0, least(r.untaken, r.running - greatest(r.untaken_total - greatest(coalesce(
         CASE WHEN i.pricing_unit = 'per_piece' THEN st.stock_count::numeric ELSE st.stock_kg END, 0), 0), 0)))
         AS remaining
  FROM ranked r
  JOIN items i ON i.id = r.item_id
  LEFT JOIN item_stock_totals st ON st.item_id = r.item_id;

GRANT SELECT ON item_lots TO mizan_app;

-- What each buy has given out, answered from the index alone: the view above sums it for
-- every buy of a material on every sale line (the review's scale finding).
CREATE INDEX lot_allocations_line_qty_idx ON lot_allocations (purchase_line_id) INCLUDE (qty);
DROP INDEX lot_allocations_line_idx;
-- Never read by any query (the index-bloat lesson of migration 0020).
DROP INDEX lot_allocations_item_idx;
-- A material's buys, oldest first, without touching the ones deleted.
CREATE INDEX purchase_lines_item_live_idx ON purchase_lines (item_id) WHERE deleted_at IS NULL;

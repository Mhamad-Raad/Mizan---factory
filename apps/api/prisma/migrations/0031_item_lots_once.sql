-- Two follow-ups of the review of 2026-09-27.
--
-- 1. `item_lots` summed each buy's allocations once for every place the view used the sum:
--    the planner inlines the CTE and repeated the correlated subquery three or four times per
--    buy, on every sale line and every Stock report row. The sum is now one lateral join,
--    computed once. Same columns, same meaning (migration 0030).

CREATE OR REPLACE VIEW item_lots AS
WITH raw AS (
  SELECT l.id AS purchase_line_id,
         l.item_id,
         p.id AS purchase_id,
         p.number AS purchase_number,
         p.purchase_date,
         l.line_no,
         (CASE WHEN l.priced_measure = 'count' THEN l.qty_count::numeric ELSE l.qty_kg END) AS quantity,
         coalesce(a.taken, 0) AS taken,
         l.unit_price_iqd,
         l.unit_price_usd_cents,
         l.line_total_iqd,
         l.line_total_usd_cents,
         l.price_entered_currency,
         l.rate_iqd_per_usd
    FROM purchase_lines l
    JOIN purchases p ON p.id = l.purchase_id
    LEFT JOIN LATERAL (SELECT sum(qty) AS taken FROM lot_allocations WHERE purchase_line_id = l.id) a ON true
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
       greatest(0, least(r.untaken, r.running - greatest(r.untaken_total - greatest(coalesce(
         CASE WHEN i.pricing_unit = 'per_piece' THEN st.stock_count::numeric ELSE st.stock_kg END, 0), 0), 0)))
         AS remaining
  FROM ranked r
  JOIN items i ON i.id = r.item_id
  LEFT JOIN item_stock_totals st ON st.item_id = r.item_id;

-- 2. Phones typed as "0964 750…" were stored as 0964750…; the normalising rule now reads that
--    spelling as 0750… (review), so the rows already stored are brought to the same spelling —
--    except where that would collide with another active user's phone, which stays for an
--    admin to settle.
UPDATE users u
   SET phone = '0' || substr(u.phone, 5)
 WHERE u.phone ~ '^0964[0-9]+$'
   AND NOT EXISTS (SELECT 1 FROM users o
                    WHERE o.id <> u.id AND o.deleted_at IS NULL AND o.phone = '0' || substr(u.phone, 5));

UPDATE customers
   SET phone_normalized = '0' || substr(phone_normalized, 5)
 WHERE phone_normalized ~ '^0964[0-9]+$';

-- Mizan · An order's total rounds up to the next 250 dinars (client review, D-065)
--
-- The client: "the totals … for IQD … automatically rounded to 250s — 630 should turn to 750 —
-- which will affect the USD price as well … only for the order total, not the items' sale prices
-- … but mention that it was rounded".
--
-- What was added to reach the round figure is stored on the order in both currencies (rule 1),
-- so the total still reads as lines − discount + rounding, the order can say "rounded up by
-- 120 د.ع", and a report can tell sales from rounding. Orders saved before this keep a rounding
-- of zero: a stored total is never recalculated (rule 1).

ALTER TABLE orders
  ADD COLUMN rounding_iqd bigint NOT NULL DEFAULT 0,
  ADD COLUMN rounding_usd_cents bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT orders_rounding_not_negative CHECK (rounding_iqd >= 0 AND rounding_usd_cents >= 0);

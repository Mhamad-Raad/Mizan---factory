-- Voiding or restoring a purchase flips `live` on its buys' open-lot rows (migration 0033). The
-- trigger found those buys by `purchase_id` alone, and after 0034 the only index on that column
-- is partial (`WHERE deleted_at IS NULL`), so every void scanned every purchase line ever
-- written — 2.6 million at ten years — while holding the materials' locks (review).
--
-- A replaced line (`deleted_at` set by an edit) is never live whatever the purchase's status, so
-- leaving it out changes nothing but the plan: the lookup is an index range again.

CREATE OR REPLACE FUNCTION mizan_lot_purchase_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE lot_balances b
     SET live = NEW.status = 'active' AND NEW.deleted_at IS NULL,
         updated_at = now()
    FROM purchase_lines l
   WHERE l.purchase_id = NEW.id AND l.deleted_at IS NULL AND b.purchase_line_id = l.id;
  RETURN NEW;
END;
$$;

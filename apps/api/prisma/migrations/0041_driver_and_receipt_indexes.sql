-- Review of the final business edits (D-114): indexes that keep two new reads flat at ten years.

-- An order's receipt counts the account's earlier orders still owed (D-109): the account's active
-- orders numbered before this one. Without a (customer, number) key that read walked every order
-- the account ever placed, through the date index, on every printed sale.
CREATE INDEX orders_customer_number_idx ON orders (customer_id, number)
  WHERE status = 'active' AND deleted_at IS NULL;

-- A driver's page sums every document the driver carried (D-105, D-106). The driver indexes now
-- carry what that sum reads, so it stays an index-only pass instead of one heap fetch a document.
DROP INDEX orders_driver_idx;
CREATE INDEX orders_driver_idx ON orders (driver_id, order_date DESC, number DESC)
  INCLUDE (status, total_iqd, total_usd_cents)
  WHERE driver_id IS NOT NULL AND deleted_at IS NULL;

DROP INDEX purchases_driver_idx;
CREATE INDEX purchases_driver_idx ON purchases (driver_id, purchase_date DESC, number DESC)
  INCLUDE (status, total_iqd, total_usd_cents)
  WHERE driver_id IS NOT NULL AND deleted_at IS NULL;

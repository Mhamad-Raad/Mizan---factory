-- Drivers on purchases (D-106): the driver who brings a purchase in, as an order names the one who
-- takes it out (D-105). Optional, like the order's.

ALTER TABLE purchases ADD COLUMN driver_id uuid REFERENCES drivers (id);

-- A driver's purchases, newest first, and Buying & selling narrowed to one driver.
CREATE INDEX purchases_driver_idx ON purchases (driver_id, purchase_date DESC, number DESC) WHERE driver_id IS NOT NULL;

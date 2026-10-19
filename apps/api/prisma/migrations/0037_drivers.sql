-- Drivers (D-105): the people who take an order to the company, as in the Pallet system.
--
-- A driver is a name, a phone and a car number. An order may name one (optional: the walk-in and
-- the companies that collect their own goods need none), and changing it is part of editing the
-- order. A driver is never deleted — orders keep naming them — only deactivated, after which they
-- can no longer be chosen for an order.

CREATE TABLE drivers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  name_normalized  text NOT NULL,
  phone            text,
  phone_normalized text,
  -- Free text: plate formats differ between governorates.
  car_number       text,
  notes            text,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL REFERENCES users (id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid NOT NULL REFERENCES users (id),
  deleted_at       timestamptz,
  deleted_by       uuid REFERENCES users (id),
  version          integer NOT NULL DEFAULT 1,
  CONSTRAINT drivers_name_length CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT drivers_phone_length CHECK (phone IS NULL OR length(phone) <= 40),
  CONSTRAINT drivers_car_number_length CHECK (car_number IS NULL OR length(car_number) <= 50),
  CONSTRAINT drivers_notes_length CHECK (notes IS NULL OR length(notes) <= 2000)
);

-- Same names are allowed (two drivers called Ahmad); the phone is what tells them apart, and a
-- second driver with a phone already in use is a warning, not a refusal.
CREATE INDEX drivers_name_trgm_idx ON drivers USING gin (name_normalized gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX drivers_name_idx ON drivers (name_normalized, id) WHERE deleted_at IS NULL;
CREATE INDEX drivers_phone_idx ON drivers (phone_normalized) WHERE phone_normalized IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE orders ADD COLUMN driver_id uuid REFERENCES drivers (id);

-- A driver's orders, newest first, and the Buying & selling list narrowed to one driver: the same
-- (date, number) order the lists page by, so either reads one index range.
CREATE INDEX orders_driver_idx ON orders (driver_id, order_date DESC, number DESC) WHERE driver_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON drivers TO mizan_app;
REVOKE DELETE, TRUNCATE ON drivers FROM mizan_app;

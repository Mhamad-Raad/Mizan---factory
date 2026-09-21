-- Mizan · Iteration 3 · Damaged items and returns
--
-- One table, and most of the thinking is in its constraints. Three rules from 2.2.3 and 2.5.1
-- are written here rather than trusted to the application:
--
--   · the attribution and its links agree — a record attributed to a customer order names an
--     order and nothing else, a company-attributed one names a company and may name the
--     purchase the goods arrived in, and "us" or "none" names neither (FR-802);
--   · the stock effect follows the attribution: `none` exactly when the goods were already
--     sold, `reduced` otherwise, and `returned_in` only after the explicit "Return to stock"
--     on a customer-order record (A-30, 2.5.1);
--   · the return status agrees with the returnable flag: `not_returnable` exactly when the
--     goods cannot go back (FR-803).
--
-- Damage never writes money by itself. A return to a supplier becomes a `company_ledger`
-- credit and a customer's returned goods a `customer_ledger` credit, both naming this record
-- through the `damage_id` column Iterations 1 and 2 already carry (A-31, FR-805, FR-806).

-- ─────────────────────────────── sequence (2.2.1) ───────────────────────────────

CREATE SEQUENCE damage_number_seq AS bigint START 1;  -- "Damage #17"

-- ────────────────────────────── damages (FR-801 to FR-807) ──────────────────────────────

CREATE TABLE damages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number              bigint NOT NULL DEFAULT nextval('damage_number_seq'),
  item_id             uuid NOT NULL REFERENCES items (id),
  -- At least one measure, both allowed: the priced one drives the value, the other is recorded
  -- when it was counted (2.2.3, FR-302).
  qty_count           integer,
  qty_kg              numeric(12,3),
  damage_date         date NOT NULL,
  acting_user_id      uuid NOT NULL REFERENCES users (id),
  reason              text,
  attribution         damage_attribution NOT NULL DEFAULT 'none',
  order_id            uuid REFERENCES orders (id),
  company_id          uuid REFERENCES companies (id),
  purchase_id         uuid REFERENCES purchases (id),
  is_returnable       boolean NOT NULL DEFAULT false,
  return_status       return_status NOT NULL DEFAULT 'not_returnable',
  returned_at         timestamptz,
  returned_by         uuid REFERENCES users (id),
  stock_effect        stock_effect NOT NULL,
  -- The value this damage represents, snapshotted at the month's bought price when it is
  -- recorded, so a later price change cannot rewrite what a period lost (FR-807, A-39).
  est_value_iqd       bigint,
  est_value_usd_cents bigint,
  est_value_source    cost_source NOT NULL DEFAULT 'none',
  status              doc_status NOT NULL DEFAULT 'active',
  void_reason         text,
  voided_by           uuid REFERENCES users (id),
  voided_at           timestamptz,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL REFERENCES users (id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid NOT NULL REFERENCES users (id),
  deleted_at          timestamptz,
  deleted_by          uuid REFERENCES users (id),
  version             integer NOT NULL DEFAULT 1,

  CONSTRAINT damages_carries_a_measure CHECK (
    (qty_count IS NOT NULL AND qty_count > 0) OR (qty_kg IS NOT NULL AND qty_kg > 0)
  ),
  CONSTRAINT damages_measures_positive CHECK (
    (qty_count IS NULL OR qty_count > 0) AND (qty_kg IS NULL OR qty_kg > 0)
  ),

  -- The attribution and its links agree in both directions (FR-802).
  CONSTRAINT damages_attribution_links CHECK (
    CASE attribution
      WHEN 'customer_order' THEN order_id IS NOT NULL AND company_id IS NULL AND purchase_id IS NULL
      WHEN 'company' THEN company_id IS NOT NULL AND order_id IS NULL
      ELSE order_id IS NULL AND company_id IS NULL AND purchase_id IS NULL
    END
  ),

  -- Stock is untouched exactly when the goods had already left it (A-30); `returned_in` is
  -- reachable only from there, through the explicit action of FR-804.
  CONSTRAINT damages_stock_effect CHECK (
    (attribution = 'customer_order') = (stock_effect IN ('none', 'returned_in'))
  ),

  -- The status agrees with the flag: goods that cannot go back are `not_returnable` and
  -- nothing else (FR-803).
  CONSTRAINT damages_return_status CHECK (
    (return_status = 'not_returnable') = (is_returnable = false)
  ),
  CONSTRAINT damages_returned_pair CHECK ((returned_at IS NULL) = (returned_by IS NULL)),
  CONSTRAINT damages_returned_when_status CHECK (
    return_status IN ('returned', 'returned_credited', 'written_off') OR returned_at IS NULL
  ),
  -- A credited return is a company matter: a customer-order record is never "returned &
  -- credited", because nothing went back to a supplier (FR-805, FR-806).
  CONSTRAINT damages_credited_needs_company CHECK (
    return_status <> 'returned_credited' OR attribution = 'company'
  ),

  CONSTRAINT damages_value_pair CHECK ((est_value_iqd IS NULL) = (est_value_usd_cents IS NULL)),
  CONSTRAINT damages_value_source CHECK (
    (est_value_source = 'none') = (est_value_iqd IS NULL)
  ),
  CONSTRAINT damages_void_reason CHECK (
    status <> 'void' OR length(btrim(coalesce(void_reason, ''))) > 0
  ),
  CONSTRAINT damages_reason_length CHECK (reason IS NULL OR length(reason) <= 2000),
  CONSTRAINT damages_notes_length CHECK (notes IS NULL OR length(notes) <= 2000)
);

CREATE UNIQUE INDEX damages_number_key ON damages (number);
CREATE INDEX damages_date_idx ON damages (damage_date DESC);
CREATE INDEX damages_item_idx ON damages (item_id, damage_date DESC);
CREATE INDEX damages_company_idx ON damages (company_id, damage_date DESC)
  WHERE company_id IS NOT NULL;
CREATE INDEX damages_order_idx ON damages (order_id, damage_date DESC) WHERE order_id IS NOT NULL;
CREATE INDEX damages_purchase_idx ON damages (purchase_id) WHERE purchase_id IS NOT NULL;
CREATE INDEX damages_return_status_idx ON damages (return_status, damage_date DESC);
CREATE INDEX damages_acting_idx ON damages (acting_user_id, damage_date DESC);
-- The list's period totals sum the quantities and the snapshot value of the page's filter, so
-- the sum is an index-only scan rather than a walk of the table (the I2 review's pattern 2).
CREATE INDEX damages_totals_idx ON damages (damage_date)
  INCLUDE (qty_count, qty_kg, est_value_iqd, est_value_usd_cents)
  WHERE status = 'active' AND deleted_at IS NULL;

-- The money links that were declared before the table existed (0006, 0008) become real.
ALTER TABLE customer_ledger
  ADD CONSTRAINT customer_ledger_damage_fk FOREIGN KEY (damage_id) REFERENCES damages (id);
ALTER TABLE company_ledger
  ADD CONSTRAINT company_ledger_damage_fk FOREIGN KEY (damage_id) REFERENCES damages (id);

CREATE INDEX customer_ledger_damage_idx ON customer_ledger (damage_id) WHERE damage_id IS NOT NULL;
CREATE INDEX company_ledger_damage_idx ON company_ledger (damage_id) WHERE damage_id IS NOT NULL;

-- ─────────────────────────── the damage totals of a period (FR-807) ───────────────────────────
-- Quantities and the snapshot value of the active records of one month, by material. The view
-- is the definition; the list computes its own totals for the filters it was given.

CREATE VIEW damage_totals AS
SELECT d.item_id,
       date_trunc('month', d.damage_date)::date AS month,
       count(*)                                  AS records,
       coalesce(sum(d.qty_count), 0)             AS qty_count,
       coalesce(sum(d.qty_kg), 0)                AS qty_kg,
       coalesce(sum(d.est_value_iqd), 0)         AS est_value_iqd,
       coalesce(sum(d.est_value_usd_cents), 0)   AS est_value_usd_cents
  FROM damages d
 WHERE d.status = 'active' AND d.deleted_at IS NULL
 GROUP BY d.item_id, date_trunc('month', d.damage_date);

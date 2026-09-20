-- Mizan · Iteration 1 · Materials, customers and orders (selling)
--
-- The tables of specification 2.2.3 that I1 needs, the indices and check constraints of
-- 2.2.5, the derived views of 2.2.6 and the settings this iteration makes editable.
--
-- Two rules shape every line below:
--   · money is a pair of integers in minor units plus the rate that filled the calculated
--     side, and nothing stored is ever recomputed from a later rate (2.3.2);
--   · customer_ledger, stock_ledger, global_rates and order_payment_type_changes are
--     append-only — no `updated_by`, no `deleted_at`, corrections are reversal rows (2.2.1).

-- ───────────────────────────────── sequences (2.2.1) ─────────────────────────────────
-- Human-facing numbers and posting order. Gaps from rolled-back transactions are expected
-- and documented (2.9.5).

CREATE SEQUENCE order_number_seq    AS bigint START 1001;  -- "Order #1042"
CREATE SEQUENCE voucher_number_seq  AS bigint START 1;     -- Proposed — not requested (FR-614)
CREATE SEQUENCE customer_ledger_seq AS bigint START 1;     -- posting order, one per ledger
CREATE SEQUENCE stock_ledger_seq    AS bigint START 1;

-- ──────────────────────── global_rates (append-only, FR-1106) ────────────────────────
-- The customer-side rate. Current rate = the row with the latest effective_from ≤ now().

CREATE TABLE global_rates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_iqd_per_usd numeric(14,4) NOT NULL,
  effective_from   timestamptz NOT NULL DEFAULT now(),
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL REFERENCES users (id),
  CONSTRAINT global_rates_positive CHECK (rate_iqd_per_usd > 0)
);

CREATE INDEX global_rates_effective_idx ON global_rates (effective_from DESC);

-- ─────────────────────────────────── items (FR-301) ───────────────────────────────────

CREATE TABLE items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  name_normalized text NOT NULL,
  code            text,                    -- Proposed — not requested (FR-310)
  pricing_unit    pricing_unit NOT NULL,
  min_stock_count integer,                 -- Proposed — not requested (FR-310)
  min_stock_kg    numeric(12,3),           -- Proposed — not requested (FR-310)
  notes           text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL REFERENCES users (id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid NOT NULL REFERENCES users (id),
  deleted_at      timestamptz,
  deleted_by      uuid REFERENCES users (id),
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT items_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT items_notes_length CHECK (notes IS NULL OR length(notes) <= 2000),
  CONSTRAINT items_min_stock_positive CHECK (
    (min_stock_count IS NULL OR min_stock_count >= 0) AND (min_stock_kg IS NULL OR min_stock_kg >= 0)
  )
);

-- Unique among the rows that still exist; a soft-deleted material must not hold a name
-- hostage, and the comparison is on the normalised form so the same name typed on an
-- Arabic and a Kurdish keyboard collides (FR-301, FR-1205).
CREATE UNIQUE INDEX items_name_key ON items (name_normalized) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX items_code_key ON items (code) WHERE code IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX items_name_trgm_idx ON items USING gin (name_normalized gin_trgm_ops);
CREATE INDEX items_active_idx ON items (is_active) WHERE deleted_at IS NULL;

-- ──────────────────────────── item_month_prices (FR-305) ────────────────────────────
-- One bought and one sale price per material per calendar month, each a stored pair plus
-- the rate that filled the calculated side (2.3.2, A-37).

CREATE TABLE item_month_prices (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id                 uuid NOT NULL REFERENCES items (id),
  month                   date NOT NULL,
  bought_iqd              bigint,
  bought_usd_cents        bigint,
  bought_entered_currency currency,
  bought_rate             numeric(14,4),
  sale_iqd                bigint,
  sale_usd_cents          bigint,
  sale_entered_currency   currency,
  sale_rate               numeric(14,4),
  note                    text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid NOT NULL REFERENCES users (id),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid NOT NULL REFERENCES users (id),
  deleted_at              timestamptz,
  deleted_by              uuid REFERENCES users (id),
  version                 integer NOT NULL DEFAULT 1,
  CONSTRAINT item_month_prices_month_is_first CHECK (extract(day FROM month) = 1),
  -- A money value is a pair or it is absent; half a pair would be a price in one currency,
  -- which no screen may show (FR-1302, 2.3.2).
  CONSTRAINT item_month_prices_bought_pair CHECK (
    (bought_iqd IS NULL AND bought_usd_cents IS NULL AND bought_entered_currency IS NULL AND bought_rate IS NULL)
    OR (bought_iqd IS NOT NULL AND bought_usd_cents IS NOT NULL
        AND bought_entered_currency IS NOT NULL AND bought_rate IS NOT NULL AND bought_rate > 0)
  ),
  CONSTRAINT item_month_prices_sale_pair CHECK (
    (sale_iqd IS NULL AND sale_usd_cents IS NULL AND sale_entered_currency IS NULL AND sale_rate IS NULL)
    OR (sale_iqd IS NOT NULL AND sale_usd_cents IS NOT NULL
        AND sale_entered_currency IS NOT NULL AND sale_rate IS NOT NULL AND sale_rate > 0)
  ),
  CONSTRAINT item_month_prices_not_negative CHECK (
    (bought_iqd IS NULL OR bought_iqd >= 0) AND (bought_usd_cents IS NULL OR bought_usd_cents >= 0)
    AND (sale_iqd IS NULL OR sale_iqd >= 0) AND (sale_usd_cents IS NULL OR sale_usd_cents >= 0)
  )
);

CREATE UNIQUE INDEX item_month_prices_key ON item_month_prices (item_id, month) WHERE deleted_at IS NULL;
-- The fallback of FR-306 is "the latest month ≤ this one", which this index serves as an
-- ordered backwards scan of one item's rows — no predicate wraps the column (review I0).
CREATE INDEX item_month_prices_lookup_idx ON item_month_prices (item_id, month DESC) WHERE deleted_at IS NULL;

-- ────────────────────────────────── customers (FR-501) ──────────────────────────────────

CREATE TABLE customers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  name_normalized       text NOT NULL,
  phone                 text,
  phone_normalized      text,
  address               text,
  notes                 text,
  settlement_currency   currency NOT NULL DEFAULT 'IQD',
  assigned_user_id      uuid REFERENCES users (id),
  -- true only for the "Walk-in customer" (Proposed — not requested, A-33): it cannot be
  -- deactivated, assigned, or given a borrowed order, and it has no ledger tab (2.4.5).
  is_system             boolean NOT NULL DEFAULT false,
  credit_limit_iqd      bigint,            -- Proposed — not requested (FR-616)
  credit_limit_usd_cents bigint,           -- Proposed — not requested (FR-616)
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid NOT NULL REFERENCES users (id),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid NOT NULL REFERENCES users (id),
  deleted_at            timestamptz,
  deleted_by            uuid REFERENCES users (id),
  version               integer NOT NULL DEFAULT 1,
  CONSTRAINT customers_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT customers_notes_length CHECK (notes IS NULL OR length(notes) <= 2000),
  CONSTRAINT customers_credit_limit_pair CHECK (
    (credit_limit_iqd IS NULL) = (credit_limit_usd_cents IS NULL)
  ),
  CONSTRAINT customers_credit_limit_not_negative CHECK (
    (credit_limit_iqd IS NULL OR credit_limit_iqd >= 0)
    AND (credit_limit_usd_cents IS NULL OR credit_limit_usd_cents >= 0)
  ),
  -- The walk-in customer is never assigned and never inactive (FR-501, FR-507).
  CONSTRAINT customers_system_not_assigned CHECK (NOT is_system OR (assigned_user_id IS NULL AND is_active))
);

-- Duplicate customer names are allowed with a warning (FR-501), so this is not unique.
CREATE INDEX customers_name_trgm_idx ON customers USING gin (name_normalized gin_trgm_ops);
CREATE INDEX customers_assigned_idx ON customers (assigned_user_id) WHERE deleted_at IS NULL;
CREATE INDEX customers_phone_idx ON customers (phone_normalized) WHERE phone_normalized IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX customers_system_singleton ON customers (is_system) WHERE is_system AND deleted_at IS NULL;

-- ──────────────────────────────────── orders (FR-601) ────────────────────────────────────

CREATE TABLE orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             bigint NOT NULL DEFAULT nextval('order_number_seq'),
  customer_id        uuid NOT NULL REFERENCES customers (id),
  order_date         date NOT NULL,
  acting_user_id     uuid NOT NULL REFERENCES users (id),
  payment_type       payment_type NOT NULL,
  notes              text,
  -- "Rate for this order": the global rate at creation unless one was typed per deal (2.3.3).
  rate_iqd_per_usd   numeric(14,4) NOT NULL,
  rate_source        rate_source NOT NULL,
  status             doc_status NOT NULL DEFAULT 'active',
  void_reason        text,
  voided_by          uuid REFERENCES users (id),
  voided_at          timestamptz,
  discount_iqd       bigint NOT NULL DEFAULT 0,   -- Proposed — not requested (FR-616)
  discount_usd_cents bigint NOT NULL DEFAULT 0,   -- Proposed — not requested (FR-616)
  -- Display cache, recomputed in the same transaction as the lines; the ledger entry copies
  -- these two values rather than converting one of them (2.3.4).
  total_iqd          bigint NOT NULL DEFAULT 0,
  total_usd_cents    bigint NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES users (id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid NOT NULL REFERENCES users (id),
  deleted_at         timestamptz,
  deleted_by         uuid REFERENCES users (id),
  version            integer NOT NULL DEFAULT 1,
  CONSTRAINT orders_rate_positive CHECK (rate_iqd_per_usd > 0),
  CONSTRAINT orders_rate_source_customer_side CHECK (rate_source IN ('global', 'manual')),
  CONSTRAINT orders_notes_length CHECK (notes IS NULL OR length(notes) <= 2000),
  CONSTRAINT orders_discount_not_negative CHECK (discount_iqd >= 0 AND discount_usd_cents >= 0),
  CONSTRAINT orders_void_has_reason CHECK (
    (status = 'active' AND void_reason IS NULL AND voided_by IS NULL AND voided_at IS NULL)
    OR (status = 'void' AND void_reason IS NOT NULL AND voided_by IS NOT NULL AND voided_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX orders_number_key ON orders (number);
CREATE INDEX orders_date_idx ON orders (order_date DESC);
CREATE INDEX orders_customer_idx ON orders (customer_id, order_date DESC);
CREATE INDEX orders_acting_idx ON orders (acting_user_id, order_date DESC);
CREATE INDEX orders_creator_idx ON orders (created_by, order_date DESC);
CREATE INDEX orders_status_idx ON orders (status);

-- ────────────────────────────────── order_lines (FR-602) ──────────────────────────────────
-- Lines are replaced as a set on edit: the old rows are soft-deleted, never overwritten, so
-- the movements and entries that reference them keep their meaning (2.5.3).

CREATE TABLE order_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid NOT NULL REFERENCES orders (id),
  line_no               integer NOT NULL,
  item_id               uuid NOT NULL REFERENCES items (id),
  qty_count             integer,
  qty_kg                numeric(12,3),
  priced_measure        measure NOT NULL,
  unit_price_iqd        bigint NOT NULL,
  unit_price_usd_cents  bigint NOT NULL,
  price_entered_currency currency NOT NULL,
  price_source          price_source NOT NULL,
  month_price_id        uuid REFERENCES item_month_prices (id),
  rate_iqd_per_usd      numeric(14,4) NOT NULL,
  rate_source           rate_source NOT NULL,
  line_total_iqd        bigint NOT NULL,
  line_total_usd_cents  bigint NOT NULL,
  -- Cost snapshot for the Profit report, taken at save time and never touched again (A-42).
  cost_unit_iqd         bigint,
  cost_unit_usd_cents   bigint,
  cost_month_price_id   uuid REFERENCES item_month_prices (id),
  cost_source           cost_source NOT NULL DEFAULT 'none',
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid NOT NULL REFERENCES users (id),
  deleted_at            timestamptz,
  CONSTRAINT order_lines_priced_measure_present CHECK (
    (priced_measure = 'count' AND qty_count IS NOT NULL AND qty_count > 0)
    OR (priced_measure = 'kg' AND qty_kg IS NOT NULL AND qty_kg > 0)
  ),
  CONSTRAINT order_lines_quantities_not_negative CHECK (
    (qty_count IS NULL OR qty_count >= 0) AND (qty_kg IS NULL OR qty_kg >= 0)
  ),
  CONSTRAINT order_lines_prices_not_negative CHECK (unit_price_iqd >= 0 AND unit_price_usd_cents >= 0),
  CONSTRAINT order_lines_rate_positive CHECK (rate_iqd_per_usd > 0),
  CONSTRAINT order_lines_cost_pair CHECK (
    ((cost_unit_iqd IS NULL) = (cost_unit_usd_cents IS NULL))
    AND ((cost_source = 'none') = (cost_unit_iqd IS NULL))
  )
);

CREATE INDEX order_lines_order_idx ON order_lines (order_id) WHERE deleted_at IS NULL;
CREATE INDEX order_lines_item_idx ON order_lines (item_id, created_at DESC);

-- ─────────────── order_payment_type_changes (append-only, FR-605) ───────────────

CREATE TABLE order_payment_type_changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES orders (id),
  from_type       payment_type NOT NULL,
  to_type         payment_type NOT NULL,
  note            text NOT NULL,
  ledger_entry_id uuid,                    -- the settlement or reversal row written
  changed_at      timestamptz NOT NULL DEFAULT now(),
  changed_by      uuid NOT NULL REFERENCES users (id),
  CONSTRAINT order_payment_type_changes_note_not_blank CHECK (length(btrim(note)) > 0),
  CONSTRAINT order_payment_type_changes_direction CHECK (from_type <> to_type)
);

CREATE INDEX order_payment_type_changes_order_idx ON order_payment_type_changes (order_id, changed_at DESC);

-- ─────────────────────── customer_ledger (append-only, 2.4.1) ───────────────────────
-- Sign convention: positive increases what the customer owes.

CREATE TABLE customer_ledger (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id          uuid NOT NULL REFERENCES customers (id),
  entry_type           customer_entry_type NOT NULL,
  amount_iqd           bigint NOT NULL,
  amount_usd_cents     bigint NOT NULL,
  entered_currency     currency,
  rate_iqd_per_usd     numeric(14,4) NOT NULL,
  rate_source          rate_source NOT NULL,
  posting_seq          bigint NOT NULL DEFAULT nextval('customer_ledger_seq'),
  entry_date           date NOT NULL,
  order_id             uuid REFERENCES orders (id),
  damage_id            uuid,               -- damages arrive in I3; the link exists now (2.2.3)
  reverses_entry_id    uuid REFERENCES customer_ledger (id),
  performed_by_user_id uuid NOT NULL REFERENCES users (id),
  note                 text,
  idempotency_key      text,
  voucher_number       bigint,             -- Proposed — not requested (FR-614)
  method               payment_method,     -- Proposed — not requested (FR-617)
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NOT NULL REFERENCES users (id),
  CONSTRAINT customer_ledger_rate_positive CHECK (rate_iqd_per_usd > 0),
  -- A reversal names the row it negates; nothing else may (2.4.1 rule 3).
  CONSTRAINT customer_ledger_reversal_link CHECK ((entry_type = 'reversal') = (reverses_entry_id IS NOT NULL)),
  -- Both amounts share one sign, because they are one amount expressed twice. The re-basing
  -- row is the single exception: it carries a zero in the old settlement currency (2.3.5).
  CONSTRAINT customer_ledger_one_sign CHECK (
    entry_type = 'settlement_change'
    OR (amount_iqd >= 0 AND amount_usd_cents >= 0)
    OR (amount_iqd <= 0 AND amount_usd_cents <= 0)
  ),
  CONSTRAINT customer_ledger_settlement_change_shape CHECK (
    entry_type <> 'settlement_change'
    OR (rate_source = 'manual' AND (amount_iqd = 0 OR amount_usd_cents = 0))
  ),
  -- Note required for the entry types a human explains (2.4.1 rule 4).
  CONSTRAINT customer_ledger_note_required CHECK (
    entry_type NOT IN ('credit', 'refund', 'adjustment', 'opening', 'reversal', 'settlement_change')
    OR length(btrim(coalesce(note, ''))) > 0
  ),
  CONSTRAINT customer_ledger_note_length CHECK (note IS NULL OR length(note) <= 2000)
);

CREATE INDEX customer_ledger_running_idx ON customer_ledger (customer_id, posting_seq);
-- Covering indices for the two sums that are read on every screen: a customer's balance and
-- an order's remaining amount. With the amounts in the index those sums are index-only scans,
-- which is what keeps a list page cheap after five years of rows (NFR-13, review measurement).
CREATE INDEX customer_ledger_balance_idx ON customer_ledger (customer_id) INCLUDE (amount_iqd, amount_usd_cents);
CREATE INDEX customer_ledger_order_sum_idx ON customer_ledger (order_id) INCLUDE (amount_iqd, amount_usd_cents)
  WHERE order_id IS NOT NULL;
CREATE INDEX customer_ledger_date_idx ON customer_ledger (customer_id, entry_date);
CREATE INDEX customer_ledger_order_idx ON customer_ledger (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX customer_ledger_performed_idx ON customer_ledger (performed_by_user_id, entry_date DESC);
CREATE UNIQUE INDEX customer_ledger_reverses_key ON customer_ledger (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE UNIQUE INDEX customer_ledger_idempotency_key ON customer_ledger (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX customer_ledger_voucher_key ON customer_ledger (voucher_number) WHERE voucher_number IS NOT NULL;

-- "A re-basing row is never reversed — a mistake is corrected by another currency change"
-- (2.3.5). The kernel refuses it with a friendly message; this trigger makes it impossible,
-- which is the point of 2.2.5: integrity that does not depend on application code.
CREATE FUNCTION customer_ledger_refuse_rebase_reversal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reverses_entry_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM customer_ledger
        WHERE id = NEW.reverses_entry_id
          AND entry_type IN ('settlement_change', 'reversal')
     )
  THEN
    RAISE EXCEPTION 'a % row cannot be reversed',
      (SELECT entry_type FROM customer_ledger WHERE id = NEW.reverses_entry_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_ledger_refuse_rebase_reversal
  BEFORE INSERT ON customer_ledger
  FOR EACH ROW EXECUTE FUNCTION customer_ledger_refuse_rebase_reversal();

-- ───────────────────────── stock_ledger (append-only, 2.5) ─────────────────────────
-- Sign convention: positive adds to stock. A null quantity means "this movement did not
-- carry that measure" and is never a stand-in for zero (2.2.3), because the other measure
-- is summed only while every movement carried it (FR-303).

CREATE TABLE stock_ledger (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id             uuid NOT NULL REFERENCES items (id),
  movement_type       stock_movement_type NOT NULL,
  qty_count           integer,
  qty_kg              numeric(12,3),
  posting_seq         bigint NOT NULL DEFAULT nextval('stock_ledger_seq'),
  ref_type            stock_ref_type,
  ref_id              uuid,
  reverses_entry_id   uuid REFERENCES stock_ledger (id),
  entry_date          date NOT NULL,
  unit_cost_iqd       bigint,
  unit_cost_usd_cents bigint,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL REFERENCES users (id),
  CONSTRAINT stock_ledger_carries_a_measure CHECK (qty_count IS NOT NULL OR qty_kg IS NOT NULL),
  CONSTRAINT stock_ledger_reversal_link CHECK ((movement_type = 'reversal') = (reverses_entry_id IS NOT NULL)),
  -- `manual` is the reference of an opening count or a correction: it names no document,
  -- so it is the one ref_type that carries no id (spec 2.5.1).
  CONSTRAINT stock_ledger_ref_pair CHECK (
    (ref_type IS NULL AND ref_id IS NULL)
    OR (ref_type = 'manual' AND ref_id IS NULL)
    OR (ref_type <> 'manual' AND ref_id IS NOT NULL)
  ),
  CONSTRAINT stock_ledger_unit_cost_pair CHECK ((unit_cost_iqd IS NULL) = (unit_cost_usd_cents IS NULL)),
  CONSTRAINT stock_ledger_note_required CHECK (
    movement_type NOT IN ('opening', 'adjustment', 'reversal') OR length(btrim(coalesce(note, ''))) > 0
  ),
  CONSTRAINT stock_ledger_note_length CHECK (note IS NULL OR length(note) <= 2000)
);

CREATE INDEX stock_ledger_running_idx ON stock_ledger (item_id, posting_seq);
-- The same for stock: the material list and card sum one item's movements, and the quantities
-- ride along in the index so the sum never touches the heap.
CREATE INDEX stock_ledger_item_sum_idx ON stock_ledger (item_id) INCLUDE (qty_count, qty_kg);
CREATE INDEX stock_ledger_date_idx ON stock_ledger (item_id, entry_date);
CREATE INDEX stock_ledger_ref_idx ON stock_ledger (ref_type, ref_id);
CREATE UNIQUE INDEX stock_ledger_reverses_key ON stock_ledger (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;

-- ───────────────────────────── derived views (2.2.6) ─────────────────────────────
-- None of these is ever stored as an editable column: a balance is a sum over its ledger and
-- stock is a sum over its movements, or it is not the truth (rule 2).

-- *The* customer balance: the sum of the settlement-currency column. The other column is
-- never summed into a displayed balance — it mixes historical rates (2.3.4).
CREATE VIEW customer_balances AS
SELECT c.id AS customer_id,
       c.settlement_currency,
       coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END), 0)::bigint
         AS balance,
       max(l.entry_date) AS last_entry_date
  FROM customers c
  LEFT JOIN customer_ledger l ON l.customer_id = c.id
 GROUP BY c.id, c.settlement_currency;

-- A customer's ledger with its running balance in **posting order**, so every row's "after"
-- value is the one History recorded for that write (2.4.1 rule 5). The predicate a caller
-- puts on customer_id is pushed into the window, which is why this is cheap.
CREATE VIEW customer_ledger_running AS
SELECT l.*,
       c.settlement_currency,
       sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END)
         OVER (PARTITION BY l.customer_id ORDER BY l.posting_seq
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::bigint AS balance_after
  FROM customer_ledger l
  JOIN customers c ON c.id = l.customer_id;

-- Per order: what is still owed, in the customer's settlement currency, and the status it
-- implies (2.4.3). Never set by hand; a status column would be a second truth.
CREATE VIEW order_balances AS
SELECT o.id AS order_id,
       o.customer_id,
       c.settlement_currency,
       CASE WHEN c.settlement_currency = 'IQD' THEN o.total_iqd ELSE o.total_usd_cents END AS total,
       coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END), 0)::bigint
         AS remaining,
       -- The same three lines as `orderStatus()` in @mizan/ledger, so the view and the kernel
       -- cannot drift: nothing owed is paid (an over-settled order too — "partially paid"
       -- would be plainly wrong), everything still owed is unpaid, anything between is partial.
       CASE
         WHEN o.status = 'void' THEN 'void'
         WHEN coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END), 0) <= 0
           THEN 'paid'
         WHEN coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END), 0)
              >= (CASE WHEN c.settlement_currency = 'IQD' THEN o.total_iqd ELSE o.total_usd_cents END)
           THEN 'unpaid'
         ELSE 'partially_paid'
       END AS status
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
  LEFT JOIN customer_ledger l ON l.order_id = o.id
 GROUP BY o.id, o.status, o.customer_id, c.settlement_currency, o.total_iqd, o.total_usd_cents;

-- Stock per material: the sum of the priced measure. The other measure is summed only while
-- every movement of the material carried it; otherwise the screen shows "—", because a
-- partial sum would be wrong (FR-303).
CREATE VIEW item_stock AS
SELECT i.id AS item_id,
       i.pricing_unit,
       coalesce(sum(s.qty_count), 0)::bigint AS stock_count,
       coalesce(sum(s.qty_kg), 0)::numeric(14,3) AS stock_kg,
       -- FILTER keeps the LEFT JOIN's synthetic all-null row out of the aggregate: without it
       -- a material that has never moved would report its measures as *incomplete*.
       coalesce(bool_and(s.qty_count IS NOT NULL) FILTER (WHERE s.id IS NOT NULL), true) AS count_complete,
       coalesce(bool_and(s.qty_kg IS NOT NULL) FILTER (WHERE s.id IS NOT NULL), true) AS kg_complete
  FROM items i
  LEFT JOIN stock_ledger s ON s.item_id = i.id
 GROUP BY i.id, i.pricing_unit;

-- item_stock plus the two derived dates of FR-304. "First bought" counts purchases and
-- opening stock that have not been reversed; "last sold" reads active orders only.
CREATE VIEW item_stats AS
SELECT st.*,
       (SELECT min(s.entry_date)
          FROM stock_ledger s
         WHERE s.item_id = st.item_id
           AND s.movement_type IN ('purchase_in', 'opening')
           AND NOT EXISTS (SELECT 1 FROM stock_ledger r WHERE r.reverses_entry_id = s.id)
       ) AS first_bought_on,
       (SELECT max(o.order_date)
          FROM order_lines ol
          JOIN orders o ON o.id = ol.order_id
         WHERE ol.item_id = st.item_id
           AND ol.deleted_at IS NULL
           AND o.status = 'active'
           AND o.deleted_at IS NULL
       ) AS last_sold_on
  FROM item_stock st;

-- ───────────────────────── settings this iteration adds (2.2.3) ─────────────────────────
-- `null` is a real value here: no edit window and no period lock until someone sets one.

INSERT INTO settings (key, value) VALUES
  ('order_edit_window_days',  'null'),
  ('purchase_edit_window_days','null'),
  ('allow_edit_after_payment','false'),
  ('locked_through',          'null'),   -- Proposed — not requested (FR-1109)
  ('rate_stale_days',         '3'),      -- Proposed — not requested (FR-1106)
  ('go_live_date',            'null')
ON CONFLICT (key) DO NOTHING;

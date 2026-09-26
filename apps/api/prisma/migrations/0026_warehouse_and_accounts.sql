-- Mizan · The warehouse and the accountant (client review, D-062)
--
-- The client, rethinking what the system is for: "the system will become a giant warehouse that
-- has an accountant page, and keeps track of orders and companies that buy from us."
--
--   · Buying is ours alone. A material is created or added to by *buying* it — no supplier, no
--     "we owe them" — and every buy keeps its own price: bottles bought at $1.00 and bottles
--     bought at $1.50 are the same material on the same row, but the system knows which is
--     which. A buy is a purchase line; what this migration adds is the record of which buy each
--     sale and each damage took its stock from (`lot_allocations`), oldest first, so a sale's
--     cost is what the goods it sold actually cost us.
--   · The accountant adds expenses of their own — rent, salaries, anything — beside the buys.
--   · Damage is ours (a loss) or a buying company's (they owe us its cost), and a company's
--     damage stays a cost until it is marked paid back, in money or in materials.

-- ── the cost of a sale: from the buys it took stock from ─────────────────────────────

ALTER TYPE cost_source ADD VALUE IF NOT EXISTS 'lots';

-- Which buy (purchase line) a sale line or a damage took its stock from, and how much of it, in
-- the material's priced measure. Append-only like every ledger (rule 2): giving stock back — an
-- order edited or voided, a damage paid back in materials — is a row with a negative quantity,
-- so what is left of a buy is always the sum over this table.
CREATE TABLE lot_allocations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_line_id  uuid NOT NULL REFERENCES purchase_lines (id),
  item_id           uuid NOT NULL REFERENCES items (id),
  qty               numeric(12,3) NOT NULL,
  ref_type          text NOT NULL,
  ref_id            uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL REFERENCES users (id),
  CONSTRAINT lot_allocations_ref_type CHECK (ref_type IN ('order_line', 'damage')),
  CONSTRAINT lot_allocations_qty_nonzero CHECK (qty <> 0)
);

CREATE INDEX lot_allocations_line_idx ON lot_allocations (purchase_line_id);
CREATE INDEX lot_allocations_item_idx ON lot_allocations (item_id);
CREATE INDEX lot_allocations_ref_idx ON lot_allocations (ref_type, ref_id);

GRANT SELECT, INSERT ON lot_allocations TO mizan_app;
REVOKE UPDATE, DELETE ON lot_allocations FROM mizan_app;

-- ── damage: a buying company owes us for it until it is paid back ────────────────────

-- The row on the company's account that says they owe us for a damage. Positive, like an order.
ALTER TYPE customer_entry_type ADD VALUE IF NOT EXISTS 'damage';

CREATE TYPE damage_compensation AS ENUM ('none', 'owed', 'paid_money', 'paid_materials');

ALTER TABLE damages
  ADD COLUMN compensation   damage_compensation NOT NULL DEFAULT 'none',
  ADD COLUMN compensated_at timestamptz,
  ADD COLUMN compensated_by uuid REFERENCES users (id),
  ADD CONSTRAINT damages_compensated_pair CHECK ((compensated_at IS NULL) = (compensated_by IS NULL)),
  -- Only a company's damage is owed and paid back; our own is simply a loss.
  ADD CONSTRAINT damages_compensation_needs_company CHECK (
    compensation = 'none' OR attribution = 'company'
  ),
  ADD CONSTRAINT damages_compensated_when_paid CHECK (
    (compensation IN ('paid_money', 'paid_materials')) = (compensated_at IS NOT NULL)
  );

-- ── the accountant's own expenses ────────────────────────────────────────────────────

CREATE SEQUENCE expense_number_seq AS bigint START 1;

CREATE TABLE expenses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             bigint NOT NULL DEFAULT nextval('expense_number_seq'),
  expense_date       date NOT NULL,
  title              text NOT NULL,
  -- Both currencies and the rate, like every stored amount (rule 1).
  amount_iqd         bigint NOT NULL,
  amount_usd_cents   bigint NOT NULL,
  entered_currency   currency NOT NULL,
  rate_iqd_per_usd   numeric(14,4) NOT NULL,
  rate_source        rate_source NOT NULL,
  note               text,
  status             doc_status NOT NULL DEFAULT 'active',
  void_reason        text,
  voided_by          uuid REFERENCES users (id),
  voided_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES users (id),
  version            integer NOT NULL DEFAULT 1,
  CONSTRAINT expenses_title_length CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT expenses_note_length CHECK (note IS NULL OR length(note) <= 2000),
  CONSTRAINT expenses_amount_positive CHECK (amount_iqd > 0 AND amount_usd_cents > 0),
  CONSTRAINT expenses_rate_positive CHECK (rate_iqd_per_usd > 0),
  CONSTRAINT expenses_void_reason CHECK (status <> 'void' OR length(btrim(coalesce(void_reason, ''))) > 0)
);

CREATE UNIQUE INDEX expenses_number_key ON expenses (number);
CREATE INDEX expenses_date_idx ON expenses (expense_date DESC) WHERE status = 'active';

GRANT SELECT, INSERT, UPDATE ON expenses TO mizan_app;
REVOKE DELETE ON expenses FROM mizan_app;
GRANT USAGE, SELECT ON SEQUENCE expense_number_seq TO mizan_app;

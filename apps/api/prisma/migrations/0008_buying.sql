-- Mizan · Iteration 2 · Companies, purchases and company accounting (buying)
--
-- The supplier side of 2.2.3. It is the mirror of the customer side that Iteration 1 built —
-- same money model, same append-only rules, same reversal discipline — with three differences
-- the specification is explicit about:
--
--   · a company carries its **own** rate (`company_rates`), and a purchase is valued at it
--     unless a rate was typed for that deal (2.3.3);
--   · a purchase may have **no company**, in which case it moves stock and owes nobody (A-19);
--   · a purchase line has no cost snapshot: it *is* the bought price (D-021).

-- ─────────────────────────────── sequences (2.2.1) ───────────────────────────────

CREATE SEQUENCE purchase_number_seq AS bigint START 1001;  -- "Purchase #1042"
CREATE SEQUENCE company_ledger_seq  AS bigint START 1;     -- posting order, one per ledger

-- ────────────────────────────────── companies (FR-701) ──────────────────────────────────

CREATE TABLE companies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  name_normalized     text NOT NULL,
  contact_name        text,
  phone               text,
  phone_normalized    text,
  address             text,
  notes               text,
  settlement_currency currency NOT NULL DEFAULT 'IQD',
  -- A company may be assigned for filtering and reporting, but assignment never scopes what
  -- anyone may see: every user with `companies.view` sees every company (FR-711, 2.6.4).
  assigned_user_id    uuid REFERENCES users (id),
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL REFERENCES users (id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid NOT NULL REFERENCES users (id),
  deleted_at          timestamptz,
  deleted_by          uuid REFERENCES users (id),
  version             integer NOT NULL DEFAULT 1,
  CONSTRAINT companies_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT companies_notes_length CHECK (notes IS NULL OR length(notes) <= 2000)
);

-- Unlike customers, a company name is unique among the companies that still exist (FR-701),
-- compared after script normalisation so the same name typed on either keyboard collides.
CREATE UNIQUE INDEX companies_name_key ON companies (name_normalized) WHERE deleted_at IS NULL;
CREATE INDEX companies_name_trgm_idx ON companies USING gin (name_normalized gin_trgm_ops);
CREATE INDEX companies_assigned_idx ON companies (assigned_user_id) WHERE deleted_at IS NULL;
CREATE INDEX companies_phone_idx ON companies (phone_normalized)
  WHERE phone_normalized IS NOT NULL AND deleted_at IS NULL;

-- ─────────────────────── company_rates (append-only, FR-703) ───────────────────────
-- The company's own IQD-per-USD rate. Current rate = the latest `effective_from ≤ now()`;
-- a company with no row falls back to the global rate and the interface says so.

CREATE TABLE company_rates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies (id),
  rate_iqd_per_usd numeric(14,4) NOT NULL,
  effective_from   timestamptz NOT NULL DEFAULT now(),
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL REFERENCES users (id),
  CONSTRAINT company_rates_positive CHECK (rate_iqd_per_usd > 0)
);

CREATE INDEX company_rates_lookup_idx ON company_rates (company_id, effective_from DESC);

-- ───────────────────────────────── purchases (FR-401) ─────────────────────────────────

CREATE TABLE purchases (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             bigint NOT NULL DEFAULT nextval('purchase_number_seq'),
  -- Null = "No company (stock only)": stock moves, nobody is owed (FR-407, A-19).
  company_id         uuid REFERENCES companies (id),
  purchase_date      date NOT NULL,
  acting_user_id     uuid NOT NULL REFERENCES users (id),
  notes              text,
  -- "Rate for this purchase": the company's rate, or the global rate without a company,
  -- unless one was typed for this deal (2.3.3).
  rate_iqd_per_usd   numeric(14,4) NOT NULL,
  rate_source        rate_source NOT NULL,
  status             doc_status NOT NULL DEFAULT 'active',
  void_reason        text,
  voided_by          uuid REFERENCES users (id),
  voided_at          timestamptz,
  discount_iqd       bigint NOT NULL DEFAULT 0,   -- Proposed — not requested (FR-616)
  discount_usd_cents bigint NOT NULL DEFAULT 0,   -- Proposed — not requested (FR-616)
  total_iqd          bigint NOT NULL DEFAULT 0,
  total_usd_cents    bigint NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES users (id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid NOT NULL REFERENCES users (id),
  deleted_at         timestamptz,
  deleted_by         uuid REFERENCES users (id),
  version            integer NOT NULL DEFAULT 1,
  CONSTRAINT purchases_rate_positive CHECK (rate_iqd_per_usd > 0),
  CONSTRAINT purchases_notes_length CHECK (notes IS NULL OR length(notes) <= 2000),
  CONSTRAINT purchases_discount_not_negative CHECK (discount_iqd >= 0 AND discount_usd_cents >= 0),
  CONSTRAINT purchases_void_has_reason CHECK (
    (status = 'active' AND void_reason IS NULL AND voided_by IS NULL AND voided_at IS NULL)
    OR (status = 'void' AND void_reason IS NOT NULL AND voided_by IS NOT NULL AND voided_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX purchases_number_key ON purchases (number);
CREATE INDEX purchases_date_idx ON purchases (purchase_date DESC);
CREATE INDEX purchases_company_idx ON purchases (company_id, purchase_date DESC);
CREATE INDEX purchases_acting_idx ON purchases (acting_user_id, purchase_date DESC);
CREATE INDEX purchases_creator_idx ON purchases (created_by, purchase_date DESC);
CREATE INDEX purchases_status_idx ON purchases (status);

-- ─────────────────────────────── purchase_lines (FR-402) ───────────────────────────────
-- Replaced as a set on edit: the old rows are soft-deleted, never overwritten (2.5.3).

CREATE TABLE purchase_lines (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id            uuid NOT NULL REFERENCES purchases (id),
  line_no                integer NOT NULL,
  item_id                uuid NOT NULL REFERENCES items (id),
  qty_count              integer,
  qty_kg                 numeric(12,3),
  priced_measure         measure NOT NULL,
  unit_price_iqd         bigint NOT NULL,
  unit_price_usd_cents   bigint NOT NULL,
  price_entered_currency currency NOT NULL,
  price_source           price_source NOT NULL,
  month_price_id         uuid REFERENCES item_month_prices (id),
  rate_iqd_per_usd       numeric(14,4) NOT NULL,
  rate_source            rate_source NOT NULL,
  line_total_iqd         bigint NOT NULL,
  line_total_usd_cents   bigint NOT NULL,
  note                   text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid NOT NULL REFERENCES users (id),
  deleted_at             timestamptz,
  CONSTRAINT purchase_lines_priced_measure_present CHECK (
    (priced_measure = 'count' AND qty_count IS NOT NULL AND qty_count > 0)
    OR (priced_measure = 'kg' AND qty_kg IS NOT NULL AND qty_kg > 0)
  ),
  CONSTRAINT purchase_lines_quantities_not_negative CHECK (
    (qty_count IS NULL OR qty_count >= 0) AND (qty_kg IS NULL OR qty_kg >= 0)
  ),
  CONSTRAINT purchase_lines_prices_not_negative CHECK (unit_price_iqd >= 0 AND unit_price_usd_cents >= 0),
  CONSTRAINT purchase_lines_rate_positive CHECK (rate_iqd_per_usd > 0)
);

CREATE INDEX purchase_lines_purchase_idx ON purchase_lines (purchase_id) WHERE deleted_at IS NULL;
CREATE INDEX purchase_lines_item_idx ON purchase_lines (item_id, created_at DESC);

-- ──────────────────────── company_ledger (append-only, 2.4.1) ────────────────────────
-- Sign convention: positive increases what **we owe** the company.

CREATE TABLE company_ledger (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies (id),
  entry_type           company_entry_type NOT NULL,
  amount_iqd           bigint NOT NULL,
  amount_usd_cents     bigint NOT NULL,
  entered_currency     currency,
  rate_iqd_per_usd     numeric(14,4) NOT NULL,
  rate_source          rate_source NOT NULL,
  posting_seq          bigint NOT NULL DEFAULT nextval('company_ledger_seq'),
  entry_date           date NOT NULL,
  purchase_id          uuid REFERENCES purchases (id),
  damage_id            uuid,               -- damages arrive in I3; the link exists now (2.2.3)
  reverses_entry_id    uuid REFERENCES company_ledger (id),
  performed_by_user_id uuid NOT NULL REFERENCES users (id),
  note                 text,
  idempotency_key      text,
  voucher_number       bigint,             -- Proposed — not requested (FR-614)
  method               payment_method,     -- Proposed — not requested (FR-617)
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NOT NULL REFERENCES users (id),
  CONSTRAINT company_ledger_rate_positive CHECK (rate_iqd_per_usd > 0),
  CONSTRAINT company_ledger_reversal_link CHECK ((entry_type = 'reversal') = (reverses_entry_id IS NOT NULL)),
  CONSTRAINT company_ledger_one_sign CHECK (
    entry_type = 'settlement_change'
    OR (amount_iqd >= 0 AND amount_usd_cents >= 0)
    OR (amount_iqd <= 0 AND amount_usd_cents <= 0)
  ),
  CONSTRAINT company_ledger_settlement_change_shape CHECK (
    entry_type <> 'settlement_change'
    OR (rate_source = 'manual' AND (amount_iqd = 0 OR amount_usd_cents = 0))
  ),
  CONSTRAINT company_ledger_note_required CHECK (
    entry_type NOT IN ('adjustment', 'credit', 'opening', 'reversal', 'settlement_change')
    OR length(btrim(coalesce(note, ''))) > 0
  ),
  CONSTRAINT company_ledger_note_length CHECK (note IS NULL OR length(note) <= 2000)
);

CREATE INDEX company_ledger_running_idx ON company_ledger (company_id, posting_seq);
-- The two sums every company screen reads, carried in the index so they never touch the heap
-- (the measurement that produced this pattern is in docs/REVIEW-I1.md, finding 3).
CREATE INDEX company_ledger_balance_idx ON company_ledger (company_id) INCLUDE (amount_iqd, amount_usd_cents);
CREATE INDEX company_ledger_purchase_sum_idx ON company_ledger (purchase_id) INCLUDE (amount_iqd, amount_usd_cents)
  WHERE purchase_id IS NOT NULL;
CREATE INDEX company_ledger_date_idx ON company_ledger (company_id, entry_date);
CREATE INDEX company_ledger_performed_idx ON company_ledger (performed_by_user_id, entry_date DESC);
CREATE UNIQUE INDEX company_ledger_reverses_key ON company_ledger (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE UNIQUE INDEX company_ledger_idempotency_key ON company_ledger (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX company_ledger_voucher_key ON company_ledger (voucher_number) WHERE voucher_number IS NOT NULL;

-- A re-basing row is never reversed — a mistake is corrected by another currency change
-- (2.3.5) — and neither is a reversal. The same guarantee the customer ledger carries.
CREATE FUNCTION company_ledger_refuse_rebase_reversal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reverses_entry_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM company_ledger
        WHERE id = NEW.reverses_entry_id
          AND entry_type IN ('settlement_change', 'reversal')
     )
  THEN
    RAISE EXCEPTION 'a % row cannot be reversed',
      (SELECT entry_type FROM company_ledger WHERE id = NEW.reverses_entry_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER company_ledger_refuse_rebase_reversal
  BEFORE INSERT ON company_ledger
  FOR EACH ROW EXECUTE FUNCTION company_ledger_refuse_rebase_reversal();

-- ───────────────────────────── derived views (2.2.6) ─────────────────────────────

-- *The* company balance: the sum of the settlement-currency column. The other column is never
-- summed into a displayed balance — it mixes historical rates (2.3.4).
CREATE VIEW company_balances AS
SELECT c.id AS company_id,
       c.settlement_currency,
       coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END), 0)::bigint
         AS balance,
       max(l.entry_date) AS last_entry_date
  FROM companies c
  LEFT JOIN company_ledger l ON l.company_id = c.id
 GROUP BY c.id, c.settlement_currency;

-- A company's ledger with its running balance in posting order, so every row's "after" value
-- is the one History recorded for that write (2.4.1 rule 5).
CREATE VIEW company_ledger_running AS
SELECT l.*,
       c.settlement_currency,
       sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END)
         OVER (PARTITION BY l.company_id ORDER BY l.posting_seq
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::bigint AS balance_after
  FROM company_ledger l
  JOIN companies c ON c.id = l.company_id;

/*
 * `purchase_balances` is deliberately **not** a view.
 *
 * What a purchase still owes depends on the oldest-first allocation of payments that name no
 * purchase (FR-712, A-29), which is an ordered walk over the company's entries rather than an
 * aggregate — and it is presentation, not data. It lives in `@mizan/ledger` as a pure function
 * with a property test for the identity `Σ remaining + general = balance` (D-020). What the
 * database provides is the cheap half: the sum of the entries explicitly linked to a purchase.
 */
CREATE VIEW purchase_linked_totals AS
SELECT p.id AS purchase_id,
       p.company_id,
       c.settlement_currency,
       CASE WHEN c.settlement_currency = 'IQD' THEN p.total_iqd ELSE p.total_usd_cents END AS total,
       coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END), 0)::bigint
         AS linked
  FROM purchases p
  JOIN companies c ON c.id = p.company_id
  LEFT JOIN company_ledger l ON l.purchase_id = p.id AND l.entry_type <> 'purchase'
 GROUP BY p.id, p.company_id, c.settlement_currency, p.total_iqd, p.total_usd_cents;

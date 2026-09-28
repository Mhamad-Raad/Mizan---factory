-- Performance review at ten years of data (D-075) — two more maintained sums of the kind
-- specification 2.2.6 sanctions and migrations 0015 (`order_remaining`) and 0017
-- (`item_stock_totals`) already keep: a figure summed over an **append-only** table, kept by a
-- trigger as each row is inserted, unwritable by the application, and compared with its source
-- by `scripts/check-integrity.mjs` on every restore drill.
--
-- Measured on the ten-year volume database (1.8 million orders, 2.6 million buys, 7.8 million
-- lot allocations, 1.8 million rows in each money ledger):
--
--   * the Stock report took 18.9–23.4 s. `item_lots` read **every buy ever made**, summed each
--     one's allocations, and ranked them in a window per material — and the report's
--     `item_id IN (page)` cannot be pushed through that window, so every buy was read on every
--     request. Almost all of them are used up, and a used-up buy adds 0 to every sum the view
--     makes;
--   * the dashboard's supplier tile, its top debtors and the customers and companies lists
--     summed every account's two ledgers to show ten or twenty-five of them (845 ms for the
--     tile alone), and Payables and Receivables did the same for their current balances.

-- ════════════════════════════ 1. what is left of each buy ════════════════════════════
--
-- One row per purchase line: its quantity in the material's priced measure, what the
-- allocations have taken from it (a pure sum over `lot_allocations`, which is append-only —
-- giving stock back is a negative row), and whether the buy still counts (`live`: the line is
-- not replaced by an edit and its purchase is active). A buy is *open* while it is live and
-- something of it is untaken; the partial index below holds only the open ones, so the stock
-- figures read a few thousand rows however many years of buys the table holds.

CREATE TABLE lot_balances (
  purchase_line_id uuid PRIMARY KEY REFERENCES purchase_lines (id),
  item_id uuid NOT NULL REFERENCES items (id),
  -- NULL when the line carries no quantity in its priced measure; such a buy holds nothing.
  quantity numeric(14, 3),
  taken numeric(14, 3) NOT NULL DEFAULT 0,
  live boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE lot_balances IS
  'A maintained sum over lot_allocations per purchase line, with whether the buy is live (spec 2.2.6, D-075). Written only by the triggers below; the application role may only read it. Verified against the allocations by scripts/check-integrity.mjs.';

-- A purchase line is written once and never updated except to be replaced (its `deleted_at`).
CREATE FUNCTION mizan_lot_line_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO lot_balances (purchase_line_id, item_id, quantity, taken, live)
  SELECT NEW.id, NEW.item_id,
         CASE WHEN NEW.priced_measure = 'count' THEN NEW.qty_count::numeric ELSE NEW.qty_kg END,
         coalesce((SELECT sum(a.qty) FROM lot_allocations a WHERE a.purchase_line_id = NEW.id), 0),
         NEW.deleted_at IS NULL AND p.status = 'active' AND p.deleted_at IS NULL
    FROM purchases p
   WHERE p.id = NEW.purchase_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_lines_lot_balance
AFTER INSERT ON purchase_lines
FOR EACH ROW EXECUTE FUNCTION mizan_lot_line_insert();

-- An edit replaces a buy's lines; a void or a delete ends the whole buy. Either way the buy
-- stops being a lot, exactly as `item_lots` has always filtered it out.
CREATE FUNCTION mizan_lot_line_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE lot_balances b
     SET live = NEW.deleted_at IS NULL AND p.status = 'active' AND p.deleted_at IS NULL,
         updated_at = now()
    FROM purchases p
   WHERE b.purchase_line_id = NEW.id AND p.id = NEW.purchase_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_lines_lot_live
AFTER UPDATE OF deleted_at ON purchase_lines
FOR EACH ROW
WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
EXECUTE FUNCTION mizan_lot_line_update();

CREATE FUNCTION mizan_lot_purchase_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE lot_balances b
     SET live = l.deleted_at IS NULL AND NEW.status = 'active' AND NEW.deleted_at IS NULL,
         updated_at = now()
    FROM purchase_lines l
   WHERE l.purchase_id = NEW.id AND b.purchase_line_id = l.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchases_lot_live
AFTER UPDATE OF status, deleted_at ON purchases
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
EXECUTE FUNCTION mizan_lot_purchase_update();

-- Every take and every give-back moves the buy's taken figure; one primary-key update inside a
-- transaction that already holds the material's row lock (lots.service `plan`/`release`).
CREATE FUNCTION mizan_lot_allocation_apply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE lot_balances
     SET taken = taken + NEW.qty,
         updated_at = now()
   WHERE purchase_line_id = NEW.purchase_line_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lot_allocations_lot_balance
AFTER INSERT ON lot_allocations
FOR EACH ROW EXECUTE FUNCTION mizan_lot_allocation_apply();

-- ── the backfill: every buy there is, with what its allocations add up to ──

INSERT INTO lot_balances (purchase_line_id, item_id, quantity, taken, live)
SELECT l.id, l.item_id,
       CASE WHEN l.priced_measure = 'count' THEN l.qty_count::numeric ELSE l.qty_kg END,
       coalesce(a.taken, 0),
       l.deleted_at IS NULL AND p.status = 'active' AND p.deleted_at IS NULL
  FROM purchase_lines l
  JOIN purchases p ON p.id = l.purchase_id
  LEFT JOIN (SELECT purchase_line_id, sum(qty) AS taken FROM lot_allocations GROUP BY purchase_line_id) a
    ON a.purchase_line_id = l.id;

-- The open buys of a material, answered from the index alone. Most of the table is used up
-- and never read again; this index is what the stock figures actually walk.
CREATE INDEX lot_balances_open_idx ON lot_balances (item_id) INCLUDE (quantity, taken)
  WHERE live AND taken < quantity;

-- ── `item_lots`, over the open buys only ──
--
-- The same columns and the same figures as migrations 0030/0031. A buy with nothing untaken
-- has `untaken` 0, so it adds nothing to `running` or `untaken_total` and its own `remaining`
-- is 0: leaving it out changes no figure the view returns for any other buy, and every sum
-- over the view is unchanged (proved per material on the ten-year database and on the
-- development one before and after, D-075). The used-up buys are read on their own when the
-- material page asks for them (`LotsService.usedUp`).

DROP VIEW item_lots;

CREATE VIEW item_lots AS
WITH raw AS (
  SELECT b.purchase_line_id,
         b.item_id,
         p.id AS purchase_id,
         p.number AS purchase_number,
         p.purchase_date,
         l.line_no,
         b.quantity::numeric AS quantity,
         b.taken::numeric AS taken,
         l.unit_price_iqd,
         l.unit_price_usd_cents,
         l.line_total_iqd,
         l.line_total_usd_cents,
         l.price_entered_currency,
         l.rate_iqd_per_usd
    FROM lot_balances b
    JOIN purchase_lines l ON l.id = b.purchase_line_id
    JOIN purchases p ON p.id = l.purchase_id
   WHERE b.live AND b.taken < b.quantity
     -- The same filter the view always had, kept beside `live` so the two can never disagree.
     AND l.deleted_at IS NULL AND p.status = 'active' AND p.deleted_at IS NULL
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
       -- What the buys hold beyond the stock on hand comes off the oldest first.
       greatest(0, least(r.untaken, r.running - greatest(r.untaken_total - greatest(coalesce(
         CASE WHEN i.pricing_unit = 'per_piece' THEN st.stock_count::numeric ELSE st.stock_kg END, 0), 0), 0)))
         AS remaining
  FROM ranked r
  JOIN items i ON i.id = r.item_id
  LEFT JOIN item_stock_totals st ON st.item_id = r.item_id;

GRANT SELECT ON item_lots TO mizan_app;

-- ═══════════════════════════ 2. every account's two balances ═══════════════════════════
--
-- One row per account: the sum of each currency column of its customer-ledger rows (what it
-- owes us) and of its company-ledger rows (what we owe it). Both columns, not "the balance":
-- which column *is* the balance depends on the account's settlement currency, which can change
-- (a `settlement_change` row converts the balance, D-054), and a reader picks the column by
-- today's currency — exactly what the ledger views do. So a change of currency needs nothing
-- from this table, and the figure can never be the stale side.

CREATE TABLE account_totals (
  account_id uuid PRIMARY KEY REFERENCES customers (id),
  receivable_iqd bigint NOT NULL DEFAULT 0,
  receivable_usd_cents bigint NOT NULL DEFAULT 0,
  receivable_entries integer NOT NULL DEFAULT 0,
  payable_iqd bigint NOT NULL DEFAULT 0,
  payable_usd_cents bigint NOT NULL DEFAULT 0,
  payable_entries integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 70);

COMMENT ON TABLE account_totals IS
  'A maintained sum over customer_ledger and company_ledger per account (spec 2.2.6, D-075). Written only by the triggers below; the application role may only read it. Verified against both ledgers by scripts/check-integrity.mjs.';

-- A ledger write already holds its account's row lock (`AccountLedgerService.lockOwner`), so
-- these upserts serialise exactly where the ledger already does, and nowhere else.
CREATE FUNCTION mizan_account_receivable_apply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO account_totals (account_id, receivable_iqd, receivable_usd_cents, receivable_entries)
  VALUES (NEW.customer_id, NEW.amount_iqd, NEW.amount_usd_cents, 1)
  ON CONFLICT (account_id) DO UPDATE
     SET receivable_iqd = account_totals.receivable_iqd + EXCLUDED.receivable_iqd,
         receivable_usd_cents = account_totals.receivable_usd_cents + EXCLUDED.receivable_usd_cents,
         receivable_entries = account_totals.receivable_entries + 1,
         updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_ledger_account_totals
AFTER INSERT ON customer_ledger
FOR EACH ROW EXECUTE FUNCTION mizan_account_receivable_apply();

CREATE FUNCTION mizan_account_payable_apply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO account_totals (account_id, payable_iqd, payable_usd_cents, payable_entries)
  VALUES (NEW.company_id, NEW.amount_iqd, NEW.amount_usd_cents, 1)
  ON CONFLICT (account_id) DO UPDATE
     SET payable_iqd = account_totals.payable_iqd + EXCLUDED.payable_iqd,
         payable_usd_cents = account_totals.payable_usd_cents + EXCLUDED.payable_usd_cents,
         payable_entries = account_totals.payable_entries + 1,
         updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER company_ledger_account_totals
AFTER INSERT ON company_ledger
FOR EACH ROW EXECUTE FUNCTION mizan_account_payable_apply();

-- ── the backfill ──

INSERT INTO account_totals (account_id, receivable_iqd, receivable_usd_cents, receivable_entries)
SELECT customer_id, sum(amount_iqd), sum(amount_usd_cents), count(*)
  FROM customer_ledger
 GROUP BY customer_id;

INSERT INTO account_totals (account_id, payable_iqd, payable_usd_cents, payable_entries)
SELECT company_id, sum(amount_iqd), sum(amount_usd_cents), count(*)
  FROM company_ledger
 GROUP BY company_id
ON CONFLICT (account_id) DO UPDATE
   SET payable_iqd = EXCLUDED.payable_iqd,
       payable_usd_cents = EXCLUDED.payable_usd_cents,
       payable_entries = EXCLUDED.payable_entries;

-- ── the balances in each account's own currency ──
--
-- `party_balances` (0023) keeps its name and its columns and now reads the maintained sums, so
-- the dashboard, the customer page and anything else that asks it are answered by one row per
-- account instead of two ledger passes per account.

CREATE OR REPLACE VIEW party_balances AS
SELECT c.id AS customer_id,
       c.settlement_currency,
       coalesce(CASE WHEN c.settlement_currency = 'IQD' THEN t.receivable_iqd ELSE t.receivable_usd_cents END, 0)::bigint
         AS receivable,
       coalesce(CASE WHEN c.settlement_currency = 'IQD' THEN t.payable_iqd ELSE t.payable_usd_cents END, 0)::bigint
         AS payable,
       (coalesce(CASE WHEN c.settlement_currency = 'IQD' THEN t.receivable_iqd ELSE t.receivable_usd_cents END, 0)
        - coalesce(CASE WHEN c.settlement_currency = 'IQD' THEN t.payable_iqd ELSE t.payable_usd_cents END, 0))::bigint
         AS net
  FROM customers c
  LEFT JOIN account_totals t ON t.account_id = c.id;

-- ── privileges: the application reads, only the triggers write ──

GRANT SELECT ON lot_balances, account_totals TO mizan_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON lot_balances, account_totals FROM mizan_app;
REVOKE ALL ON FUNCTION mizan_lot_line_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION mizan_lot_line_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION mizan_lot_purchase_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION mizan_lot_allocation_apply() FROM PUBLIC;
REVOKE ALL ON FUNCTION mizan_account_receivable_apply() FROM PUBLIC;
REVOKE ALL ON FUNCTION mizan_account_payable_apply() FROM PUBLIC;

ANALYZE lot_balances;
ANALYZE account_totals;

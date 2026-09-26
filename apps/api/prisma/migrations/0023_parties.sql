-- Mizan · Customers and companies are one kind of record (client review, D-054)
--
-- A business the factory sells to and a business it buys from were two tables with two pages.
-- The client's words: "companies and customers are one thing." From here on there is one record
-- per business — the `customers` table — which may be a customer, a supplier, or both:
--
--   · `is_customer` / `is_supplier` say which sides of the business it takes part in, so the
--     order form offers customers and the purchase form offers suppliers;
--   · `purchases.company_id`, `company_ledger.company_id` and `damages.company_id` now name a
--     row of `customers` — the column keeps its name and means "the business on the buying
--     side of this document";
--   · one rate per business (`customer_rates`), used for its orders *and* its purchases;
--   · the two ledgers stay as they are — the money kernel, the append-only rules and the
--     oldest-first purchase allocation do not change — and `party_balances` nets them into
--     the one figure the client asked for: what they owe us less what we owe them.
--
-- The companies table is dropped rather than copied across. The client asked for the dummy data
-- to be cleared and the new structure seeded afresh, and no production database exists yet; the
-- guard below refuses to run over any company data at all, so this can never lose a real record.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM companies)
     OR EXISTS (SELECT 1 FROM company_ledger)
     OR EXISTS (SELECT 1 FROM company_rates)
     OR EXISTS (SELECT 1 FROM purchases WHERE company_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM damages WHERE company_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'companies still hold data: clear the business data before merging customers and companies';
  END IF;
END;
$$;

-- ───────────────────────────── one record per business ─────────────────────────────

ALTER TABLE customers
  ADD COLUMN contact_name text,
  ADD COLUMN is_customer  boolean NOT NULL DEFAULT true,
  ADD COLUMN is_supplier  boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT customers_has_a_side CHECK (is_customer OR is_supplier),
  -- The walk-in customer is somebody at the counter, never somebody we buy from.
  ADD CONSTRAINT customers_system_is_a_customer CHECK (NOT is_system OR (is_customer AND NOT is_supplier));

CREATE INDEX customers_supplier_idx ON customers (name_normalized) WHERE is_supplier AND deleted_at IS NULL;

-- ─────────────────────── the buying side names a business ───────────────────────

DROP VIEW company_balances;
DROP VIEW company_ledger_running;
DROP VIEW purchase_linked_totals;

ALTER TABLE company_ledger DROP CONSTRAINT company_ledger_company_id_fkey;
ALTER TABLE company_ledger
  ADD CONSTRAINT company_ledger_company_id_fkey FOREIGN KEY (company_id) REFERENCES customers (id);

ALTER TABLE purchases DROP CONSTRAINT purchases_company_id_fkey;
ALTER TABLE purchases
  ADD CONSTRAINT purchases_company_id_fkey FOREIGN KEY (company_id) REFERENCES customers (id);

ALTER TABLE damages DROP CONSTRAINT damages_company_id_fkey;
ALTER TABLE damages
  ADD CONSTRAINT damages_company_id_fkey FOREIGN KEY (company_id) REFERENCES customers (id);

-- One rate per business: `customer_rates` (0022) is the only rate history now, and an order
-- priced at the business's own rate says so — `company` is the source label for "this party's
-- own rate" on both sides — rather than passing it off as a rate typed for the deal.
DROP TABLE company_rates;
DROP TABLE companies;
ALTER TABLE orders DROP CONSTRAINT orders_rate_source_customer_side;

-- ───────────────────────────── derived views (2.2.6) ─────────────────────────────
-- The same three views as 0008, reading the business's settlement currency from `customers`.

CREATE VIEW company_balances AS
SELECT c.id AS company_id,
       c.settlement_currency,
       coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END), 0)::bigint
         AS balance,
       max(l.entry_date) AS last_entry_date
  FROM customers c
  LEFT JOIN company_ledger l ON l.company_id = c.id
 WHERE c.is_supplier
 GROUP BY c.id, c.settlement_currency;

CREATE VIEW company_ledger_running AS
SELECT l.*,
       c.settlement_currency,
       sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END)
         OVER (PARTITION BY l.company_id ORDER BY l.posting_seq
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::bigint AS balance_after
  FROM company_ledger l
  JOIN customers c ON c.id = l.company_id;

CREATE VIEW purchase_linked_totals AS
SELECT p.id AS purchase_id,
       p.company_id,
       c.settlement_currency,
       CASE WHEN c.settlement_currency = 'IQD' THEN p.total_iqd ELSE p.total_usd_cents END AS total,
       coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END), 0)::bigint
         AS linked
  FROM purchases p
  JOIN customers c ON c.id = p.company_id
  LEFT JOIN company_ledger l ON l.purchase_id = p.id AND l.entry_type <> 'purchase'
 GROUP BY p.id, p.company_id, c.settlement_currency, p.total_iqd, p.total_usd_cents;

/*
 * *The* balance of a business, netted (D-054): what it owes us on the selling side less what we
 * owe it on the buying side, both in its one settlement currency. Positive — they owe us;
 * negative — we owe them. Each side is still its own ledger's sum, never a stored column
 * (rule 2), and both sums are served by the covering balance indexes of 0006 and 0008.
 */
CREATE VIEW party_balances AS
SELECT c.id AS customer_id,
       c.settlement_currency,
       s.receivable,
       b.payable,
       (s.receivable - b.payable)::bigint AS net
  FROM customers c
  CROSS JOIN LATERAL (
    SELECT coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END), 0)::bigint
             AS receivable
      FROM customer_ledger l
     WHERE l.customer_id = c.id
  ) s
  CROSS JOIN LATERAL (
    SELECT coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END), 0)::bigint
             AS payable
      FROM company_ledger l
     WHERE l.company_id = c.id
  ) b;

GRANT SELECT ON company_balances, company_ledger_running, purchase_linked_totals, party_balances TO mizan_app;

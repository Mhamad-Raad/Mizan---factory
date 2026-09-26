-- Mizan · There is one kind of account: a company (client review, D-055)
--
-- 0023 made customers and companies one record with two flags saying which sides it took part
-- in. The client, looking at it: "the term we buy from them or we sell to them does not matter
-- … there is no customer or company, there is only company." Every account can be sold to and
-- bought from, owes us and is owed by us, and its one balance is the net of the two ledgers.
--
-- So the flags go. The one record that is still not an ordinary account is the walk-in customer
-- (`is_system`): somebody at the counter paying cash, never somebody we buy from — and the
-- checks that used to ask "is this a supplier?" now ask "is this a real account?".
--
-- Nothing is lost: a record that was a customer only or a supplier only simply gains the other
-- side, with nothing on it yet.

DROP VIEW company_balances;

ALTER TABLE customers
  DROP CONSTRAINT customers_has_a_side,
  DROP CONSTRAINT customers_system_is_a_customer;
DROP INDEX customers_supplier_idx;
ALTER TABLE customers
  DROP COLUMN is_customer,
  DROP COLUMN is_supplier;

-- The buying side's balance per account, as 0023 had it, over every account but the walk-in.
CREATE VIEW company_balances AS
SELECT c.id AS company_id,
       c.settlement_currency,
       coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END), 0)::bigint
         AS balance,
       max(l.entry_date) AS last_entry_date
  FROM customers c
  LEFT JOIN company_ledger l ON l.company_id = c.id
 WHERE NOT c.is_system
 GROUP BY c.id, c.settlement_currency;

GRANT SELECT ON company_balances TO mizan_app;

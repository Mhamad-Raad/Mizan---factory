-- Rule 2 for the tables Iteration 1 adds, enforced by the database (spec 2.13).
--
-- The three ledgers and the two append-only histories of this iteration are INSERT + SELECT
-- and nothing else: `mizan_app` physically cannot rewrite a balance, a stock movement, a
-- rate or a payment-type change. Corrections are reversal rows.
--
-- The mutable tables get SELECT, INSERT and UPDATE but **no DELETE**: a record is
-- deactivated or soft-deleted (`deleted_at`), and lines are replaced by soft-deleting the
-- old set, so nothing in this schema ever needs a physical delete (A-32).

GRANT SELECT, INSERT, UPDATE ON items, item_month_prices, customers, orders, order_lines TO mizan_app;
REVOKE DELETE ON items, item_month_prices, customers, orders, order_lines FROM mizan_app;

GRANT SELECT, INSERT ON global_rates, customer_ledger, stock_ledger, order_payment_type_changes TO mizan_app;
REVOKE UPDATE, DELETE ON global_rates, customer_ledger, stock_ledger, order_payment_type_changes FROM mizan_app;

-- Derived views are read-only by nature; the grant is explicit so a new view is never
-- unreadable in production while it works in a developer's own database.
GRANT SELECT ON customer_balances, customer_ledger_running, order_balances, item_stock, item_stats TO mizan_app;

-- The sequences behind order numbers, voucher numbers and posting order. The grant in
-- migration 0002 covered only the sequences that existed then.
GRANT USAGE, SELECT ON SEQUENCE order_number_seq, voucher_number_seq, customer_ledger_seq, stock_ledger_seq TO mizan_app;

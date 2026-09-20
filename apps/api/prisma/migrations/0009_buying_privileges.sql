-- Rule 2 for the tables Iteration 2 adds (spec 2.13), exactly as migration 0007 did for the
-- selling side: the ledger and the rate history are INSERT + SELECT, the mutable tables have
-- no DELETE at all, and the views are readable.

GRANT SELECT, INSERT, UPDATE ON companies, purchases, purchase_lines TO mizan_app;
REVOKE DELETE ON companies, purchases, purchase_lines FROM mizan_app;

GRANT SELECT, INSERT ON company_rates, company_ledger TO mizan_app;
REVOKE UPDATE, DELETE ON company_rates, company_ledger FROM mizan_app;

GRANT SELECT ON company_balances, company_ledger_running, purchase_linked_totals TO mizan_app;

GRANT USAGE, SELECT ON SEQUENCE purchase_number_seq, company_ledger_seq TO mizan_app;

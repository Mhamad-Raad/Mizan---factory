-- Mizan · Accounts are not assigned to employees (client review, D-056)
--
-- Assignment (FR-502) decided which salesman saw which customers, and named whose account it
-- was. The client: "remove that from the system". Every account is a company that everybody who
-- may see companies sees (D-055); nobody's view is narrowed by assignment any more, so the column
-- and the three permissions that only existed for it go:
--
--   · customers.assign / companies.assign — who could assign an account;
--   · customers.view_all — "sees every customer, not only the assigned ones", now what
--     customers.view means by itself.
--
-- History keeps every assignment that was ever made: audit rows are append-only (rule 2) and
-- still carry `related.assigned_user_id` as it was at the time.

ALTER TABLE customers DROP CONSTRAINT customers_system_not_assigned;
DROP INDEX customers_assigned_idx;
ALTER TABLE customers DROP COLUMN assigned_user_id;

-- The walk-in customer is still never inactive (the half of the old check that remains true).
ALTER TABLE customers ADD CONSTRAINT customers_system_active CHECK (NOT is_system OR is_active);

DELETE FROM user_permissions
 WHERE permission_key IN ('customers.assign', 'companies.assign', 'customers.view_all');

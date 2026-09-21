-- The maintained sum is not the application's to write (2.2.6: "never an edited field").
--
-- The trigger runs as the definer of its function — the migrate role that owns the table — so
-- the application needs no privilege at all beyond reading it. Anything that tried to correct
-- the figure by hand would be refused, which is the point: the only way a number in this table
-- changes is a ledger row being inserted.
GRANT SELECT ON order_remaining TO mizan_app;
REVOKE INSERT, UPDATE, DELETE ON order_remaining FROM mizan_app;

-- `SECURITY DEFINER` so the trigger can write the table the application cannot.
ALTER FUNCTION mizan_order_remaining_apply() SECURITY DEFINER;
REVOKE ALL ON FUNCTION mizan_order_remaining_apply() FROM PUBLIC;

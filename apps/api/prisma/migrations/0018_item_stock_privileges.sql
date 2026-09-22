-- As with `order_remaining` (0016): the maintained sum is not the application's to write.
GRANT SELECT ON item_stock_totals TO mizan_app;
REVOKE INSERT, UPDATE, DELETE ON item_stock_totals FROM mizan_app;

-- `SECURITY DEFINER` so the trigger can write the table the application cannot. It runs inside
-- the same transaction as the movement, which is what lets `stockOf()` read the new figure
-- immediately when it checks the negative-stock rule (FR-307).
ALTER FUNCTION mizan_item_stock_apply() SECURITY DEFINER;
REVOKE ALL ON FUNCTION mizan_item_stock_apply() FROM PUBLIC;

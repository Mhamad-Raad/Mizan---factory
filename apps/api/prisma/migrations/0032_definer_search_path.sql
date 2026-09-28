-- The three SECURITY DEFINER functions run with the migrate role's rights, and resolved the
-- tables they write by the caller's search_path — which starts with the caller's temporary
-- schema. With the app's credentials, a temporary table named `item_stock_totals` or
-- `order_remaining` would have received the maintained totals instead of the real ones, and the
-- figures on every screen would have drifted from the ledgers without a trace (security review).
--
-- Each function now resolves names in `public` only (pg_temp last, as the PostgreSQL
-- documentation prescribes for definer functions), and the app role can no longer create
-- temporary tables at all: nothing in the API needs one.

ALTER FUNCTION mizan_item_stock_apply() SET search_path = public, pg_temp;
ALTER FUNCTION mizan_order_remaining_apply() SET search_path = public, pg_temp;
ALTER FUNCTION mizan_prune_expired(interval) SET search_path = public, pg_temp;

DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM mizan_app', current_database());
END;
$$;

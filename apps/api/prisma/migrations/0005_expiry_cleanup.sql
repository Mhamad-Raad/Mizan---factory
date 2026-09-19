-- Two tables accumulate rows that stop being useful, in a system expected to run for years
-- without much attention: idempotency keys expire after 24 hours, and sessions become dead
-- weight once they are revoked or past their absolute lifetime.
--
-- Neither is history, so both can be pruned. The function runs as its owner (`mizan_migrate`)
-- rather than as the application role, so granting the application DELETE on sessions is not
-- necessary and the append-only tables stay untouchable.

CREATE OR REPLACE FUNCTION mizan_prune_expired(older_than interval DEFAULT interval '30 days')
RETURNS TABLE (pruned_idempotency_keys bigint, pruned_sessions bigint)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  keys_removed bigint;
  sessions_removed bigint;
BEGIN
  DELETE FROM idempotency_keys WHERE expires_at < now();
  GET DIAGNOSTICS keys_removed = ROW_COUNT;

  DELETE FROM sessions
   WHERE (revoked_at IS NOT NULL AND revoked_at < now() - older_than)
      OR absolute_expires_at < now() - older_than;
  GET DIAGNOSTICS sessions_removed = ROW_COUNT;

  RETURN QUERY SELECT keys_removed, sessions_removed;
END;
$$;

REVOKE ALL ON FUNCTION mizan_prune_expired(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mizan_prune_expired(interval) TO mizan_app;

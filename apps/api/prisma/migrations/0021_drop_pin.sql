-- Remove PIN quick sign-in and device-bound tickets (reverses Iteration 5 / FR-106).
--
-- PIN sign-in and the device tickets that backed it are gone: the lock screen is password-only
-- and an employee proves themselves with their password everywhere. This drops the table that
-- held the tickets, the PIN columns on `users`, and rebuilds the expiry sweep without the
-- device-ticket leg it grew in 0012.
--
-- Kept on purpose: `sessions.pin_failures` and `sessions.auth_method` from 0001/0012. Neither is
-- a secret, both are written by ordinary session code (`auth_method` is now always 'password'),
-- and dropping them would buy nothing while touching the hot session path.

-- ── the expiry sweep, back to its pre-ticket shape (reverses 0012's redefinition) ──
-- The function's body references device_tickets, so it is redefined without that leg BEFORE the
-- table is dropped. The return type loses its third column; the only caller reads
-- pruned_idempotency_keys by name (review-regressions test), so the narrower shape is safe.
DROP FUNCTION IF EXISTS mizan_prune_expired(interval);

CREATE FUNCTION mizan_prune_expired(older_than interval DEFAULT interval '30 days')
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

-- ── the device tickets themselves (reverses 0012, and its grants in 0013 go with the table) ──
DROP TABLE IF EXISTS device_tickets;

-- ── the PIN on the employee record (reverses the columns and checks from 0001) ──
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pin_pair;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pin_length_range;
ALTER TABLE users DROP COLUMN IF EXISTS pin_length;
ALTER TABLE users DROP COLUMN IF EXISTS pin_hash;

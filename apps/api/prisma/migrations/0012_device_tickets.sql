-- Iteration 5 — shared tablets: device-bound quick sign-in (spec 2.2, 2.8, FR-106).
--
-- A device ticket is what makes a PIN safe enough to sign in with. The PIN alone is four to six
-- digits and everybody on the floor holds the same tablet; the ticket is a 256-bit secret this
-- browser was handed when that user last signed in **with their password**, so a PIN is only
-- ever a second factor on a browser the user has already proved themselves on, and only for
-- seven days. It is hashed like a session token: the row proves nothing to whoever reads it.

CREATE TABLE device_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id),
  -- SHA-256 of the 256-bit ticket the client keeps in localStorage beside the display name.
  ticket_hash text NOT NULL UNIQUE,
  device_label text,
  -- Whether the browser that asked for it calls itself a shared device, so the admin's
  -- Sessions tab can say "Floor tablet 2" rather than "a browser somewhere".
  is_shared_device boolean NOT NULL DEFAULT false,
  user_agent text,
  -- Five wrong PINs and the ticket is revoked, which *is* the "then ask for the password"
  -- rule of 2.8: without a ticket the lock screen has nothing to offer but the password.
  pin_failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The creator is the user's own password sign-in (2.2.1: append-only rows carry a creator).
  created_by uuid NOT NULL REFERENCES users (id),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  CONSTRAINT device_tickets_pin_failures_range CHECK (pin_failures >= 0 AND pin_failures <= 5),
  CONSTRAINT device_tickets_revocation CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);

-- The three questions asked of this table: resolve a ticket on sign-in, list a user's tickets
-- for the admin's Sessions tab, and sweep the expired ones (2.2.5).
CREATE INDEX device_tickets_user_idx ON device_tickets (user_id);
CREATE INDEX device_tickets_expiry_idx ON device_tickets (expires_at);

-- ── the PIN attempt count of an unlock, which belongs to the session, not to a browser ──
--
-- Unlocking is the same session's own user re-proving themselves, so its five attempts are
-- counted on the session and cleared when it is unlocked. At five the session accepts only the
-- password, which is what 2.8 means by "5 attempts then password required".
ALTER TABLE sessions ADD COLUMN pin_failures integer NOT NULL DEFAULT 0;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_pin_failures_range CHECK (pin_failures >= 0 AND pin_failures <= 5);

-- ── the sweep (2.2.5, extending mizan_prune_expired of 0005) ─────────────────────────────
--
-- Same signature and same `older_than` grace as 0005 — a revoked or lapsed ticket is what the
-- admin's Sessions tab shows somebody standing at a tablet asking why their PIN stopped
-- working, so it is kept for the grace period rather than swept the moment it lapses. The
-- return type gains a column, which in PostgreSQL means dropping the function first.
DROP FUNCTION IF EXISTS mizan_prune_expired(interval);

CREATE FUNCTION mizan_prune_expired(older_than interval DEFAULT interval '30 days')
RETURNS TABLE (pruned_idempotency_keys bigint, pruned_sessions bigint, pruned_device_tickets bigint)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  keys_removed bigint;
  sessions_removed bigint;
  tickets_removed bigint;
BEGIN
  DELETE FROM idempotency_keys WHERE expires_at < now();
  GET DIAGNOSTICS keys_removed = ROW_COUNT;

  DELETE FROM sessions
   WHERE (revoked_at IS NOT NULL AND revoked_at < now() - older_than)
      OR absolute_expires_at < now() - older_than;
  GET DIAGNOSTICS sessions_removed = ROW_COUNT;

  DELETE FROM device_tickets
   WHERE (revoked_at IS NOT NULL AND revoked_at < now() - older_than)
      OR expires_at < now() - older_than;
  GET DIAGNOSTICS tickets_removed = ROW_COUNT;

  RETURN QUERY SELECT keys_removed, sessions_removed, tickets_removed;
END;
$$;

REVOKE ALL ON FUNCTION mizan_prune_expired(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mizan_prune_expired(interval) TO mizan_app;

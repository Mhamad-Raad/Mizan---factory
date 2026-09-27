-- An idempotency key belongs to the user who sent it (security review, finding 17). Keyed on the
-- key alone, two users' keys shared one namespace: a key another user had already used made an
-- honest request fail with "already sent with different data". The existing rows are unique on
-- `key`, so they are unique on `(user_id, key)` too — nothing to clean up. The table is a
-- 24-hour cache, never history.

ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_pkey;
ALTER TABLE idempotency_keys ADD PRIMARY KEY (user_id, key);

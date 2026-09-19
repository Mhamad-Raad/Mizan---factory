-- The idempotency table is a 24-hour cache of responses, not history.
--
-- Safe retries need the key to be *reserved before* the work runs, so a double-tap on a
-- flaky connection cannot produce two orders; the reservation is then completed with the
-- response, or released if the request failed. That needs UPDATE and DELETE on this one
-- table. The tables that hold history — audit_log, login_attempts and the three ledgers —
-- keep their INSERT-only grants and are untouched by this migration.

GRANT UPDATE, DELETE ON idempotency_keys TO mizan_app;

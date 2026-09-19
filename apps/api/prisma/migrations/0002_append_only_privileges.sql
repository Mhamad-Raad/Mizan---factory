-- Rule 2, enforced by the database rather than by discipline (spec 2.13).
--
-- `mizan_app` is the role the API connects as. It may INSERT into the append-only tables
-- and SELECT from them, and it has no UPDATE and no DELETE on them at all — so no code
-- path, no migration mistake and no console session run by the application can rewrite
-- history. Corrections are reversal rows. Migrations run as `mizan_migrate`, which owns
-- the schema.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mizan_app') THEN
    CREATE ROLE mizan_app LOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO mizan_app;

-- Ordinary, mutable tables: the application may do everything.
GRANT SELECT, INSERT, UPDATE, DELETE ON users, user_permissions, sessions, settings TO mizan_app;

-- Append-only tables: insert and read only. This is the whole point.
GRANT SELECT, INSERT ON audit_log, login_attempts, idempotency_keys TO mizan_app;
REVOKE UPDATE, DELETE ON audit_log, login_attempts, idempotency_keys FROM mizan_app;

-- Sequences the application needs to write those rows.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mizan_app;

-- Expiring idempotency rows are removed by a maintenance job running as the migrate role,
-- never by the application (a DELETE grant here would also let it delete stored responses).

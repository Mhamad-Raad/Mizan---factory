-- Mizan · Iteration 0 · Foundation
--
-- Creates the enum types of specification 2.2.2, the seven I0 tables of 2.2.3, the indices
-- of 2.2.5, and — the part that makes rule 2 real — an application role that physically
-- cannot UPDATE or DELETE an audit row (2.13).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─────────────────────────────── enum types (2.2.2) ───────────────────────────────

CREATE TYPE user_role AS ENUM ('admin', 'employee');
CREATE TYPE currency AS ENUM ('IQD', 'USD');
CREATE TYPE pricing_unit AS ENUM ('per_piece', 'per_kg');
CREATE TYPE measure AS ENUM ('count', 'kg');
CREATE TYPE rate_source AS ENUM ('company', 'global', 'manual');
CREATE TYPE price_source AS ENUM ('month', 'override');
CREATE TYPE doc_status AS ENUM ('active', 'void');
CREATE TYPE payment_type AS ENUM ('cash', 'borrowed');
CREATE TYPE customer_entry_type AS ENUM (
  'order', 'cash_settlement', 'payment', 'credit', 'refund',
  'adjustment', 'opening', 'settlement_change', 'reversal'
);
CREATE TYPE company_entry_type AS ENUM (
  'purchase', 'payment', 'adjustment', 'credit', 'opening', 'settlement_change', 'reversal'
);
CREATE TYPE payment_method AS ENUM ('cash', 'transfer', 'other');
CREATE TYPE auth_method AS ENUM ('password', 'ticket_pin');
CREATE TYPE cost_source AS ENUM ('month', 'fallback', 'none');
CREATE TYPE stock_movement_type AS ENUM (
  'purchase_in', 'sale_out', 'damage_out', 'return_in', 'opening', 'adjustment', 'reversal'
);
CREATE TYPE stock_ref_type AS ENUM ('purchase_line', 'order_line', 'damage', 'manual');
CREATE TYPE damage_attribution AS ENUM ('none', 'customer_order', 'us', 'company');
CREATE TYPE return_status AS ENUM (
  'not_returnable', 'pending', 'returned', 'returned_credited', 'written_off'
);
CREATE TYPE stock_effect AS ENUM ('reduced', 'none', 'returned_in');
CREATE TYPE audit_action AS ENUM (
  'create', 'update', 'void', 'delete', 'login', 'logout', 'login_failed', 'lockout',
  'lock', 'unlock', 'switch_user', 'permission_change', 'password_change', 'password_reset',
  'rate_change', 'price_change', 'ledger_entry', 'assignment_change', 'status_change',
  'settings_change', 'export'
);

-- ─────────────────────────────────── users (2.2.3) ───────────────────────────────────

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username              citext NOT NULL,
  phone                 text,
  display_name          text NOT NULL,
  -- Maintained by the application with the shared normaliser, so an employee typed on an
  -- Arabic keyboard is found from a Kurdish one (spec 2.2.1 convention, FR-1205, FR-206).
  display_name_normalized text NOT NULL DEFAULT '',
  role                  user_role NOT NULL,
  password_hash         text NOT NULL,
  must_change_password  boolean NOT NULL DEFAULT true,
  pin_hash              text,
  pin_length            integer,
  preset_key            text,
  preset_version        integer,
  is_active             boolean NOT NULL DEFAULT true,
  last_login_at         timestamptz,
  failed_login_count    integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid,
  deleted_at            timestamptz,
  deleted_by            uuid,
  version               integer NOT NULL DEFAULT 1,
  CONSTRAINT users_username_shape CHECK (username ~ '^[a-z0-9._]{3,32}$'),
  CONSTRAINT users_display_name_not_blank CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT users_pin_length_range CHECK (pin_length IS NULL OR pin_length BETWEEN 4 AND 6),
  CONSTRAINT users_pin_pair CHECK ((pin_hash IS NULL) = (pin_length IS NULL))
);

-- Partial unique indices: a soft-deleted row must not hold a username hostage (2.2.1).
CREATE UNIQUE INDEX users_username_key ON users (username) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX users_phone_key ON users (phone) WHERE phone IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX users_active_idx ON users (is_active) WHERE deleted_at IS NULL;
CREATE INDEX users_name_trgm_idx ON users USING gin (display_name_normalized gin_trgm_ops);

ALTER TABLE users ADD CONSTRAINT users_created_by_fkey FOREIGN KEY (created_by) REFERENCES users (id);
ALTER TABLE users ADD CONSTRAINT users_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users (id);
ALTER TABLE users ADD CONSTRAINT users_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES users (id);

-- ──────────────────────────── user_permissions (set semantics) ────────────────────────────
-- Admins hold every key implicitly and have no rows at all (2.6.1).

CREATE TABLE user_permissions (
  user_id        uuid NOT NULL REFERENCES users (id),
  permission_key text NOT NULL,
  granted_by     uuid NOT NULL REFERENCES users (id),
  granted_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission_key)
);

-- ─────────────────────────────────── sessions (2.8) ───────────────────────────────────

CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users (id),
  token_hash          text NOT NULL UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  idle_expires_at     timestamptz NOT NULL,
  is_locked           boolean NOT NULL DEFAULT false,
  locked_at           timestamptz,
  is_shared_device    boolean NOT NULL DEFAULT false,
  auth_method         auth_method NOT NULL DEFAULT 'password',
  device_label        text,
  user_agent          text,
  ip                  inet,
  revoked_at          timestamptz,
  revoke_reason       text
);

CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_idle_idx ON sessions (idle_expires_at);

-- ──────────────────────── login_attempts (append-only, 2.2.1) ────────────────────────
-- No creator: the attempt may be anonymous. Never updated, never deleted.

CREATE TABLE login_attempts (
  id                 bigserial PRIMARY KEY,
  username_attempted text NOT NULL,
  user_id            uuid REFERENCES users (id),
  ip                 inet,
  succeeded          boolean NOT NULL,
  attempted_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX login_attempts_username_idx ON login_attempts (username_attempted, attempted_at DESC);

-- ─────────────────── idempotency_keys (append-only, expiring; 2.9.1) ───────────────────
-- A retry after a timeout returns the stored response instead of writing twice (FR-1305).

CREATE TABLE idempotency_keys (
  key             text PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users (id),
  request_hash    text NOT NULL,
  response_status integer NOT NULL,
  response_body   jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- ─────────────────────────────────── settings (2.2.3) ───────────────────────────────────

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users (id)
);

-- ──────────────────────────── audit_log (append-only, 2.2.3) ────────────────────────────

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES users (id),
  action        audit_action NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text NOT NULL,
  entity_label  text NOT NULL,
  changes       jsonb NOT NULL DEFAULT '{}'::jsonb,
  note          text,
  related       jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id    uuid NOT NULL,
  session_id    uuid,
  auth_method   auth_method,
  ip            inet,
  user_agent    text
);

CREATE INDEX audit_log_occurred_idx ON audit_log (occurred_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, occurred_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_log_related_idx ON audit_log USING gin (related);

-- ─────────────────────── seed of the system settings (2.2.3) ───────────────────────

INSERT INTO settings (key, value) VALUES
  ('week_start',               '"sat"'),
  ('date_format',              '"dd/MM/yyyy"'),
  ('idle_lock_shared_minutes', '5'),
  ('idle_lock_default_minutes','30'),
  ('allow_negative_stock',     'true'),
  ('default_customer_currency','"IQD"'),
  ('rate_guard_percent',       '20'),
  ('settle_tolerance_iqd',     '250'),
  ('settle_tolerance_usd_cents','25'),
  ('pin_min_length_shared',    '6'),
  ('pin_min_length_personal',  '4'),
  ('allow_pin_switch_on_shared','true');

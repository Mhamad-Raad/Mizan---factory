/**
 * Seeds the first admin from the environment (spec 2.6.6, 2.13), flagged
 * `must_change_password` so the temporary password cannot survive the first sign-in, and the
 * "Walk-in customer" system record cash sales to unnamed buyers go to (A-33, Proposed — not
 * requested). Idempotent: running it again only reports what already exists.
 */
import { Client } from 'pg';
import { hash } from '@node-rs/argon2';
import { normalizeForSearch } from '@mizan/text';
import { ARGON2_OPTIONS } from '../auth/password.service.js';

const url = process.env.DATABASE_URL;
const username = (process.env.FIRST_ADMIN_USERNAME ?? 'admin').toLowerCase();
const password = process.env.FIRST_ADMIN_PASSWORD;

if (!url) throw new Error('DATABASE_URL must be set');
if (!password) throw new Error('FIRST_ADMIN_PASSWORD must be set to seed the first admin');

const client = new Client({ connectionString: url });
await client.connect();

const { rows } = await client.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [username]);
let adminId = rows[0]?.id ?? null;
if (adminId) {
  console.log(`first admin "${username}" already exists (${adminId})`);
} else {
  const passwordHash = await hash(password, ARGON2_OPTIONS);
  const displayName = process.env.FIRST_ADMIN_DISPLAY_NAME ?? 'Administrator';
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO users (username, display_name, display_name_normalized, role, password_hash,
                        must_change_password, is_active)
     VALUES ($1, $2, $3, 'admin', $4, true, true)
     RETURNING id`,
    [username, displayName, normalizeForSearch(displayName), passwordHash],
  );
  const id = inserted.rows[0]?.id as string;
  adminId = id;
  await client.query(
    `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, entity_label, changes, note, request_id)
     VALUES ($1, 'create', 'user', $1, $2, $3, $4, gen_random_uuid())`,
    [
      id,
      `Employee: ${username}`,
      JSON.stringify({ role: { old: null, new: 'admin' }, is_active: { old: null, new: true } }),
      'seeded from the environment at first boot',
    ],
  );
  console.log(`created first admin "${username}" (${id}) — must change password at first sign-in`);
}

/**
 * The walk-in customer (FR-501, FR-604 — Proposed — not requested). It is stored with an
 * English name and `is_system = true`; the screens render it from the glossary catalog so it
 * reads "زبون نقدي" or "کڕیاری نەقد" in the user's own language (D-016).
 */
const { rows: walkIn } = await client.query<{ id: string }>(
  'SELECT id FROM customers WHERE is_system AND deleted_at IS NULL',
);
if (walkIn.length > 0) {
  console.log(`walk-in customer already exists (${walkIn[0]?.id})`);
} else if (adminId) {
  const name = 'Walk-in customer';
  const created = await client.query<{ id: string }>(
    `INSERT INTO customers (name, name_normalized, settlement_currency, is_system, created_by, updated_by)
     VALUES ($1, $2,
             coalesce((SELECT (value #>> '{}')::currency FROM settings WHERE key = 'default_customer_currency'),
                      'IQD'::currency),
             true, $3, $3)
     RETURNING id`,
    [name, normalizeForSearch(name), adminId],
  );
  console.log(`created the walk-in customer (${created.rows[0]?.id})`);
}

await client.end();

/**
 * Seeds the first admin from the environment (spec 2.6.6, 2.13), flagged
 * `must_change_password` so the temporary password cannot survive the first sign-in.
 * Idempotent: running it again only reports that the admin already exists.
 */
import { Client } from 'pg';
import { hash } from '@node-rs/argon2';
import { ARGON2_OPTIONS } from '../auth/password.service.js';

const url = process.env.DATABASE_URL;
const username = (process.env.FIRST_ADMIN_USERNAME ?? 'admin').toLowerCase();
const password = process.env.FIRST_ADMIN_PASSWORD;

if (!url) throw new Error('DATABASE_URL must be set');
if (!password) throw new Error('FIRST_ADMIN_PASSWORD must be set to seed the first admin');

const client = new Client({ connectionString: url });
await client.connect();

const { rows } = await client.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [username]);
if (rows.length > 0) {
  console.log(`first admin "${username}" already exists (${rows[0]?.id})`);
} else {
  const passwordHash = await hash(password, ARGON2_OPTIONS);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO users (username, display_name, role, password_hash, must_change_password, is_active)
     VALUES ($1, $2, 'admin', $3, true, true)
     RETURNING id`,
    [username, process.env.FIRST_ADMIN_DISPLAY_NAME ?? 'Administrator', passwordHash],
  );
  const id = inserted.rows[0]?.id as string;
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

await client.end();

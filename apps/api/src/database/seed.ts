/**
 * First-boot seed (spec 2.6.6, 2.13): the first admin from the environment, flagged
 * `must_change_password` so the temporary password cannot survive the first sign-in, and the
 * "Walk-in customer" system record cash sales to unnamed buyers go to (A-33, Proposed — not
 * requested).
 *
 * The work is a function and the command line is a thin wrapper around it, exactly as the
 * migration runner is: a test can then call it in-process instead of shelling out, which is
 * what the only write that happens without a request behind it deserves. Idempotent: running
 * it again only reports what already exists.
 */
import { Client } from 'pg';
import { hash } from '@node-rs/argon2';
import { normalizeForSearch } from '@mizan/text';
import { ARGON2_OPTIONS } from '../auth/password.service.js';

export interface SeedOptions {
  connectionString: string;
  username: string;
  displayName?: string;
  password: string;
}

export interface SeedResult {
  admin: { id: string; created: boolean };
  walkInCustomer: { id: string; created: boolean };
}

export async function seed(options: SeedOptions): Promise<SeedResult> {
  const username = options.username.toLowerCase();
  const client = new Client({ connectionString: options.connectionString });
  await client.connect();

  try {
    const { rows } = await client.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [username]);
    let adminId = rows[0]?.id ?? null;
    let adminCreated = false;

    if (!adminId) {
      const passwordHash = await hash(options.password, ARGON2_OPTIONS);
      const displayName = options.displayName ?? 'Administrator';

      // The admin and its History row commit together, or neither does (rule 3): a user that
      // exists with no record of being created is exactly what the audit log is for.
      await client.query('BEGIN');
      try {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO users (username, display_name, display_name_normalized, role, password_hash,
                              must_change_password, is_active)
           VALUES ($1, $2, $3, 'admin', $4, true, true)
           RETURNING id`,
          [username, displayName, normalizeForSearch(displayName), passwordHash],
        );
        adminId = inserted.rows[0]?.id as string;
        await client.query(
          // `actor_user_id` is a uuid and `entity_id` is text, so the id is passed twice: one
          // parameter cannot be both, which is what made this insert fail every time until now.
          `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, entity_label,
                                  changes, note, request_id)
           VALUES ($1, 'create', 'user', $2, $3, $4, $5, gen_random_uuid())`,
          [
            adminId,
            adminId,
            `Employee: ${username}`,
            JSON.stringify({ role: { old: null, new: 'admin' }, is_active: { old: null, new: true } }),
            'seeded from the environment at first boot',
          ],
        );
        await client.query('COMMIT');
        adminCreated = true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    /**
     * The walk-in customer is stored with an English name and `is_system = true`; the screens
     * render it from the glossary catalog, so it reads زبون نقدي in Arabic and کڕیاری نەقد in
     * Kurdish without a translated column (D-016).
     */
    const { rows: existing } = await client.query<{ id: string }>(
      'SELECT id FROM customers WHERE is_system AND deleted_at IS NULL',
    );
    let walkInId = existing[0]?.id ?? null;
    let walkInCreated = false;

    if (!walkInId) {
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
      walkInId = created.rows[0]?.id as string;
      walkInCreated = true;
    }

    return {
      admin: { id: adminId as string, created: adminCreated },
      walkInCustomer: { id: walkInId, created: walkInCreated },
    };
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const connectionString = process.env.DATABASE_URL;
  const password = process.env.FIRST_ADMIN_PASSWORD;
  if (!connectionString) throw new Error('DATABASE_URL must be set');
  if (!password) throw new Error('FIRST_ADMIN_PASSWORD must be set to seed the first admin');

  const result = await seed({
    connectionString,
    username: process.env.FIRST_ADMIN_USERNAME ?? 'admin',
    displayName: process.env.FIRST_ADMIN_DISPLAY_NAME,
    password,
  });

  console.log(
    result.admin.created
      ? `created first admin (${result.admin.id}) — must change password at first sign-in`
      : `first admin already exists (${result.admin.id})`,
  );
  console.log(
    result.walkInCustomer.created
      ? `created the walk-in customer (${result.walkInCustomer.id})`
      : `walk-in customer already exists (${result.walkInCustomer.id})`,
  );
}

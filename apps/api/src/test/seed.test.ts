import { beforeEach, describe, expect, it } from 'vitest';
import { seed } from '../database/seed.js';
import { TEST_DATABASE_URL, resetDatabase, withDatabase } from './harness.js';

/**
 * The first-boot seed (spec 2.6.6, 2.13). It is the only write in the system that happens
 * without a request behind it, which is exactly why it needs a test: nothing else would
 * notice if it stopped recording what it did.
 */
describe('the first-boot seed', () => {
  // Reset before, never after: every other file in this suite does the same, and a teardown
  // that empties the database can land in the middle of the next file's setup — which is a
  // 401 in a hook and an hour of looking in the wrong place.
  beforeEach(async () => {
    await resetDatabase();
  });

  const options = {
    connectionString: TEST_DATABASE_URL,
    username: 'seed.admin',
    displayName: 'Administrator',
    password: 'seed-test-password-2026',
  };

  it('creates the first admin **with** its History row, and is safe to run twice', async () => {
    const first = await seed(options);
    expect(first.admin.created).toBe(true);
    expect(first.walkInCustomer.created).toBe(true);

    const after = await withDatabase(async (client) => {
      const users = await client.query<{ username: string; must_change_password: boolean; role: string }>(
        'SELECT username::text AS username, must_change_password, role::text AS role FROM users',
      );
      const audit = await client.query<{ action: string; entity_type: string; note: string }>(
        'SELECT action::text AS action, entity_type, note FROM audit_log',
      );
      const walkIn = await client.query<{ name: string; is_system: boolean }>(
        'SELECT name, is_system FROM customers WHERE is_system',
      );
      return { users: users.rows, audit: audit.rows, walkIn: walkIn.rows };
    });

    expect(after.users).toEqual([{ username: 'seed.admin', must_change_password: true, role: 'admin' }]);
    // The defect this pins: the audit insert used one parameter for a uuid column and a text
    // column, so it failed every time and the admin existed with no record of being created.
    expect(after.audit).toEqual([
      { action: 'create', entity_type: 'user', note: 'seeded from the environment at first boot' },
    ]);
    // The walk-in customer of A-33 arrives with the same seed (Proposed — not requested).
    expect(after.walkIn).toEqual([{ name: 'Walk-in customer', is_system: true }]);

    const second = await seed(options);
    expect(second.admin).toEqual({ id: first.admin.id, created: false });
    expect(second.walkInCustomer).toEqual({ id: first.walkInCustomer.id, created: false });

    const count = await withDatabase(async (client) => {
      const { rows } = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM users');
      return Number(rows[0]?.count);
    });
    expect(count).toBe(1);
  });
});

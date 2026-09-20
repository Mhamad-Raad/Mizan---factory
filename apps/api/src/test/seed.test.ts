import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL, resetDatabase, withDatabase } from './harness.js';

/**
 * The first-boot seed (spec 2.6.6, 2.13). It is the only write in the system that happens
 * without a request behind it, which is exactly why it needs a test: nothing else would
 * notice if it stopped recording what it did.
 */
describe('the first-boot seed', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    await resetDatabase();
  });

  function runSeed(username: string): string {
    return execFileSync('pnpm', ['--filter', '@mizan/api', 'seed'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        FIRST_ADMIN_USERNAME: username,
        FIRST_ADMIN_DISPLAY_NAME: 'Administrator',
        FIRST_ADMIN_PASSWORD: 'seed-test-password-2026',
      },
    });
  }

  it('creates the first admin **with** its History row, and is safe to run twice', async () => {
    const first = runSeed('seed.admin');
    expect(first).toMatch(/created first admin/);

    const after = await withDatabase(async (client) => {
      const users = await client.query<{ username: string; must_change_password: boolean; role: string }>(
        "SELECT username::text AS username, must_change_password, role::text AS role FROM users",
      );
      const audit = await client.query<{ action: string; entity_type: string; note: string }>(
        "SELECT action::text AS action, entity_type, note FROM audit_log",
      );
      const walkIn = await client.query<{ name: string; is_system: boolean }>(
        'SELECT name, is_system FROM customers WHERE is_system',
      );
      return { users: users.rows, audit: audit.rows, walkIn: walkIn.rows };
    });

    expect(after.users).toEqual([
      { username: 'seed.admin', must_change_password: true, role: 'admin' },
    ]);
    // The defect this pins: the audit insert used one parameter for a uuid and for text, so
    // it failed every time and the admin existed with no record of having been created.
    expect(after.audit).toEqual([
      {
        action: 'create',
        entity_type: 'user',
        note: 'seeded from the environment at first boot',
      },
    ]);
    // The walk-in customer of A-33 arrives with the same seed (Proposed — not requested).
    expect(after.walkIn).toEqual([{ name: 'Walk-in customer', is_system: true }]);

    const second = runSeed('seed.admin');
    expect(second).toMatch(/already exists/);
    expect(second).toMatch(/walk-in customer already exists/);

    const unchanged = await withDatabase(async (client) => {
      const { rows } = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM users');
      return Number(rows[0]?.count);
    });
    expect(unchanged).toBe(1);
  }, 60_000);
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { pendingMigrations } from '../database/migrate.js';
import { TEST_DATABASE_URL } from './harness.js';

/**
 * Rule 2, asked of the database itself, for every append-only table at once (security review,
 * finding 21). The per-feature tests each checked their own table; a table added later with a
 * forgotten REVOKE would have passed all of them.
 */
const APPEND_ONLY = [
  'audit_log',
  'login_attempts',
  'customer_ledger',
  'company_ledger',
  'stock_ledger',
  'lot_allocations',
  'global_rates',
  'customer_rates',
  'order_payment_type_changes',
] as const;

describe('what the application role may do to the database (rule 2, spec 2.13)', () => {
  let app: Client;

  beforeAll(async () => {
    app = new Client({ connectionString: TEST_DATABASE_URL });
    await app.connect();
  });
  afterAll(async () => {
    await app.end();
  });

  async function firstColumn(table: string): Promise<string> {
    const { rows } = await app.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position LIMIT 1`,
      [table],
    );
    const column = rows[0]?.column_name;
    if (!column) throw new Error(`${table} has no columns the application role can see — does it exist?`);
    return column;
  }

  for (const table of APPEND_ONLY) {
    it(`refuses UPDATE and DELETE on ${table}, and allows INSERT and SELECT`, async () => {
      const column = await firstColumn(table);
      // `WHERE false` touches no row: what is refused is the privilege, not a particular row.
      await expect(app.query(`UPDATE ${table} SET ${column} = ${column} WHERE false`)).rejects.toThrow(
        /permission denied/i,
      );
      await expect(app.query(`DELETE FROM ${table} WHERE false`)).rejects.toThrow(/permission denied/i);
      await expect(app.query(`TRUNCATE ${table}`)).rejects.toThrow(/permission denied|must be owner/i);

      const { rows } = await app.query<{ can_insert: boolean; can_select: boolean }>(
        `SELECT has_table_privilege(current_user, $1, 'INSERT') AS can_insert,
                has_table_privilege(current_user, $1, 'SELECT') AS can_select`,
        [table],
      );
      expect(rows[0]).toEqual({ can_insert: true, can_select: true });
    });
  }

  it('may read the list of applied migrations and nothing more, so the API needs no migrate role', async () => {
    expect(await pendingMigrations(TEST_DATABASE_URL)).toEqual([]);
    await expect(app.query(`DELETE FROM mizan_migrations WHERE false`)).rejects.toThrow(/permission denied/i);
    await expect(
      app.query(`INSERT INTO mizan_migrations (name, checksum) VALUES ('9999_fake.sql', 'x')`),
    ).rejects.toThrow(/permission denied/i);
  });
});

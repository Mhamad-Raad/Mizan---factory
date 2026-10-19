import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type { Env } from '../config/env.js';
import { Database } from '../database/pool.js';
import { TEST_DATABASE_URL } from './harness.js';

/**
 * A connection the server ends in the middle of a write (a database restart, the
 * idle-in-transaction timeout) fails that write, and only that write (D-115). Before, the
 * checked-out connection had no 'error' listener, and the event stopped the whole API — the
 * load test at the volumes of NFR-13 ended that way.
 */
describe('a connection lost inside a transaction (D-115)', () => {
  let database: Database;
  let killer: Client;

  beforeAll(async () => {
    database = new Database({ DATABASE_URL: TEST_DATABASE_URL } as Env);
    killer = new Client({ connectionString: TEST_DATABASE_URL });
    await killer.connect();
  });
  afterAll(async () => {
    await killer.end();
    await database.onModuleDestroy();
  });

  it('fails the write, keeps the process up, and the next write gets a working connection', async () => {
    const unhandled: unknown[] = [];
    const record = (error: unknown) => unhandled.push(error);
    process.on('uncaughtException', record);

    const write = database.transaction(async (tx) => {
      const { rows } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      // Ended while the transaction is open and idle: the moment no query is there to receive it.
      await killer.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await tx.query('SELECT 1');
    });
    await expect(write).rejects.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 100));
    process.off('uncaughtException', record);
    expect(unhandled).toEqual([]);

    // The broken connection was discarded, not handed back: ten writes in a row all succeed.
    for (let i = 0; i < 10; i += 1) {
      const value = await database.transaction(async (tx) => (await tx.query<{ n: number }>('SELECT 1 AS n')).rows[0]!.n);
      expect(value).toBe(1);
    }
  });
});

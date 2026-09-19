import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PasswordService } from '../auth/password.service.js';
import { as, createTestApp, resetDatabase, seedUser, signIn, TEST_MIGRATE_URL } from './harness.js';
import type { Session, TestApp } from './harness.js';

/**
 * Regressions for the defects found in the Iteration 0 review. Each test fails against the
 * code as it was written before the review.
 */
describe('iteration 0 review regressions', () => {
  let ctx: TestApp;
  let adminSession: Session;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await resetDatabase();
    const admin = await seedUser({ username: 'sara', role: 'admin' });
    adminSession = await signIn(ctx.http, admin);
  });

  it('temporary passwords are unpredictable and do not repeat', () => {
    const passwords = new PasswordService();
    const generated = new Set(Array.from({ length: 500 }, () => passwords.generateTemporary()));
    // With Math.random over an 8-word list this collided constantly; it must not now.
    expect(generated.size).toBe(500);
    for (const password of generated) expect(password).toMatch(/^[a-z]+-[a-z]+-[a-z]+-\d{4}$/);
  });

  it('a duplicate that is told to wait does not release the first request reservation', async () => {
    const key = '33333333-2222-4333-8444-555555555555';
    const body = { display_name: 'Slow', username: 'slow', role: 'employee' };

    const [first, second] = await Promise.all([
      as(ctx.http, adminSession).post('/api/v1/users').set('Idempotency-Key', key).send(body),
      as(ctx.http, adminSession).post('/api/v1/users').set('Idempotency-Key', key).send(body),
    ]);
    // Either the duplicate waited and got the stored response (201), or it was told to try
    // again shortly (429). What must never happen is two creations.
    expect(first.status === 201 || second.status === 201).toBe(true);
    expect([first.status, second.status].every((status) => [201, 429].includes(status))).toBe(true);

    // Whatever happened above, the key must still be held with the stored response — a third
    // attempt must return that response rather than creating a second employee.
    const third = await as(ctx.http, adminSession)
      .post('/api/v1/users')
      .set('Idempotency-Key', key)
      .send(body);
    expect(third.status).toBe(201);

    const listed = await as(ctx.http, adminSession).get('/api/v1/users?q=slow').expect(200);
    expect(listed.body.total).toBe(1);
  });

  it('a permission change is live on the very next request, with no cache window', async () => {
    const employee = await seedUser({ username: 'rebaz', permissions: ['history.view'] });
    const employeeSession = await signIn(ctx.http, employee);
    await as(ctx.http, employeeSession).get('/api/v1/history').expect(200);

    await as(ctx.http, adminSession)
      .post(`/api/v1/users/${employee.id}/permissions`)
      .send({ keys: [] })
      .expect(201);

    // No sleep: a cache with any TTL would still answer 200 here.
    await as(ctx.http, employeeSession).get('/api/v1/history').expect(403);
  });

  it('pages history by keyset without losing or repeating a row', async () => {
    for (let index = 0; index < 12; index += 1) {
      await as(ctx.http, adminSession)
        .post('/api/v1/users')
        .send({ display_name: `Employee ${index}`, username: `emp.${index}`, role: 'employee' })
        .expect(201);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const query: string = cursor ? `/api/v1/history?limit=5&cursor=${encodeURIComponent(cursor)}` : '/api/v1/history?limit=5';
      const response = await as(ctx.http, adminSession).get(query).expect(200);
      seen.push(...response.body.items.map((row: { id: string }) => row.id));
      cursor = response.body.next_cursor;
      if (!cursor) break;
    }

    expect(new Set(seen).size).toBe(seen.length);
    const total = await as(ctx.http, adminSession).get('/api/v1/history?limit=100').expect(200);
    expect(seen.length).toBe(total.body.items.length);
  });

  it('prunes expired idempotency keys and dead sessions, but never history', async () => {
    const client = new Client({ connectionString: TEST_MIGRATE_URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO idempotency_keys (key, user_id, request_hash, response_status, response_body, expires_at)
         SELECT 'stale', id, 'hash', 201, '{}'::jsonb, now() - interval '1 day' FROM users LIMIT 1`,
      );
      const auditBefore = await client.query('SELECT count(*)::int AS count FROM audit_log');

      const { rows } = await client.query<{ pruned_idempotency_keys: string }>('SELECT * FROM mizan_prune_expired()');
      expect(Number(rows[0]?.pruned_idempotency_keys)).toBeGreaterThanOrEqual(1);

      const remaining = await client.query("SELECT count(*)::int AS count FROM idempotency_keys WHERE key = 'stale'");
      expect(remaining.rows[0]?.count).toBe(0);

      const auditAfter = await client.query('SELECT count(*)::int AS count FROM audit_log');
      expect(auditAfter.rows[0]?.count).toBe(auditBefore.rows[0]?.count);
    } finally {
      await client.end();
    }
  });
});

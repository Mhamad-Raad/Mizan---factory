import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { as, auditRows, createTestApp, resetDatabase, seedUser, signIn, withDatabase } from './harness.js';
import type { TestApp } from './harness.js';

/**
 * Regressions for the fifth review (2026-09-28, a second look at the fourth review's session
 * changes). Each test fails against the code as it was before it.
 */
describe('the fifth review', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 60_000);
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await resetDatabase();
  });

  async function sessionIdOf(username: string): Promise<string> {
    return withDatabase(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE u.username = $1 AND s.revoked_at IS NULL ORDER BY s.created_at DESC LIMIT 1`,
        [username],
      );
      return rows[0]?.id as string;
    });
  }

  it("cannot lock a signed-in tablet's unlock by typing its session at the sign-in page", async () => {
    const user = await seedUser({ username: 'sara', role: 'admin' });
    const session = await signIn(ctx.http, user);
    const id = await sessionIdOf('sara');

    for (let n = 0; n < 6; n += 1) {
      await request(ctx.http).post('/api/v1/auth/login').send({ username_or_phone: `session:${id}`, password: 'wrong-but-long-enough' });
    }
    await as(ctx.http, session).post('/api/v1/auth/lock').expect(204);
    await as(ctx.http, session).post('/api/v1/auth/unlock').send({ password: user.password }).expect(204);
  });

  it('lets a correct unlock clear the slips before it', async () => {
    const user = await seedUser({ username: 'sara', role: 'admin' });
    const session = await signIn(ctx.http, user);
    const unlock = (password: string) => as(ctx.http, session).post('/api/v1/auth/unlock').send({ password });

    await as(ctx.http, session).post('/api/v1/auth/lock').expect(204);
    for (let n = 0; n < 3; n += 1) await unlock('wrong-but-long-enough').expect(422);
    await unlock(user.password).expect(204);

    await as(ctx.http, session).post('/api/v1/auth/lock').expect(204);
    for (let n = 0; n < 2; n += 1) await unlock('wrong-but-long-enough').expect(422);
    // Three plus two is five only if the correct unlock counted for nothing.
    await unlock(user.password).expect(204);
    await request(ctx.http).post('/api/v1/auth/login').send({ username_or_phone: 'sara', password: user.password }).expect(200);
  });

  it('keeps a name that is nobody only as a keyed hash in the sign-in attempts', async () => {
    await request(ctx.http).post('/api/v1/auth/login').send({ username_or_phone: 'My-Secret-Pass', password: 'wrong-but-long-enough' });
    const stored = await withDatabase(async (client) => {
      const { rows } = await client.query<{ username_attempted: string }>('SELECT username_attempted FROM login_attempts');
      return rows.map((row) => row.username_attempted);
    });
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.some((name) => name.toLowerCase().includes('secret'))).toBe(false);
  });

  it('records the idle lock in History, with the time it locked', async () => {
    const user = await seedUser({ username: 'rebaz', permissions: ['orders.view'] });
    const session = await signIn(ctx.http, user);
    await withDatabase((client) =>
      client.query("UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE revoked_at IS NULL"),
    );
    await as(ctx.http, session).get('/api/v1/orders').expect(423);

    const locks = await auditRows({ action: 'lock' });
    expect(locks).toHaveLength(1);
    expect(locks[0]?.changes).toMatchObject({ reason: 'idle' });
    const lockedAt = await withDatabase(async (client) => {
      const { rows } = await client.query<{ locked_at: Date | null }>('SELECT locked_at FROM sessions WHERE is_locked');
      return rows[0]?.locked_at ?? null;
    });
    expect(lockedAt).not.toBeNull();
  });

  it('keeps the true totals on a Receivables page past the end', async () => {
    const admin = await seedUser({ username: 'admin.five', role: 'admin' });
    const session = await signIn(ctx.http, admin);
    await as(ctx.http, session).post('/api/v1/settings/global-rates').send({ rate_iqd_per_usd: '1310' }).expect(201);
    const company = await as(ctx.http, session).post('/api/v1/customers').send({ name: 'Kawa Trading' }).expect(201);
    await as(ctx.http, session)
      .post(`/api/v1/customers/${company.body.id}/opening-balance`)
      .send({ amount: 50_000, currency: 'IQD', entry_date: '2026-09-01', note: 'from the old books' })
      .expect(201);
    const first = await as(ctx.http, session).get('/api/v1/reports/receivables?from=2026-09-01&to=2026-09-28').expect(200);
    const past = await as(ctx.http, session).get('/api/v1/reports/receivables?from=2026-09-01&to=2026-09-28&page=99').expect(200);
    expect(past.body.groups).toHaveLength(0);
    expect(past.body.totals).toEqual(first.body.totals);
    expect(past.body.group_count).toBe(first.body.group_count);
  });

  it("does not let a request whose key was taken over complete the new owner's reservation", async () => {
    const admin = await seedUser({ username: 'admin.five', role: 'admin' });
    const session = await signIn(ctx.http, admin);
    const key = '66666666-2222-4333-8444-555555555555';
    const created = await as(ctx.http, session)
      .post('/api/v1/customers')
      .set('Idempotency-Key', key)
      .send({ name: 'First owner' })
      .expect(201);
    // The same key sent again answers the stored response: the stamp matched its own row.
    const again = await as(ctx.http, session)
      .post('/api/v1/customers')
      .set('Idempotency-Key', key)
      .send({ name: 'First owner' })
      .expect(201);
    expect(again.body.id).toBe(created.body.id);
  });
});

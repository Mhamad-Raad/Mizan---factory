import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  as,
  auditRows,
  createTestApp,
  resetDatabase,
  seedUser,
  signIn,
  TEST_DATABASE_URL,
} from './harness.js';
import type { Session, TestApp } from './harness.js';

describe('history and settings (FR-901, FR-902, FR-1107)', () => {
  let ctx: TestApp;
  let admin: Awaited<ReturnType<typeof seedUser>>;
  let adminSession: Session;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await resetDatabase();
    admin = await seedUser({ username: 'sara', role: 'admin', displayName: 'Sara' });
    adminSession = await signIn(ctx.http, admin);
  });

  describe('the audit log is append-only (rule 2, spec 2.13)', () => {
    it('the application role cannot update or delete an audit row, at the database level', async () => {
      await as(ctx.http, adminSession)
        .post('/api/v1/users')
        .send({ display_name: 'Rebaz', username: 'rebaz', role: 'employee' })
        .expect(201);

      const client = new Client({ connectionString: TEST_DATABASE_URL });
      await client.connect();
      try {
        await expect(client.query("UPDATE audit_log SET note = 'tampered'")).rejects.toThrow(
          /permission denied/i,
        );
        await expect(client.query('DELETE FROM audit_log')).rejects.toThrow(/permission denied/i);
        await expect(client.query('UPDATE login_attempts SET succeeded = true')).rejects.toThrow(
          /permission denied/i,
        );
      } finally {
        await client.end();
      }

      // …and the rows are still there.
      expect((await auditRows({ action: 'create' })).length).toBe(1);
    });

    it('there is no API route that edits or deletes History', async () => {
      const rows = await auditRows();
      await as(ctx.http, adminSession).delete('/api/v1/history').expect(404);
      await as(ctx.http, adminSession).patch('/api/v1/history').expect(404);
      expect((await auditRows()).length).toBe(rows.length);
    });
  });

  describe('the History page (FR-902)', () => {
    it('returns newest first with a cursor, and the cursor pages backwards without gaps', async () => {
      for (let index = 0; index < 5; index += 1) {
        await as(ctx.http, adminSession)
          .post('/api/v1/users')
          .send({
            display_name: `Employee ${index}`,
            username: `employee${index}`,
            role: 'employee',
          })
          .expect(201);
      }

      const first = await as(ctx.http, adminSession).get('/api/v1/history?limit=3').expect(200);
      expect(first.body.items).toHaveLength(3);
      expect(first.body.next_cursor).toBeTruthy();

      const second = await as(ctx.http, adminSession)
        .get(`/api/v1/history?limit=3&cursor=${first.body.next_cursor}`)
        .expect(200);

      const firstIds = first.body.items.map((row: { id: string }) => row.id);
      const secondIds = second.body.items.map((row: { id: string }) => row.id);
      expect(firstIds.some((id: string) => secondIds.includes(id))).toBe(false);
      expect(Number(firstIds[0])).toBeGreaterThan(Number(firstIds[2]));
    });

    it('shows an employee only their own actions without history.view_all (spec 2.6.4)', async () => {
      const employee = await seedUser({ username: 'rebaz', permissions: ['history.view'] });
      const employeeSession = await signIn(ctx.http, employee);

      await as(ctx.http, adminSession)
        .post('/api/v1/users')
        .send({ display_name: 'Someone', username: 'someone', role: 'employee' })
        .expect(201);

      const scoped = await as(ctx.http, employeeSession).get('/api/v1/history').expect(200);
      const actors = new Set(
        scoped.body.items.map((row: { actor_user_id: string }) => row.actor_user_id),
      );
      expect([...actors]).toEqual([employee.id]);

      // Asking for someone else's rows does not widen the scope.
      const attempted = await as(ctx.http, employeeSession)
        .get(`/api/v1/history?done_by=${admin.id}`)
        .expect(200);
      expect(
        attempted.body.items.every(
          (row: { actor_user_id: string }) => row.actor_user_id === employee.id,
        ),
      ).toBe(true);
    });

    it('lets everyone read their own activity even without history.view (spec 1.5.2 rule 3)', async () => {
      const employee = await seedUser({ username: 'rebaz', permissions: [] });
      const employeeSession = await signIn(ctx.http, employee);

      await as(ctx.http, employeeSession).get('/api/v1/history').expect(403);
      const mine = await as(ctx.http, employeeSession).get('/api/v1/history/me').expect(200);
      expect(
        mine.body.items.every(
          (row: { actor_user_id: string }) => row.actor_user_id === employee.id,
        ),
      ).toBe(true);
    });

    it('filters by date in Asia/Baghdad days and by action', async () => {
      await as(ctx.http, adminSession)
        .post('/api/v1/users')
        .send({ display_name: 'Rebaz', username: 'rebaz', role: 'employee' })
        .expect(201);

      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Baghdad' });
      const todayRows = await as(ctx.http, adminSession)
        .get(`/api/v1/history?from=${today}&to=${today}&action=create`)
        .expect(200);
      expect(todayRows.body.items.length).toBeGreaterThan(0);
      expect(todayRows.body.items.every((row: { action: string }) => row.action === 'create')).toBe(
        true,
      );

      const longAgo = await as(ctx.http, adminSession)
        .get('/api/v1/history?from=2020-01-01&to=2020-01-02')
        .expect(200);
      expect(longAgo.body.items).toHaveLength(0);
    });

    it('carries the actor name and the request id for support', async () => {
      await as(ctx.http, adminSession)
        .post('/api/v1/users')
        .send({ display_name: 'Rebaz', username: 'rebaz', role: 'employee' })
        .expect(201);

      const rows = await as(ctx.http, adminSession)
        .get('/api/v1/history?action=create')
        .expect(200);
      expect(rows.body.items[0].actor_display_name).toBe('Sara');
      expect(rows.body.items[0].request_id).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('settings (FR-1107)', () => {
    it('gives an employee the settings their own screens are subject to, and nothing else', async () => {
      const employee = await seedUser({ username: 'rebaz' });
      const employeeSession = await signIn(ctx.http, employee);

      const response = await as(ctx.http, employeeSession).get('/api/v1/settings').expect(200);
      // The two formatting keys plus the rules an employee's own forms must respect, so a
      // screen can warn before the API refuses: the stock and settlement rules from I1.
      expect(Object.keys(response.body).sort()).toEqual([
        'allow_negative_stock',
        'date_format',
        'default_customer_currency',
        'settle_tolerance_iqd',
        'settle_tolerance_usd_cents',
        'week_start',
      ]);
      // An admin-only key stays admin-only.
      expect('idle_lock_shared_minutes' in response.body).toBe(false);
    });

    it('gives an admin everything and logs a change old -> new', async () => {
      const before = await as(ctx.http, adminSession).get('/api/v1/settings').expect(200);
      expect(before.body.idle_lock_shared_minutes).toBe(5);

      await as(ctx.http, adminSession)
        .patch('/api/v1/settings')
        .send({ idle_lock_shared_minutes: 7 })
        .expect(200);

      const after = await as(ctx.http, adminSession).get('/api/v1/settings').expect(200);
      expect(after.body.idle_lock_shared_minutes).toBe(7);

      const rows = await auditRows({ action: 'settings_change' });
      expect(rows[0]?.changes).toEqual({ idle_lock_shared_minutes: { old: 5, new: 7 } });
    });

    it('refuses a key that is not editable in this iteration', async () => {
      // `go_live_date` is seeded but belongs to no iteration's Settings page yet, so an admin
      // who sends it is told rather than quietly ignored. (The PIN policy moved out of this
      // test in I5, which is the iteration that gave it a screen.)
      await as(ctx.http, adminSession)
        .patch('/api/v1/settings')
        .send({ go_live_date: '2026-10-01' })
        .expect(422);
    });

    it('opens the stock and money rules that selling needs (I1)', async () => {
      await as(ctx.http, adminSession)
        .patch('/api/v1/settings')
        .send({ allow_negative_stock: false })
        .expect(200);

      const after = await as(ctx.http, adminSession).get('/api/v1/settings').expect(200);
      expect(after.body).toMatchObject({ allow_negative_stock: false });
    });

    it('refuses an employee outright', async () => {
      const employee = await seedUser({ username: 'rebaz' });
      const employeeSession = await signIn(ctx.http, employee);
      await as(ctx.http, employeeSession)
        .patch('/api/v1/settings')
        .send({ week_start: 'mon' })
        .expect(403);
    });
  });

  describe('idempotent writes (FR-1305, spec 2.9.1)', () => {
    it('a retry with the same key and body returns the stored response instead of writing twice', async () => {
      const key = '11111111-2222-4333-8444-555555555555';
      const first = await as(ctx.http, adminSession)
        .post('/api/v1/users')
        .set('Idempotency-Key', key)
        .send({ display_name: 'Rebaz', username: 'rebaz', role: 'employee' })
        .expect(201);

      const retry = await as(ctx.http, adminSession)
        .post('/api/v1/users')
        .set('Idempotency-Key', key)
        .send({ display_name: 'Rebaz', username: 'rebaz', role: 'employee' })
        .expect(201);

      expect(retry.body.user.id).toBe(first.body.user.id);
      const listed = await as(ctx.http, adminSession).get('/api/v1/users?q=rebaz').expect(200);
      expect(listed.body.total).toBe(1);
    });

    it('two identical requests sent at the same time write only once', async () => {
      const key = '77777777-2222-4333-8444-555555555555';
      const send = () =>
        as(ctx.http, adminSession)
          .post('/api/v1/users')
          .set('Idempotency-Key', key)
          .send({ display_name: 'Twin', username: 'twin', role: 'employee' });

      const [first, second] = await Promise.all([send(), send()]);
      const statuses = [first.status, second.status].sort();
      // One creates; the other either waits for that answer or is told to try again shortly.
      expect(statuses[0]).toBe(201);
      expect([201, 429]).toContain(statuses[1]);

      const listed = await as(ctx.http, adminSession).get('/api/v1/users?q=twin').expect(200);
      expect(listed.body.total).toBe(1);
    });

    it('a failed request releases its key, so the corrected retry can run', async () => {
      const key = '55555555-2222-4333-8444-555555555555';
      await as(ctx.http, adminSession)
        .post('/api/v1/users')
        .set('Idempotency-Key', key)
        .send({ display_name: '', username: 'bad', role: 'employee' })
        .expect(422);

      await as(ctx.http, adminSession)
        .post('/api/v1/users')
        .set('Idempotency-Key', key)
        .send({ display_name: 'Fixed', username: 'fixed', role: 'employee' })
        .expect(201);
    });

    it('refuses the same key with a different body', async () => {
      const key = '99999999-2222-4333-8444-555555555555';
      await as(ctx.http, adminSession)
        .post('/api/v1/users')
        .set('Idempotency-Key', key)
        .send({ display_name: 'Rebaz', username: 'rebaz', role: 'employee' })
        .expect(201);

      const mismatch = await as(ctx.http, adminSession)
        .post('/api/v1/users')
        .set('Idempotency-Key', key)
        .send({ display_name: 'Someone else', username: 'other', role: 'employee' })
        .expect(422);
      expect(mismatch.body.error.code).toBe('IDEMPOTENCY_MISMATCH');
    });
  });
});

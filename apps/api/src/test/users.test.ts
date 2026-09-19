import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PRESETS, expandImplied } from '@mizan/permissions';
import { as, auditRows, createTestApp, resetDatabase, seedUser, signIn } from './harness.js';
import type { Session, TestApp } from './harness.js';

describe('users and permissions (FR-102 to FR-108, FR-201 to FR-206)', () => {
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

  describe('creating an employee (FR-201)', () => {
    it('returns the temporary password once and forces a change at first sign-in', async () => {
      const response = await as(ctx.http, adminSession)
        .post('/api/v1/users')
        .send({ display_name: 'Rebaz Ahmed', username: 'rebaz', role: 'employee', preset_key: 'sales' })
        .expect(201);

      expect(response.body.temporary_password).toBeTruthy();
      expect(response.body.user.must_change_password).toBe(true);
      expect(response.body.user).not.toHaveProperty('password_hash');

      // The temporary password is never written to History (spec 2.4.4).
      const serialised = JSON.stringify(await auditRows());
      expect(serialised).not.toContain(response.body.temporary_password);
    });

    it('applies the preset as an ordinary set of keys, with implied keys expanded', async () => {
      const created = await as(ctx.http, adminSession)
        .post('/api/v1/users')
        .send({ display_name: 'Rebaz', username: 'rebaz', role: 'employee', preset_key: 'sales' })
        .expect(201);

      const permissions = await as(ctx.http, adminSession)
        .get(`/api/v1/users/${created.body.user.id}/permissions`)
        .expect(200);

      expect(new Set(permissions.body.keys)).toEqual(expandImplied(PRESETS.sales.keys));
      expect(permissions.body.preset_key).toBe('sales');
    });

    it('refuses a duplicate username and a duplicate phone', async () => {
      await as(ctx.http, adminSession)
        .post('/api/v1/users')
        .send({ display_name: 'Rebaz', username: 'rebaz', role: 'employee', phone: '07501234567' })
        .expect(201);

      const duplicateName = await as(ctx.http, adminSession)
        .post('/api/v1/users')
        .send({ display_name: 'Another', username: 'rebaz', role: 'employee' })
        .expect(422);
      expect(duplicateName.body.error.fields[0].message_key).toBe('errors:field.username_taken');

      const duplicatePhone = await as(ctx.http, adminSession)
        .post('/api/v1/users')
        .send({ display_name: 'Another', username: 'other', role: 'employee', phone: '+9647501234567' })
        .expect(422);
      expect(duplicatePhone.body.error.fields[0].message_key).toBe('errors:field.phone_taken');
    });

    it('records the creation in History', async () => {
      const created = await as(ctx.http, adminSession)
        .post('/api/v1/users')
        .send({ display_name: 'Rebaz', username: 'rebaz', role: 'employee' })
        .expect(201);

      const rows = await auditRows({ action: 'create', entityId: created.body.user.id });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.changes).toMatchObject({ username: { old: null, new: 'rebaz' } });
      expect(rows[0]?.actor_user_id).toBe(admin.id);
    });
  });

  describe('editing (FR-202) and optimistic locking (FR-1308)', () => {
    it('logs each change as old -> new per field', async () => {
      const employee = await seedUser({ username: 'rebaz', displayName: 'Rebaz' });
      const current = await as(ctx.http, adminSession).get(`/api/v1/users/${employee.id}`).expect(200);

      await as(ctx.http, adminSession)
        .patch(`/api/v1/users/${employee.id}`)
        .send({ display_name: 'Rebaz Ahmed', version: current.body.version })
        .expect(200);

      const rows = await auditRows({ action: 'update', entityId: employee.id });
      expect(rows[0]?.changes).toEqual({ display_name: { old: 'Rebaz', new: 'Rebaz Ahmed' } });
    });

    it('refuses a stale version instead of overwriting silently', async () => {
      const employee = await seedUser({ username: 'rebaz' });
      const current = await as(ctx.http, adminSession).get(`/api/v1/users/${employee.id}`).expect(200);

      await as(ctx.http, adminSession)
        .patch(`/api/v1/users/${employee.id}`)
        .send({ display_name: 'First', version: current.body.version })
        .expect(200);

      const conflict = await as(ctx.http, adminSession)
        .patch(`/api/v1/users/${employee.id}`)
        .send({ display_name: 'Second', version: current.body.version })
        .expect(409);
      expect(conflict.body.error.code).toBe('VERSION_CONFLICT');
    });
  });

  describe('admin safety (FR-107, spec 2.6.6)', () => {
    it('an admin cannot demote themselves', async () => {
      const me = await as(ctx.http, adminSession).get(`/api/v1/users/${admin.id}`).expect(200);
      const response = await as(ctx.http, adminSession)
        .patch(`/api/v1/users/${admin.id}`)
        .send({ role: 'employee', version: me.body.version })
        .expect(409);
      expect(response.body.error.code).toBe('LAST_ADMIN');
    });

    it('an admin cannot deactivate themselves', async () => {
      const me = await as(ctx.http, adminSession).get(`/api/v1/users/${admin.id}`).expect(200);
      await as(ctx.http, adminSession)
        .post(`/api/v1/users/${admin.id}/deactivate`)
        .send({ version: me.body.version })
        .expect(409);
    });

    it('the last active admin cannot be deactivated or demoted by anyone', async () => {
      const second = await seedUser({ username: 'second.admin', role: 'admin' });
      const secondSession = await signIn(ctx.http, second);

      // Two admins: deactivating one is allowed.
      const target = await as(ctx.http, secondSession).get(`/api/v1/users/${admin.id}`).expect(200);
      await as(ctx.http, secondSession)
        .post(`/api/v1/users/${admin.id}/deactivate`)
        .send({ version: target.body.version })
        .expect(201);

      // One admin left: they cannot be demoted, even by themselves.
      const me = await as(ctx.http, secondSession).get(`/api/v1/users/${second.id}`).expect(200);
      const refused = await as(ctx.http, secondSession)
        .patch(`/api/v1/users/${second.id}`)
        .send({ role: 'employee', version: me.body.version })
        .expect(409);
      expect(refused.body.error.code).toBe('LAST_ADMIN');
    });
  });

  describe('deactivation (FR-203)', () => {
    it('ends the sessions of the deactivated user and logs the change', async () => {
      const employee = await seedUser({ username: 'rebaz', permissions: ['history.view'] });
      const employeeSession = await signIn(ctx.http, employee);
      await as(ctx.http, employeeSession).get('/api/v1/history').expect(200);

      const target = await as(ctx.http, adminSession).get(`/api/v1/users/${employee.id}`).expect(200);
      await as(ctx.http, adminSession)
        .post(`/api/v1/users/${employee.id}/deactivate`)
        .send({ version: target.body.version })
        .expect(201);

      await as(ctx.http, employeeSession).get('/api/v1/history').expect(401);
      const rows = await auditRows({ action: 'status_change', entityId: employee.id });
      expect(rows[0]?.changes).toEqual({ is_active: { old: true, new: false } });
    });

    it('there is no delete endpoint for users anywhere', async () => {
      const employee = await seedUser({ username: 'rebaz' });
      await as(ctx.http, adminSession).delete(`/api/v1/users/${employee.id}`).expect(404);
    });
  });

  describe('password reset (FR-108, FR-202)', () => {
    it('issues a temporary password, forces a change and revokes every session', async () => {
      const employee = await seedUser({ username: 'rebaz', permissions: ['history.view'] });
      const employeeSession = await signIn(ctx.http, employee);

      const reset = await as(ctx.http, adminSession)
        .post(`/api/v1/users/${employee.id}/reset-password`)
        .expect(201);
      expect(reset.body.temporary_password).toBeTruthy();

      await as(ctx.http, employeeSession).get('/api/v1/history').expect(401);

      const signedIn = await signIn(ctx.http, {
        ...employee,
        password: reset.body.temporary_password,
      });
      const me = await as(ctx.http, signedIn).get('/api/v1/auth/me').expect(200);
      expect(me.body.user.must_change_password).toBe(true);
    });
  });

  describe('the permission editor (FR-103, FR-204)', () => {
    it('replaces the whole set, expands implied keys and logs old set -> new set', async () => {
      const employee = await seedUser({ username: 'rebaz' });

      await as(ctx.http, adminSession)
        .post(`/api/v1/users/${employee.id}/permissions`)
        .send({ keys: ['orders.create'], preset_key: null })
        .expect(201);

      const permissions = await as(ctx.http, adminSession)
        .get(`/api/v1/users/${employee.id}/permissions`)
        .expect(200);
      expect(permissions.body.keys).toEqual(
        [...expandImplied(['orders.create'])].sort(),
      );

      const rows = await auditRows({ action: 'permission_change', entityId: employee.id });
      expect(rows[0]?.changes).toMatchObject({ permissions: { old: [], new: permissions.body.keys } });
    });

    it('takes effect at the next request, with no re-login (FR-103)', async () => {
      const employee = await seedUser({ username: 'rebaz' });
      const employeeSession = await signIn(ctx.http, employee);
      await as(ctx.http, employeeSession).get('/api/v1/history').expect(403);

      await as(ctx.http, adminSession)
        .post(`/api/v1/users/${employee.id}/permissions`)
        .send({ keys: ['history.view'] })
        .expect(201);

      await as(ctx.http, employeeSession).get('/api/v1/history').expect(200);

      await as(ctx.http, adminSession)
        .post(`/api/v1/users/${employee.id}/permissions`)
        .send({ keys: [] })
        .expect(201);
      await as(ctx.http, employeeSession).get('/api/v1/history').expect(403);
    });

    it('rejects a key that is not in the catalog', async () => {
      const employee = await seedUser({ username: 'rebaz' });
      const response = await as(ctx.http, adminSession)
        .post(`/api/v1/users/${employee.id}/permissions`)
        .send({ keys: ['orders.destroy'] })
        .expect(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('refuses to store rows for an admin, who holds everything implicitly', async () => {
      await as(ctx.http, adminSession)
        .post(`/api/v1/users/${admin.id}/permissions`)
        .send({ keys: ['history.view'] })
        .expect(422);
    });
  });

  describe('the user list (FR-206)', () => {
    it('hides deactivated users behind a filter', async () => {
      await seedUser({ username: 'active.one', displayName: 'Active' });
      await seedUser({ username: 'gone', displayName: 'Gone', isActive: false });

      const listed = await as(ctx.http, adminSession).get('/api/v1/users').expect(200);
      expect(listed.body.items.map((user: { username: string }) => user.username)).not.toContain('gone');

      const withInactive = await as(ctx.http, adminSession)
        .get('/api/v1/users?include_inactive=true')
        .expect(200);
      expect(withInactive.body.items.map((user: { username: string }) => user.username)).toContain('gone');
    });

    it('finds a name typed in another script (FR-1205)', async () => {
      await seedUser({ username: 'kurdish.name', displayName: 'ڕێباز' });
      const found = await as(ctx.http, adminSession)
        .get(`/api/v1/users?q=${encodeURIComponent('ريباز')}`)
        .expect(200);
      expect(found.body.items.map((user: { display_name: string }) => user.display_name)).toContain('ڕێباز');
    });

    it('serves the directory to any signed-in user, with no other fields', async () => {
      const employee = await seedUser({ username: 'rebaz' });
      const employeeSession = await signIn(ctx.http, employee);

      const directory = await as(ctx.http, employeeSession).get('/api/v1/users/directory').expect(200);
      expect(directory.body[0]).toEqual({
        id: expect.any(String),
        display_name: expect.any(String),
        role: expect.any(String),
        is_active: expect.any(Boolean),
      });
    });
  });
});

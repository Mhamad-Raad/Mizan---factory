import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  as,
  auditRows,
  createTestApp,
  resetDatabase,
  seedUser,
  signIn,
  withDatabase,
} from './harness.js';
import type { TestApp } from './harness.js';

describe('authentication (FR-101, FR-106, FR-108, spec 2.8)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await resetDatabase();
  });

  it('signs in with a username and sets an httpOnly session cookie', async () => {
    const user = await seedUser({ username: 'sara', role: 'admin' });
    const response = await request(ctx.http)
      .post('/api/v1/auth/login')
      .send({ username_or_phone: 'sara', password: user.password })
      .expect(200);

    expect(response.body.user.username).toBe('sara');
    expect(response.body.user).not.toHaveProperty('password_hash');

    const cookies = response.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((cookie) => cookie.startsWith('mizan_session='));
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Lax');
    // The CSRF cookie is readable on purpose — double submit needs the client to echo it.
    expect(cookies.find((cookie) => cookie.startsWith('mizan_csrf='))).not.toContain('HttpOnly');
  });

  it('accepts the phone number as an alias of the username', async () => {
    const user = await seedUser({ username: 'rebaz', phone: '07501234567' });
    await request(ctx.http)
      .post('/api/v1/auth/login')
      .send({ username_or_phone: '+964 750 123 4567', password: user.password })
      .expect(200);
  });

  it('answers a wrong username and a wrong password identically', async () => {
    await seedUser({ username: 'sara' });
    const wrongUser = await request(ctx.http)
      .post('/api/v1/auth/login')
      .send({ username_or_phone: 'nobody', password: 'whatever-long-enough' })
      .expect(401);
    const wrongPassword = await request(ctx.http)
      .post('/api/v1/auth/login')
      .send({ username_or_phone: 'sara', password: 'wrong-but-long-enough' })
      .expect(401);

    expect(wrongUser.body.error.code).toBe('UNAUTHENTICATED');
    expect(wrongUser.body.error.params).toEqual(wrongPassword.body.error.params);
  });

  describe('sign-in throttling (2.8)', () => {
    const attempt = (username: string, password: string) =>
      request(ctx.http).post('/api/v1/auth/login').send({ username_or_phone: username, password });

    /** Moves every recorded attempt back in time, as if the minutes had passed. */
    const minutesPass = (minutes: number) =>
      withDatabase((client) =>
        client.query(
          `UPDATE login_attempts SET attempted_at = attempted_at - make_interval(mins => $1)`,
          [minutes],
        ),
      );

    it('says how many attempts are left after each wrong password', async () => {
      await seedUser({ username: 'sara' });
      const left: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const response = await attempt('sara', 'wrong-but-long-enough').expect(401);
        left.push(response.body.error.params.attempts_left);
        expect(response.body.error.params.lockout_minutes).toBe(15);
      }
      expect(left).toEqual([4, 3, 2, 1]);
    });

    it('locks on the fifth wrong password, says so at once, and records it', async () => {
      const user = await seedUser({ username: 'sara' });
      for (let i = 0; i < 4; i += 1) await attempt('sara', 'wrong-but-long-enough').expect(401);

      const fifth = await attempt('sara', 'wrong-but-long-enough').expect(429);
      expect(fifth.body.error.code).toBe('RATE_LIMITED');
      expect(fifth.body.error.params.minutes).toBe(15);

      // Even the right password is refused while the lockout lasts.
      await attempt('sara', user.password).expect(429);
      expect((await auditRows({ action: 'lockout' })).length).toBeGreaterThan(0);
    });

    it('does not extend the lockout when somebody keeps trying', async () => {
      const user = await seedUser({ username: 'sara' });
      for (let i = 0; i < 5; i += 1) await attempt('sara', 'wrong-but-long-enough');

      await minutesPass(10);
      for (let i = 0; i < 3; i += 1) {
        const refused = await attempt('sara', 'wrong-but-long-enough').expect(429);
        expect(refused.body.error.params.minutes).toBe(5);
      }

      // Fifteen minutes after the fifth failure the door opens, however often it was knocked on.
      await minutesPass(5);
      await attempt('sara', user.password).expect(200);
    });

    it('gives a full five attempts again after a successful sign-in', async () => {
      const user = await seedUser({ username: 'sara' });
      for (let i = 0; i < 3; i += 1) await attempt('sara', 'wrong-but-long-enough');
      await attempt('sara', user.password).expect(200);

      const next = await attempt('sara', 'wrong-but-long-enough').expect(401);
      expect(next.body.error.params.attempts_left).toBe(4);
    });

    it('locks a username that does not exist the same way', async () => {
      for (let i = 0; i < 4; i += 1) await attempt('nobody', 'whatever-long-enough').expect(401);
      await attempt('nobody', 'whatever-long-enough').expect(429);
    });

    it('counts every spelling of a phone number and the username as one account', async () => {
      const user = await seedUser({ username: 'rebaz', phone: '07501234567' });
      const spellings = ['07501234567', '+9647501234567', '00964 750-123-4567', '٠٧٥٠١٢٣٤٥٦٧'];
      const left: number[] = [];
      for (const spelling of spellings) {
        const response = await attempt(spelling, 'wrong-but-long-enough').expect(401);
        left.push(response.body.error.params.attempts_left);
      }
      expect(left).toEqual([4, 3, 2, 1]);

      const fifth = await attempt('REBAZ', 'wrong-but-long-enough').expect(429);
      expect(fifth.body.error.params.minutes).toBe(15);
      // Locked under every name the account answers to, with the right password too.
      await attempt('rebaz', user.password).expect(429);
      await attempt('+964 750 123 4567', user.password).expect(429);
    });

    it('counts the spellings of an unknown phone number as one', async () => {
      for (const spelling of ['07709999999', '+964 770 999 9999', '009647709999999', '0770-999-9999']) {
        await attempt(spelling, 'whatever-long-enough').expect(401);
      }
      await attempt('(0770) 999 9999', 'whatever-long-enough').expect(429);
    });

    it('gives a burst of parallel guesses no more than five tries', async () => {
      await seedUser({ username: 'sara' });
      const responses = await Promise.all(
        Array.from({ length: 12 }, () => attempt('sara', 'wrong-but-long-enough')),
      );
      const statuses = responses.map((response) => response.status).sort();
      expect(statuses.filter((status) => status === 401)).toHaveLength(4);
      expect(statuses.filter((status) => status === 429)).toHaveLength(8);

      const recorded = await withDatabase((client) =>
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM login_attempts WHERE username_attempted = 'sara' AND NOT succeeded`,
        ),
      );
      expect(Number(recorded.rows[0]?.count)).toBe(5);
    });
  });

  it('refuses a deactivated account with its own message', async () => {
    const user = await seedUser({ username: 'ahmed', isActive: false });
    const response = await request(ctx.http)
      .post('/api/v1/auth/login')
      .send({ username_or_phone: 'ahmed', password: user.password })
      .expect(401);
    expect(response.body.error.params.reason).toBe('deactivated');
  });

  it('records every sign-in and sign-out in History', async () => {
    const user = await seedUser({ username: 'sara', role: 'admin' });
    const session = await signIn(ctx.http, user);
    await as(ctx.http, session).post('/api/v1/auth/logout').expect(204);

    const actions = (await auditRows()).map((row) => row.action);
    expect(actions).toContain('login');
    expect(actions).toContain('logout');
  });

  it('never writes a password or a token into the audit log', async () => {
    const user = await seedUser({ username: 'sara', role: 'admin' });
    await signIn(ctx.http, user);
    const serialised = JSON.stringify(await auditRows());
    expect(serialised).not.toContain(user.password);
    expect(serialised).not.toContain('password_hash');
    expect(serialised).not.toContain('token_hash');
  });

  describe('lock and unlock (FR-106)', () => {
    it('refuses every other call with 423 while locked, and unlocks with the password', async () => {
      const user = await seedUser({ username: 'sara', role: 'admin' });
      const session = await signIn(ctx.http, user);

      await as(ctx.http, session).post('/api/v1/auth/lock').expect(204);
      await as(ctx.http, session).get('/api/v1/users').expect(423);
      // `me` stays reachable so the lock screen can show who is signed in.
      const me = await as(ctx.http, session).get('/api/v1/auth/me').expect(200);
      expect(me.body.is_locked).toBe(true);

      await as(ctx.http, session).post('/api/v1/auth/unlock').send({ password: user.password }).expect(204);
      await as(ctx.http, session).get('/api/v1/users').expect(200);

      const actions = (await auditRows()).map((row) => row.action);
      expect(actions).toContain('lock');
      expect(actions).toContain('unlock');
    });

    it('refuses to unlock with a wrong password', async () => {
      const user = await seedUser({ username: 'sara', role: 'admin' });
      const session = await signIn(ctx.http, user);
      await as(ctx.http, session).post('/api/v1/auth/lock').expect(204);
      await as(ctx.http, session)
        .post('/api/v1/auth/unlock')
        .send({ password: 'not-the-password' })
        .expect(422);
      await as(ctx.http, session).get('/api/v1/users').expect(423);
    });

    it('shares the sign-in lockout, and refuses even the right password while it lasts', async () => {
      const user = await seedUser({ username: 'sara', role: 'admin' });
      const session = await signIn(ctx.http, user);
      await as(ctx.http, session).post('/api/v1/auth/lock').expect(204);

      const unlock = (password: string) =>
        as(ctx.http, session).post('/api/v1/auth/unlock').send({ password });
      const first = await unlock('not-the-password').expect(422);
      expect(first.body.error.fields[0].params.attempts_left).toBe(4);
      for (let i = 0; i < 3; i += 1) await unlock('not-the-password').expect(422);

      const fifth = await unlock('not-the-password').expect(429);
      expect(fifth.body.error.params.minutes).toBe(15);
      await unlock(user.password).expect(429);
    });
  });

  describe('changing a password (FR-108)', () => {
    it('requires the current password and clears the must-change flag', async () => {
      const user = await seedUser({ username: 'sara', role: 'admin', mustChangePassword: true });
      const session = await signIn(ctx.http, user);

      await as(ctx.http, session)
        .post('/api/v1/auth/change-password')
        .send({ current: 'wrong-but-long-enough', new: 'a-brand-new-password' })
        .expect(422);

      await as(ctx.http, session)
        .post('/api/v1/auth/change-password')
        .send({ current: user.password, new: 'a-brand-new-password' })
        .expect(204);

      const me = await as(ctx.http, session).get('/api/v1/auth/me').expect(200);
      expect(me.body.user.must_change_password).toBe(false);
      expect((await auditRows({ action: 'password_change' })).length).toBe(1);
    });

    it('does not check the current password while the account is locked out', async () => {
      const user = await seedUser({ username: 'sara', role: 'admin' });
      const session = await signIn(ctx.http, user);
      for (let i = 0; i < 5; i += 1) {
        await request(ctx.http)
          .post('/api/v1/auth/login')
          .send({ username_or_phone: 'sara', password: 'wrong-but-long-enough' });
      }

      const refused = await as(ctx.http, session)
        .post('/api/v1/auth/change-password')
        .send({ current: user.password, new: 'a-brand-new-password' })
        .expect(429);
      expect(refused.body.error.code).toBe('RATE_LIMITED');
      expect(refused.body.error.params.minutes).toBe(15);
    });

    it('counts a wrong current password toward the same lockout', async () => {
      const user = await seedUser({ username: 'sara', role: 'admin' });
      const session = await signIn(ctx.http, user);
      const change = (current: string) =>
        as(ctx.http, session).post('/api/v1/auth/change-password').send({ current, new: 'a-brand-new-password' });

      const first = await change('wrong-but-long-enough').expect(422);
      expect(first.body.error.fields[0].params.attempts_left).toBe(4);
      for (let i = 0; i < 3; i += 1) await change('wrong-but-long-enough').expect(422);
      await change('wrong-but-long-enough').expect(429);
      await change(user.password).expect(429);
      // The Login page sees the same lockout.
      await request(ctx.http)
        .post('/api/v1/auth/login')
        .send({ username_or_phone: 'sara', password: user.password })
        .expect(429);
    });

    it('signs out every other session of the user, and keeps this one', async () => {
      const user = await seedUser({ username: 'sara', role: 'admin' });
      const here = await signIn(ctx.http, user);
      const elsewhere = await signIn(ctx.http, user);

      await as(ctx.http, here)
        .post('/api/v1/auth/change-password')
        .send({ current: user.password, new: 'a-brand-new-password' })
        .expect(204);

      await as(ctx.http, here).get('/api/v1/auth/me').expect(200);
      await as(ctx.http, elsewhere).get('/api/v1/auth/me').expect(401);
      const [row] = await auditRows({ action: 'password_change' });
      expect(row?.changes).toEqual({ other_sessions_signed_out: 1 });
    });

    it('refuses everything but the change itself until a flagged user has chosen a password', async () => {
      const user = await seedUser({ username: 'sara', role: 'admin', mustChangePassword: true });
      const session = await signIn(ctx.http, user);

      const refused = await as(ctx.http, session).get('/api/v1/users').expect(403);
      expect(refused.body.error).toMatchObject({
        code: 'PASSWORD_CHANGE_REQUIRED',
        message_key: 'errors:PASSWORD_CHANGE_REQUIRED',
      });
      await as(ctx.http, session).get('/api/v1/history/me').expect(403);
      await as(ctx.http, session)
        .post('/api/v1/customers')
        .send({ name: 'Not yet' })
        .expect(403);

      // What the change-password screen needs stays open.
      const me = await as(ctx.http, session).get('/api/v1/auth/me').expect(200);
      expect(me.body.user.must_change_password).toBe(true);
      await as(ctx.http, session)
        .post('/api/v1/auth/change-password')
        .send({ current: user.password, new: 'a-brand-new-password' })
        .expect(204);

      await as(ctx.http, session).get('/api/v1/users').expect(200);
    });

    it('lets a flagged user sign out', async () => {
      const user = await seedUser({ username: 'sara', mustChangePassword: true });
      const session = await signIn(ctx.http, user);
      await as(ctx.http, session).post('/api/v1/auth/logout').expect(204);
    });

    it('refuses a short password, the username itself and a common password', async () => {
      const user = await seedUser({ username: 'sara', role: 'admin' });
      const session = await signIn(ctx.http, user);

      for (const candidate of ['short', 'sara', 'password123']) {
        await as(ctx.http, session)
          .post('/api/v1/auth/change-password')
          .send({ current: user.password, new: candidate })
          .expect(422);
      }
    });
  });

  describe('session state', () => {
    it('refuses a request with no cookie', async () => {
      await request(ctx.http).get('/api/v1/users').expect(401);
    });

    it('refuses a revoked session immediately', async () => {
      const user = await seedUser({ username: 'sara', role: 'admin' });
      const session = await signIn(ctx.http, user);
      await as(ctx.http, session).post('/api/v1/auth/logout').expect(204);
      await as(ctx.http, session).get('/api/v1/users').expect(401);
    });

    it('refuses a session whose user was deactivated, without waiting for revocation', async () => {
      const admin = await seedUser({ username: 'sara', role: 'admin' });
      const employee = await seedUser({ username: 'rebaz' });
      const employeeSession = await signIn(ctx.http, employee);
      const adminSession = await signIn(ctx.http, admin);

      const target = await as(ctx.http, adminSession).get(`/api/v1/users/${employee.id}`).expect(200);
      await as(ctx.http, adminSession)
        .post(`/api/v1/users/${employee.id}/deactivate`)
        .send({ version: target.body.version })
        .expect(201);

      await as(ctx.http, employeeSession).get('/api/v1/auth/me').expect(401);
    });
  });

  describe('CSRF (spec 2.8, 2.13)', () => {
    it('refuses a state-changing request whose CSRF header does not match the cookie', async () => {
      const user = await seedUser({ username: 'sara', role: 'admin' });
      const session = await signIn(ctx.http, user);

      await request(ctx.http)
        .post('/api/v1/auth/lock')
        .set('Cookie', session.cookies)
        .set('X-CSRF-Token', 'forged')
        .expect(403);
    });

    it('allows a safe method without the header', async () => {
      const user = await seedUser({ username: 'sara', role: 'admin' });
      const session = await signIn(ctx.http, user);
      await request(ctx.http).get('/api/v1/auth/me').set('Cookie', session.cookies).expect(200);
    });
  });
});

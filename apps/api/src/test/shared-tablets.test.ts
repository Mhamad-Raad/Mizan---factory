import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { as, auditRows, createTestApp, resetDatabase, seedUser, signIn, withDatabase } from './harness.js';
import type { SeededUser, TestApp } from './harness.js';

/**
 * Shared floor tablets (FR-106, FR-1304, spec 2.8) — the acceptance criteria of iteration 5 in
 * order: a ticket is required for PIN sign-in and is bound to one user; six digits on a shared
 * device; five wrong PINs fall back to the password; a switch revokes the previous session;
 * tickets die with a password reset and with the account; the admin can turn PIN switching off;
 * and every audit row written from a PIN session carries `ticket_pin`.
 *
 * The thing under test is a *pair* of secrets. A PIN is four to six digits typed on a tablet
 * that everybody on the floor holds, so on its own it is worth very little; what makes it
 * acceptable is that it only works on a browser the employee signed into with their password
 * within the last seven days. Every test here is about one half of that pair failing.
 */
describe('shared tablets: PIN sign-in and user switching (FR-106)', () => {
  let ctx: TestApp;
  let admin: SeededUser;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await resetDatabase();
    admin = await seedUser({ username: 'dara', role: 'admin', displayName: 'Dara' });
  });

  /** A password sign-in on this browser, which is what hands out the ticket. */
  async function signInWithPassword(
    user: SeededUser,
    options: { shared?: boolean; label?: string } = {},
  ): Promise<{ cookies: string[]; ticket: string }> {
    const response = await request(ctx.http)
      .post('/api/v1/auth/login')
      .send({
        username_or_phone: user.username,
        password: user.password,
        is_shared_device: options.shared ?? true,
        device_label: options.label ?? 'Floor tablet 2',
      })
      .expect(200);
    expect(response.body.device_ticket, 'a password sign-in issues a device ticket').toBeTruthy();
    return { cookies: response.headers['set-cookie'] as unknown as string[], ticket: response.body.device_ticket };
  }

  function pinLogin(
    body: Record<string, unknown>,
    cookies?: string[],
  ): request.Test {
    const call = request(ctx.http).post('/api/v1/auth/login');
    if (cookies) call.set('Cookie', cookies);
    return call.send(body);
  }

  async function setPin(user: SeededUser, pin: string): Promise<void> {
    const session = await signIn(ctx.http, user);
    await as(ctx.http, session)
      .post('/api/v1/auth/pin')
      .send({ pin, current_password: user.password })
      .expect(204);
  }

  // ─────────────────────────── the PIN itself (FR-106) ───────────────────────────

  describe('setting a PIN', () => {
    it('is the employee\'s own business and needs their password', async () => {
      const rebaz = await seedUser({ username: 'rebaz', displayName: 'Rebaz' });
      const session = await signIn(ctx.http, rebaz);

      // Somebody else's password does not do, and neither does nothing.
      await as(ctx.http, session)
        .post('/api/v1/auth/pin')
        .send({ pin: '123456', current_password: 'not-my-password' })
        .expect(422);

      await as(ctx.http, session)
        .post('/api/v1/auth/pin')
        .send({ pin: '123456', current_password: rebaz.password })
        .expect(204);

      const me = await as(ctx.http, session).get('/api/v1/auth/me').expect(200);
      expect(me.body.user.has_pin).toBe(true);
    });

    it('records the change in History without recording the PIN', async () => {
      const rebaz = await seedUser({ username: 'rebaz' });
      await setPin(rebaz, '4321');

      // The harness signs in first, which writes its own `password_change`; the PIN is the last.
      const rows = await auditRows({ action: 'password_change', entityId: rebaz.id });
      expect(rows.at(-1)?.changes).toEqual({ pin_length: { old: null, new: 4 } });
      expect(JSON.stringify(rows)).not.toContain('4321');
    });

    it('refuses anything that is not four to six digits', async () => {
      const rebaz = await seedUser({ username: 'rebaz' });
      const session = await signIn(ctx.http, rebaz);
      for (const pin of ['123', '1234567', 'abcd', '12 34']) {
        await as(ctx.http, session)
          .post('/api/v1/auth/pin')
          .send({ pin, current_password: rebaz.password })
          .expect(422);
      }
    });

    it('is removed by sending null, which takes PIN sign-in away with it', async () => {
      const rebaz = await seedUser({ username: 'rebaz' });
      await setPin(rebaz, '123456');
      const { ticket } = await signInWithPassword(rebaz);

      const session = await signIn(ctx.http, rebaz);
      await as(ctx.http, session)
        .post('/api/v1/auth/pin')
        .send({ pin: null, current_password: rebaz.password })
        .expect(204);

      const refused = await pinLogin({ ticket, pin: '123456', is_shared_device: true }).expect(401);
      expect(refused.body.error.params.reason).toBe('no_pin');
    });
  });

  // ─────────────────────── the ticket half of the pair (2.8) ───────────────────────

  describe('the device ticket', () => {
    it('is required: a PIN alone signs nobody in', async () => {
      const rebaz = await seedUser({ username: 'rebaz' });
      await setPin(rebaz, '123456');

      const refused = await pinLogin({ ticket: 'not-a-real-ticket', pin: '123456' }).expect(401);
      expect(refused.body.error.params.reason).toBe('ticket_invalid');
    });

    it('is bound to the user it was issued to: Sara\'s ticket plus Rebaz\'s PIN is nothing', async () => {
      const sara = await seedUser({ username: 'sara', displayName: 'Sara' });
      const rebaz = await seedUser({ username: 'rebaz', displayName: 'Rebaz' });
      await setPin(sara, '111111');
      await setPin(rebaz, '222222');

      const { ticket: sarasTicket } = await signInWithPassword(sara);

      // Rebaz's PIN against Sara's ticket resolves to *Sara*, whose PIN it is not.
      const refused = await pinLogin({ ticket: sarasTicket, pin: '222222', is_shared_device: true }).expect(401);
      expect(refused.body.error.params.reason).toBe('invalid_pin');

      // And it is Sara who signs in with it, not whoever asks.
      const signedIn = await pinLogin({ ticket: sarasTicket, pin: '111111', is_shared_device: true }).expect(200);
      expect(signedIn.body.user.username).toBe('sara');
    });

    it('signs in with the PIN and records the method on the session and on History', async () => {
      const rebaz = await seedUser({ username: 'rebaz', permissions: ['customers.view'] });
      await setPin(rebaz, '123456');
      const { ticket } = await signInWithPassword(rebaz);

      const quick = await pinLogin({ ticket, pin: '123456', is_shared_device: true, device_label: 'Floor tablet 2' })
        .expect(200);
      const cookies = quick.headers['set-cookie'] as unknown as string[];
      expect(quick.body.device_ticket, 'a PIN sign-in issues no new ticket').toBeUndefined();

      const me = await request(ctx.http).get('/api/v1/auth/me').set('Cookie', cookies).expect(200);
      expect(me.body.auth_method).toBe('ticket_pin');
      expect(me.body.device_label).toBe('Floor tablet 2');

      const logins = await auditRows({ action: 'login' });
      const pinLoginRow = logins.at(-1);
      expect(pinLoginRow?.changes).toMatchObject({ auth_method: 'ticket_pin', shared_device: true });
    });

    it('carries `ticket_pin` onto every audit row the session writes', async () => {
      const rebaz = await seedUser({ username: 'rebaz', permissions: ['customers.view', 'customers.create'] });
      await setPin(rebaz, '123456');
      const { ticket } = await signInWithPassword(rebaz);
      const quick = await pinLogin({ ticket, pin: '123456', is_shared_device: true }).expect(200);
      const cookies = quick.headers['set-cookie'] as unknown as string[];
      const csrf = cookies
        .find((cookie) => cookie.startsWith('mizan_csrf='))!
        .split(';')[0]!
        .split('=')[1]!;

      await request(ctx.http)
        .post('/api/v1/customers')
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrf)
        .send({ name: 'Recorded from a tablet' })
        .expect(201);

      const method = await withDatabase(async (client) => {
        const { rows } = await client.query<{ auth_method: string }>(
          `SELECT auth_method FROM audit_log
            WHERE action = 'create' AND entity_type = 'customer' ORDER BY id DESC LIMIT 1`,
        );
        return rows[0]?.auth_method;
      });
      // A disputed payment recorded from a shared tablet must be traceable to the method (2.8).
      expect(method).toBe('ticket_pin');
    });

    it('expires after seven days, and then only the password will do', async () => {
      const rebaz = await seedUser({ username: 'rebaz' });
      await setPin(rebaz, '123456');
      const { ticket } = await signInWithPassword(rebaz);

      await withDatabase(async (client) => {
        await client.query("UPDATE device_tickets SET expires_at = now() - interval '1 minute'");
      });

      const refused = await pinLogin({ ticket, pin: '123456', is_shared_device: true }).expect(401);
      expect(refused.body.error.params.reason).toBe('ticket_invalid');
    });
  });

  // ─────────────────────── the PIN rules on a shared device ───────────────────────

  describe('the rules of a shared device', () => {
    it('refuses a PIN shorter than six digits and says what to do', async () => {
      const rebaz = await seedUser({ username: 'rebaz' });
      await setPin(rebaz, '1234');
      const { ticket } = await signInWithPassword(rebaz, { shared: true });

      const refused = await pinLogin({ ticket, pin: '1234', is_shared_device: true }).expect(401);
      expect(refused.body.error.params).toMatchObject({ reason: 'pin_too_short', min: 6 });
    });

    it('accepts the same four-digit PIN on a personal phone', async () => {
      const rebaz = await seedUser({ username: 'rebaz' });
      await setPin(rebaz, '1234');
      const { ticket } = await signInWithPassword(rebaz, { shared: false, label: null as unknown as string });

      await pinLogin({ ticket, pin: '1234', is_shared_device: false }).expect(200);
    });

    it('falls back to the password after five wrong PINs, and the ticket is gone', async () => {
      const rebaz = await seedUser({ username: 'rebaz' });
      await setPin(rebaz, '123456');
      const { ticket } = await signInWithPassword(rebaz);

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const wrong = await pinLogin({ ticket, pin: '000000', is_shared_device: true }).expect(401);
        expect(wrong.body.error.params).toMatchObject({ reason: 'invalid_pin', attempts_left: 5 - attempt });
      }
      const fifth = await pinLogin({ ticket, pin: '000000', is_shared_device: true }).expect(401);
      expect(fifth.body.error.params.reason).toBe('pin_attempts_exhausted');

      // Even the right PIN is now worthless on this browser: the ticket is revoked.
      const afterwards = await pinLogin({ ticket, pin: '123456', is_shared_device: true }).expect(401);
      expect(afterwards.body.error.params.reason).toBe('ticket_invalid');

      // The password still works, and issues a fresh ticket.
      const recovered = await signInWithPassword(rebaz);
      await pinLogin({ ticket: recovered.ticket, pin: '123456', is_shared_device: true }).expect(200);
    });

    it('is switched off entirely when the admin says so', async () => {
      const rebaz = await seedUser({ username: 'rebaz' });
      await setPin(rebaz, '123456');
      const { ticket } = await signInWithPassword(rebaz);

      const adminSession = await signIn(ctx.http, admin);
      await as(ctx.http, adminSession)
        .patch('/api/v1/settings')
        .send({ allow_pin_switch_on_shared: false })
        .expect(200);

      const refused = await pinLogin({ ticket, pin: '123456', is_shared_device: true }).expect(401);
      expect(refused.body.error.params.reason).toBe('pin_switch_disabled');

      // Claiming to be a personal phone does not help: the ticket remembers that it was
      // issued on a shared tablet, so the shared rule follows the ticket.
      const claiming = await pinLogin({ ticket, pin: '123456', is_shared_device: false }).expect(401);
      expect(claiming.body.error.params.reason).toBe('pin_switch_disabled');
    });
  });

  // ─────────────────────── unlocking and handing the tablet over ───────────────────────

  describe('the lock screen', () => {
    it('unlocks the same session with the PIN, keeping its drafts and its method', async () => {
      const rebaz = await seedUser({ username: 'rebaz' });
      await setPin(rebaz, '123456');
      const session = await signIn(ctx.http, rebaz);

      await as(ctx.http, session).post('/api/v1/auth/lock').expect(204);
      await as(ctx.http, session).get('/api/v1/customers').expect(423);

      await as(ctx.http, session).post('/api/v1/auth/unlock').send({ pin: '123456' }).expect(204);
      const me = await as(ctx.http, session).get('/api/v1/auth/me').expect(200);
      expect(me.body.is_locked).toBe(false);
      // The session was established with a password and still says so (D-034).
      expect(me.body.auth_method).toBe('password');

      const [unlock] = (await auditRows({ action: 'unlock' })).slice(-1);
      expect(unlock.changes).toEqual({ unlocked_with: 'pin' });
    });

    it('asks for the password after five wrong PINs on the same session', async () => {
      const rebaz = await seedUser({ username: 'rebaz' });
      await setPin(rebaz, '123456');
      const session = await signIn(ctx.http, rebaz);
      await as(ctx.http, session).post('/api/v1/auth/lock').expect(204);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await as(ctx.http, session).post('/api/v1/auth/unlock').send({ pin: '000000' }).expect(422);
      }
      const exhausted = await as(ctx.http, session)
        .post('/api/v1/auth/unlock')
        .send({ pin: '123456' })
        .expect(422);
      expect(exhausted.body.error.fields[0].message_key).toBe('auth:pin_attempts_exhausted');

      // The password still unlocks it, and the count starts again.
      await as(ctx.http, session).post('/api/v1/auth/unlock').send({ password: rebaz.password }).expect(204);
      await as(ctx.http, session).post('/api/v1/auth/lock').expect(204);
      await as(ctx.http, session).post('/api/v1/auth/unlock').send({ pin: '123456' }).expect(204);
    });

    it('hands the tablet over: the previous session is revoked and both halves are in History', async () => {
      const sara = await seedUser({ username: 'sara', displayName: 'Sara' });
      const rebaz = await seedUser({ username: 'rebaz', displayName: 'Rebaz' });
      await setPin(rebaz, '222222');

      // Rebaz proved himself with his password on this tablet earlier in the day.
      const rebazTicket = (await signInWithPassword(rebaz)).ticket;
      // Sara is the one holding it now, and she locks it.
      const sarasSignIn = await signInWithPassword(sara);
      const sarasCookies = sarasSignIn.cookies;
      const csrf = sarasCookies
        .find((cookie) => cookie.startsWith('mizan_csrf='))!
        .split(';')[0]!
        .split('=')[1]!;
      await request(ctx.http)
        .post('/api/v1/auth/lock')
        .set('Cookie', sarasCookies)
        .set('X-CSRF-Token', csrf)
        .expect(204);

      // The previous session's cookie is on the tablet, so the double-submit token goes with
      // it — a cross-site POST must not be able to switch users (2.13).
      const handover = await request(ctx.http)
        .post('/api/v1/auth/login')
        .set('Cookie', sarasCookies)
        .set('X-CSRF-Token', csrf)
        .send({ ticket: rebazTicket, pin: '222222', is_shared_device: true, switch_from_session: true })
        .expect(200);
      expect(handover.body.user.username).toBe('rebaz');

      // Sara's session is gone — not merely locked — so nothing she left open can be used.
      await request(ctx.http).get('/api/v1/auth/me').set('Cookie', sarasCookies).expect(401);

      const switches = await auditRows({ action: 'switch_user' });
      expect(switches).toHaveLength(1);
      expect(switches[0]).toMatchObject({ actor_user_id: sara.id });
      expect(switches[0].changes).toMatchObject({ to_user: 'Rebaz' });
    });

    it('does not revoke anything when the tablet was simply idle, with no session to switch from', async () => {
      const rebaz = await seedUser({ username: 'rebaz' });
      await setPin(rebaz, '123456');
      const { ticket } = await signInWithPassword(rebaz);

      await pinLogin({ ticket, pin: '123456', is_shared_device: true, switch_from_session: true }).expect(200);
      expect(await auditRows({ action: 'switch_user' })).toHaveLength(0);
    });
  });

  describe('one live ticket per browser', () => {
    it('retires the ticket a browser says it is replacing', async () => {
      const rebaz = await seedUser({ username: 'rebaz' });
      await setPin(rebaz, '123456');
      const first = await signInWithPassword(rebaz);

      // The client presents what it holds, and the server hands back a fresh one.
      const second = await request(ctx.http)
        .post('/api/v1/auth/login')
        .send({
          username_or_phone: rebaz.username,
          password: rebaz.password,
          is_shared_device: true,
          device_label: 'Floor tablet 2',
          replaces_ticket: first.ticket,
        })
        .expect(200);

      await pinLogin({ ticket: first.ticket, pin: '123456', is_shared_device: true }).expect(401);
      await pinLogin({ ticket: second.body.device_ticket, pin: '123456', is_shared_device: true }).expect(200);
    });

    it('keeps at most five live tickets, however many browsers forget theirs', async () => {
      const rebaz = await seedUser({ username: 'rebaz' });
      await setPin(rebaz, '123456');

      // Seven sign-ins that never present a ticket — private windows, a second phone, a
      // cleared tablet. Without a bound this table grows live secrets forever (2.2.5).
      const tickets: string[] = [];
      for (let index = 0; index < 7; index += 1) tickets.push((await signInWithPassword(rebaz)).ticket);

      const live = await withDatabase(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM device_tickets
            WHERE user_id = $1 AND revoked_at IS NULL`,
          [rebaz.id],
        );
        return Number(rows[0]?.count ?? 0);
      });
      expect(live).toBeLessThanOrEqual(5);

      // The newest still works, and the one retired first does not.
      await pinLogin({ ticket: tickets.at(-1)!, pin: '123456', is_shared_device: true }).expect(200);
      await pinLogin({ ticket: tickets[0]!, pin: '123456', is_shared_device: true }).expect(401);
    });
  });

  // ─────────────────────── the admin's Sessions tab (FR-1304) ───────────────────────

  describe('sessions and tickets, from the admin side', () => {
    it('lists the sessions and the browsers that may sign this employee in with a PIN', async () => {
      const rebaz = await seedUser({ username: 'rebaz' });
      await setPin(rebaz, '123456');
      await signInWithPassword(rebaz, { label: 'Floor tablet 2' });

      const adminSession = await signIn(ctx.http, admin);
      const listed = await as(ctx.http, adminSession).get(`/api/v1/users/${rebaz.id}/sessions`).expect(200);

      expect(listed.body.sessions.length).toBeGreaterThan(0);
      // One per password sign-in — the harness's and the tablet's (2.8).
      expect(listed.body.device_tickets.length).toBeGreaterThanOrEqual(1);
      expect(listed.body.device_tickets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            device_label: 'Floor tablet 2',
            is_shared_device: true,
            revoked_at: null,
          }),
        ]),
      );
      // A hash is a secret even in an admin's response.
      expect(JSON.stringify(listed.body)).not.toContain('ticket_hash');
    });

    it('revokes PIN sign-in on every device, and the next switch asks for the password', async () => {
      const rebaz = await seedUser({ username: 'rebaz', displayName: 'Rebaz' });
      await setPin(rebaz, '123456');
      const { ticket } = await signInWithPassword(rebaz);

      const adminSession = await signIn(ctx.http, admin);
      const live = (await as(ctx.http, adminSession).get(`/api/v1/users/${rebaz.id}/sessions`).expect(200)).body
        .device_tickets.filter((row: { revoked_at: string | null }) => row.revoked_at === null).length;

      const revoked = await as(ctx.http, adminSession)
        .delete(`/api/v1/users/${rebaz.id}/device-tickets`)
        .expect(200);
      expect(revoked.body.revoked).toBe(live);

      const refused = await pinLogin({ ticket, pin: '123456', is_shared_device: true }).expect(401);
      expect(refused.body.error.params.reason).toBe('ticket_invalid');

      const [row] = (await auditRows({ entityId: rebaz.id })).filter(
        (entry) => entry.note === 'PIN sign-in revoked on every device',
      );
      expect(row.changes).toEqual({ device_tickets: { old: live, new: 0 } });
    });

    it('revokes the tickets when the password is reset', async () => {
      const rebaz = await seedUser({ username: 'rebaz' });
      await setPin(rebaz, '123456');
      const { ticket } = await signInWithPassword(rebaz);

      const adminSession = await signIn(ctx.http, admin);
      await as(ctx.http, adminSession).post(`/api/v1/users/${rebaz.id}/reset-password`).expect(201);

      const refused = await pinLogin({ ticket, pin: '123456', is_shared_device: true }).expect(401);
      expect(refused.body.error.params.reason).toBe('ticket_invalid');
    });

    it('revokes the tickets when the account is deactivated', async () => {
      const rebaz = await seedUser({ username: 'rebaz' });
      await setPin(rebaz, '123456');
      const { ticket } = await signInWithPassword(rebaz);

      const adminSession = await signIn(ctx.http, admin);
      const record = await as(ctx.http, adminSession).get(`/api/v1/users/${rebaz.id}`).expect(200);
      await as(ctx.http, adminSession)
        .post(`/api/v1/users/${rebaz.id}/deactivate`)
        .send({ version: record.body.version })
        .expect(201);

      const refused = await pinLogin({ ticket, pin: '123456', is_shared_device: true }).expect(401);
      // Deactivated before the PIN is even considered: the account is what stopped working.
      expect(['ticket_invalid', 'deactivated']).toContain(refused.body.error.params.reason);
    });

    it('is admin-only: an employee cannot read or revoke anybody\'s sessions', async () => {
      const rebaz = await seedUser({ username: 'rebaz', permissions: ['customers.view'] });
      const session = await signIn(ctx.http, rebaz);
      await as(ctx.http, session).get(`/api/v1/users/${rebaz.id}/sessions`).expect(403);
      await as(ctx.http, session).delete(`/api/v1/users/${rebaz.id}/device-tickets`).expect(403);
    });
  });
});

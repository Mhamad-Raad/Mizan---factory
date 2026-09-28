import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { resetPassword } from './reset-password.js';
import { auditRows, createTestApp, resetDatabase, seedUser, signIn, TEST_DATABASE_URL } from '../test/harness.js';
import type { TestApp } from '../test/harness.js';

describe('resetting a password from the command line', () => {
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

  it('lets the admin back in with a temporary password that must be changed, and says so in History', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const old = await signIn(ctx.http, admin);
    // Locked out by five wrong guesses: the reset lifts that too.
    for (let n = 0; n < 5; n += 1) {
      await request(ctx.http).post('/api/v1/auth/login').send({ username_or_phone: 'admin', password: 'wrong-but-long-enough' });
    }

    const result = await resetPassword(TEST_DATABASE_URL, 'admin');

    const login = await request(ctx.http)
      .post('/api/v1/auth/login')
      .send({ username_or_phone: 'admin', password: result.temporaryPassword })
      .expect(200);
    expect(login.body.user.must_change_password).toBe(true);
    expect(result.sessionsEnded).toBe(1);
    await request(ctx.http).get('/api/v1/auth/me').set('Cookie', old.cookies).expect(401);
    expect(await auditRows({ action: 'password_reset' })).toHaveLength(1);
  });

  it('refuses a name that is nobody', async () => {
    await expect(resetPassword(TEST_DATABASE_URL, 'nobody')).rejects.toThrow(/no user/);
  });
});

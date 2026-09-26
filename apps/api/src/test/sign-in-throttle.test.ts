import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { as, createTestApp, resetDatabase, seedUser, signIn } from './harness.js';
import type { TestApp } from './harness.js';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * The per-address ceiling on wrong passwords (security review, finding 4, and its follow-up).
 * The rest of the suite runs with it raised out of the way; this file builds its own
 * application with a ceiling of three wrong passwords an hour, and shows that it holds across
 * different usernames — which the per-account lockout, by design, does not see — and that
 * passwords typed correctly never count, however many.
 */
describe('wrong passwords per address', () => {
  let ctx: TestApp;
  const saved = process.env.SIGN_IN_FAILURES_PER_HOUR;

  // A fresh application per test: the count lives in the application's memory, and each test
  // starts from an address that has tried nothing.
  beforeEach(async () => {
    await resetDatabase();
    process.env.SIGN_IN_FAILURES_PER_HOUR = '3';
    try {
      ctx = await createTestApp();
    } finally {
      process.env.SIGN_IN_FAILURES_PER_HOUR = saved;
    }
    // As in production: one trusted proxy in front, which appends the real address last.
    (ctx.app as NestExpressApplication).set('trust proxy', 1);
  });
  afterEach(async () => {
    await ctx.close();
  });

  const attempt = (username: string, forwardedFor?: string, password = 'whatever-long-enough') => {
    const req = request(ctx.http).post('/api/v1/auth/login');
    if (forwardedFor) req.set('X-Forwarded-For', forwardedFor);
    return req.send({ username_or_phone: username, password });
  };

  it('never refuses sign-ins and unlocks with the right password, however many', async () => {
    const user = await seedUser({ username: 'tablet', role: 'admin' });
    // A shift change and a day of idle-locked tablets, from the factory's one address, in a minute.
    for (let index = 0; index < 40; index += 1) {
      await attempt('tablet', undefined, user.password).expect(200);
    }
    const session = await signIn(ctx.http, user);
    for (let index = 0; index < 20; index += 1) {
      await as(ctx.http, session).post('/api/v1/auth/lock').expect(204);
      await as(ctx.http, session)
        .post('/api/v1/auth/unlock')
        .send({ password: user.password })
        .expect(204);
    }
    // Two honest typos on the way do not change that.
    await attempt('tablet', undefined, 'a-typo-long-enough').expect(401);
    await attempt('tablet', undefined, 'a-typo-long-enough').expect(401);
    await attempt('tablet', undefined, user.password).expect(200);
  });

  it('refuses the address after three wrong passwords, whatever the usernames', async () => {
    await attempt('first-name').expect(401);
    await attempt('second-name').expect(401);
    await attempt('third-name').expect(401);

    const refused = await attempt('fourth-name').expect(429);
    expect(refused.body.error).toMatchObject({
      code: 'RATE_LIMITED',
      message_key: 'errors:RATE_LIMITED',
      params: { minutes: 5, reason: 'too_many_requests' },
    });
  });

  it('counts wrong passwords typed on the lock screen too', async () => {
    const user = await seedUser({ username: 'sara', role: 'admin' });
    const session = await signIn(ctx.http, user);
    await as(ctx.http, session).post('/api/v1/auth/lock').expect(204);
    await as(ctx.http, session)
      .post('/api/v1/auth/unlock')
      .send({ password: 'not-the-password' })
      .expect(422);
    await attempt('someone-else').expect(401);
    await attempt('another-one').expect(401);

    const refused = await as(ctx.http, session)
      .post('/api/v1/auth/unlock')
      .send({ password: user.password });
    expect(refused.status).toBe(429);
    expect(refused.body.error.params.reason).toBe('too_many_requests');
  });

  it('counts the address the proxy saw, not one the client wrote into X-Forwarded-For', async () => {
    for (let index = 0; index < 3; index += 1) {
      await attempt(`name-${index}`, `203.0.113.${index}, 198.51.100.7`).expect(401);
    }
    await attempt('name-3', '203.0.113.99, 198.51.100.7').expect(429);
    // Another real address has its own count.
    await attempt('name-4', '203.0.113.99, 198.51.100.8').expect(401);
  });

  it('counts the addresses of one IPv6 /64 as one', async () => {
    await attempt('name-1', '2001:db8:1:2::1').expect(401);
    await attempt('name-2', '2001:db8:1:2:aaaa:bbbb:cccc:dddd').expect(401);
    await attempt('name-3', '2001:db8:1:2:ffff::9').expect(401);
    await attempt('name-4', '2001:db8:1:2::1234').expect(429);
    // The next /64 is another network.
    await attempt('name-5', '2001:db8:1:3::1').expect(401);
  });
});

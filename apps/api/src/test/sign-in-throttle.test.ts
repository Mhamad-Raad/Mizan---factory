import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, resetDatabase } from './harness.js';
import type { TestApp } from './harness.js';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * The per-address ceiling on the password doors (security review, finding 4). The rest of the
 * suite runs with it raised out of the way; this file builds its own application with a
 * ceiling of three a minute, and shows that it holds across different usernames — which the
 * per-account lockout, by design, does not see.
 */
describe('sign-in attempts per address', () => {
  let ctx: TestApp;
  const saved = { minute: process.env.SIGN_IN_LIMIT_PER_MINUTE, hour: process.env.SIGN_IN_LIMIT_PER_HOUR };

  // A fresh application per test: the count lives in the application's memory, and each test
  // starts from an address that has tried nothing.
  beforeEach(async () => {
    await resetDatabase();
    process.env.SIGN_IN_LIMIT_PER_MINUTE = '3';
    process.env.SIGN_IN_LIMIT_PER_HOUR = '100';
    try {
      ctx = await createTestApp();
    } finally {
      process.env.SIGN_IN_LIMIT_PER_MINUTE = saved.minute;
      process.env.SIGN_IN_LIMIT_PER_HOUR = saved.hour;
    }
  });
  afterEach(async () => {
    await ctx.close();
  });

  const attempt = (username: string, forwardedFor?: string) => {
    const req = request(ctx.http).post('/api/v1/auth/login');
    if (forwardedFor) req.set('X-Forwarded-For', forwardedFor);
    return req.send({ username_or_phone: username, password: 'whatever-long-enough' });
  };

  it('refuses the fourth attempt in a minute from one address, whatever the username', async () => {
    await attempt('first-name').expect(401);
    await attempt('second-name').expect(401);
    await attempt('third-name').expect(401);

    const refused = await attempt('fourth-name').expect(429);
    expect(refused.body.error).toMatchObject({
      code: 'RATE_LIMITED',
      message_key: 'errors:RATE_LIMITED',
      params: { minutes: 1, reason: 'too_many_requests' },
    });
  });

  it('counts the address the proxy saw, not one the client wrote into X-Forwarded-For', async () => {
    // As in production: one trusted proxy in front, which appends the real address last.
    (ctx.app as NestExpressApplication).set('trust proxy', 1);
    for (let index = 0; index < 3; index += 1) {
      await attempt(`name-${index}`, `203.0.113.${index}, 198.51.100.7`).expect(401);
    }
    await attempt('name-3', '203.0.113.99, 198.51.100.7').expect(429);
    // Another real address has its own count.
    await attempt('name-4', '203.0.113.99, 198.51.100.8').expect(401);
  });
});

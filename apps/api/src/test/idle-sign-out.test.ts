import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, auditRows, createTestApp, resetDatabase, seedUser, signIn, withDatabase } from './harness.js';
import type { TestApp } from './harness.js';

/**
 * The idle sign-out (D-078): the business asked that a user who does nothing for fifteen
 * minutes is signed out. The browser measures it; the server stands behind it at thirty, for a
 * session no browser ended. Before this a personal device stayed signed in for thirty days.
 */
describe('the idle sign-out', () => {
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

  const leaveAlone = (interval: string) =>
    withDatabase((client) =>
      client.query(`UPDATE sessions SET last_seen_at = now() - interval '${interval}' WHERE revoked_at IS NULL`),
    );

  const sessions = () =>
    withDatabase(async (client) => {
      const { rows } = await client.query<{ revoked_at: Date | null; revoke_reason: string | null }>(
        'SELECT revoked_at, revoke_reason FROM sessions',
      );
      return rows;
    });

  it('ends a session nobody has used for thirty minutes, and says so in the audit log', async () => {
    const user = await seedUser({ username: 'rebaz', permissions: ['orders.view'] });
    const session = await signIn(ctx.http, user);
    await leaveAlone('31 minutes');

    await as(ctx.http, session).get('/api/v1/orders').expect(401);
    // Ended for good: the cookie cannot wake it later.
    await as(ctx.http, session).get('/api/v1/auth/me').expect(401);

    expect(await sessions()).toMatchObject([{ revoke_reason: 'idle' }]);
    const signOuts = await auditRows({ action: 'logout' });
    expect(signOuts).toHaveLength(1);
    expect(signOuts[0]?.changes).toMatchObject({ reason: 'idle' });
    expect(signOuts[0]?.actor_user_id).toBe(user.id);
  });

  it('leaves the margin to a user at work whose screen could not reach the server for a while', async () => {
    const user = await seedUser({ username: 'rebaz', permissions: ['orders.view'] });
    const session = await signIn(ctx.http, user);
    await leaveAlone('20 minutes');
    await as(ctx.http, session).get('/api/v1/orders').expect(200);
    expect(await auditRows({ action: 'logout' })).toHaveLength(0);
  });

  it('ends a locked session too, on a shared tablet as on a desk', async () => {
    const user = await seedUser({ username: 'hemin', permissions: ['orders.view'] });
    const session = await signIn(ctx.http, user, { isSharedDevice: true });
    await as(ctx.http, session).post('/api/v1/auth/lock').expect(204);
    await leaveAlone('31 minutes');
    await as(ctx.http, session).get('/api/v1/auth/me').expect(401);
    expect(await sessions()).toMatchObject([{ revoke_reason: 'idle' }]);
  });

  it("records the screen's own idle sign-out as one, and an ordinary sign-out as before", async () => {
    const user = await seedUser({ username: 'nazdar', permissions: ['orders.view'] });
    const idle = await signIn(ctx.http, user);
    await as(ctx.http, idle).post('/api/v1/auth/logout?reason=idle').expect(204);
    await as(ctx.http, idle).get('/api/v1/auth/me').expect(401);
    expect(await sessions()).toMatchObject([{ revoke_reason: 'idle' }]);
    expect((await auditRows({ action: 'logout' }))[0]?.changes).toMatchObject({ reason: 'idle' });

    const asked = await signIn(ctx.http, user);
    await as(ctx.http, asked).post('/api/v1/auth/logout').expect(204);
    const reasons = (await sessions()).map((row) => row.revoke_reason).sort();
    expect(reasons).toEqual(['idle', 'logout']);
  });

  it('refuses a reason it does not know', async () => {
    const user = await seedUser({ username: 'nazdar', permissions: ['orders.view'] });
    const session = await signIn(ctx.http, user);
    const refused = await as(ctx.http, session).post('/api/v1/auth/logout?reason=bored');
    expect(refused.status).toBeGreaterThanOrEqual(400);
    await as(ctx.http, session).get('/api/v1/auth/me').expect(200);
  });
});

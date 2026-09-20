import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PERMISSION_KEYS } from '@mizan/permissions';
import { collectRoutes } from '../checks/routes.js';
import type { RouteInfo } from '../checks/routes.js';
import { createTestApp, resetDatabase, seedUser, signIn } from './harness.js';
import type { Session, TestApp } from './harness.js';

/**
 * The permission matrix of specification 2.12, generated from route metadata rather than
 * written by hand — so a route added in a later iteration is covered the moment it exists:
 *
 *   for each route · a user without the key gets 403 · admin is never refused for want of a
 *   permission · a locked session gets 423 · a deactivated user gets 401 · no session gets 401.
 *
 * Guards run before validation, so an empty body is enough to prove the refusal: the request
 * never reaches the handler.
 */

const PLACEHOLDER_UUID = '00000000-0000-4000-8000-000000000000';

function urlOf(route: RouteInfo): string {
  return route.path.replace(/:[A-Za-z]+/g, PLACEHOLDER_UUID);
}

function send(http: Parameters<typeof request>[0], route: RouteInfo, session?: Session) {
  const method = route.method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete';
  let call = request(http)[method](urlOf(route));
  if (session) call = call.set('Cookie', session.cookies).set('X-CSRF-Token', session.csrf);
  return call.send({});
}

describe('permission matrix (FR-104, spec 2.12)', () => {
  let ctx: TestApp;
  let routes: RouteInfo[];
  let adminSession: Session;
  let strangerSession: Session;
  let lockedSession: Session;

  beforeAll(async () => {
    routes = await collectRoutes();
    await resetDatabase();
    ctx = await createTestApp();

    const admin = await seedUser({ username: 'admin.matrix', role: 'admin' });
    // An employee with *no* permissions at all: the baseline of FR-102.
    const stranger = await seedUser({ username: 'stranger', role: 'employee', permissions: [] });
    const lockable = await seedUser({ username: 'lockable', role: 'admin' });

    adminSession = await signIn(ctx.http, admin);
    strangerSession = await signIn(ctx.http, stranger);
    lockedSession = await signIn(ctx.http, lockable);
    await request(ctx.http)
      .post('/api/v1/auth/lock')
      .set('Cookie', lockedSession.cookies)
      .set('X-CSRF-Token', lockedSession.csrf)
      .expect(204);
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('found routes to check', () => {
    expect(routes.length).toBeGreaterThan(10);
  });

  it('every route declares how it is protected', () => {
    const undeclared = routes.filter((route) => route.protection.kind === 'none');
    expect(undeclared.map((route) => `${route.method} ${route.path}`)).toEqual([]);
  });

  it('every permission key a route asks for exists in the catalog', () => {
    const keys = routes
      .filter((route) => route.protection.kind === 'permission')
      .flatMap((route) => (route.protection as { keys: readonly string[] }).keys);
    for (const key of keys) expect(PERMISSION_KEYS).toContain(key);
  });

  describe('a user without the permission is refused', () => {
    it('403 on every permission-guarded and admin-only route', async () => {
      const guarded = routes.filter(
        (route) => route.protection.kind === 'permission' || route.protection.kind === 'admin',
      );
      expect(guarded.length).toBeGreaterThan(0);

      for (const route of guarded) {
        const response = await send(ctx.http, route, strangerSession);
        expect(
          response.status,
          `${route.method} ${route.path} should refuse an employee without the key`,
        ).toBe(403);
        expect(response.body.error.code).toBe('PERMISSION_DENIED');
      }
    });
  });

  it('an admin is never refused for want of a permission', async () => {
    const guarded = routes.filter(
      (route) => route.protection.kind === 'permission' || route.protection.kind === 'admin',
    );
    for (const route of guarded) {
      const response = await send(ctx.http, route, adminSession);
      expect(response.status, `${route.method} ${route.path} refused the admin`).not.toBe(403);
      expect(response.status).not.toBe(401);
    }
  });

  it('a locked session is refused with 423 everywhere except the lock-screen routes', async () => {
    const reachableWhileLocked = new Set([
      'POST /api/v1/auth/unlock',
      'GET /api/v1/auth/me',
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/change-password',
      'GET /api/v1/health',
    ]);
    // Logout ends the session it is called with, so it is checked on its own below rather
    // than inside the loop, where it would make every later route answer 401.
    const destructive = new Set(['POST /api/v1/auth/logout']);

    for (const route of routes) {
      const label = `${route.method} ${route.path}`;
      if (destructive.has(label)) continue;
      const response = await send(ctx.http, route, lockedSession);
      if (reachableWhileLocked.has(label)) {
        expect(response.status, `${label} must stay reachable while locked`).not.toBe(423);
      } else {
        expect(response.status, `${label} must be refused while locked`).toBe(423);
      }
    }
  });

  it('a locked session can still sign out — the tablet must be releasable', async () => {
    const user = await seedUser({ username: 'locked.signout', role: 'admin' });
    const session = await signIn(ctx.http, user);
    await request(ctx.http)
      .post('/api/v1/auth/lock')
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf)
      .expect(204);

    await request(ctx.http)
      .post('/api/v1/auth/logout')
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf)
      .expect(204);
    await request(ctx.http).get('/api/v1/auth/me').set('Cookie', session.cookies).expect(401);
  });

  it('no session at all is 401 on everything except the public routes', async () => {
    for (const route of routes) {
      const response = await send(ctx.http, route);
      if (route.protection.kind === 'public') {
        expect(response.status, `${route.method} ${route.path} is public`).not.toBe(401);
      } else {
        expect(response.status, `${route.method} ${route.path} needs a session`).toBe(401);
      }
    }
  });

  it('a deactivated user is refused with 401, whatever they held before', async () => {
    const user = await seedUser({
      username: 'about.to.go',
      role: 'employee',
      permissions: ['history.view'],
    });
    const session = await signIn(ctx.http, user);
    await request(ctx.http).get('/api/v1/history').set('Cookie', session.cookies).expect(200);

    const admin = await seedUser({ username: 'admin.deactivator', role: 'admin' });
    const adminJar = await signIn(ctx.http, admin);
    const target = await request(ctx.http)
      .get(`/api/v1/users/${user.id}`)
      .set('Cookie', adminJar.cookies)
      .expect(200);
    await request(ctx.http)
      .post(`/api/v1/users/${user.id}/deactivate`)
      .set('Cookie', adminJar.cookies)
      .set('X-CSRF-Token', adminJar.csrf)
      .send({ version: target.body.version })
      .expect(201);

    await request(ctx.http).get('/api/v1/history').set('Cookie', session.cookies).expect(401);
  });

  it('a permission granted to an employee lets exactly that route through', async () => {
    const user = await seedUser({
      username: 'historian',
      role: 'employee',
      permissions: ['history.view'],
    });
    const session = await signIn(ctx.http, user);

    await request(ctx.http).get('/api/v1/history').set('Cookie', session.cookies).expect(200);
    // …and nothing else: users are admin-only.
    await request(ctx.http).get('/api/v1/users').set('Cookie', session.cookies).expect(403);
  });
});

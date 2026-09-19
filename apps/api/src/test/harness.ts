import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../app.module.js';
import { ARGON2_OPTIONS } from '../auth/password.service.js';
import { hash } from '@node-rs/argon2';
import { expandImplied } from '@mizan/permissions';
import { normalizeForSearch } from '@mizan/text';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://mizan_app:mizan_app@localhost:5432/mizan_test';
export const TEST_MIGRATE_URL =
  process.env.TEST_MIGRATE_URL ?? 'postgresql://mizan_migrate:mizan_migrate@localhost:5432/mizan_test';

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.DATABASE_MIGRATE_URL = TEST_MIGRATE_URL;
process.env.SESSION_PEPPER ??= 'test-pepper-not-a-secret-0123456789';
process.env.NODE_ENV = 'test';
process.env.APP_BASE_URL ??= 'http://localhost:5173';

export interface TestApp {
  app: INestApplication;
  http: App;
  close: () => Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
  const app = await NestFactory.create(AppModule, { logger: process.env.TEST_LOG === '1' ? undefined : false });
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  await app.init();
  return {
    app,
    http: app.getHttpServer() as App,
    close: async () => {
      await app.close();
    },
  };
}

/**
 * Truncating the append-only tables needs the migrate role, because `mizan_app` has no DELETE
 * on them — which is exactly the guarantee under test elsewhere in this suite.
 */
export async function resetDatabase(): Promise<void> {
  const client = new Client({ connectionString: TEST_MIGRATE_URL });
  await client.connect();
  await client.query(
    'TRUNCATE audit_log, login_attempts, idempotency_keys, user_permissions, sessions, users RESTART IDENTITY CASCADE',
  );
  await client.end();
}

export interface SeededUser {
  id: string;
  username: string;
  password: string;
  displayName: string;
}

/** Creates a user directly in the database, so tests do not depend on the create endpoint. */
export async function seedUser(input: {
  username: string;
  password?: string;
  role?: 'admin' | 'employee';
  displayName?: string;
  permissions?: string[];
  isActive?: boolean;
  mustChangePassword?: boolean;
  phone?: string | null;
}): Promise<SeededUser> {
  const password = input.password ?? 'correct-horse-battery';
  const client = new Client({ connectionString: TEST_MIGRATE_URL });
  await client.connect();
  try {
    const passwordHash = await hash(password, ARGON2_OPTIONS);
    const displayName = input.displayName ?? input.username;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO users (username, display_name, display_name_normalized, phone, role, password_hash,
                          must_change_password, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        input.username,
        displayName,
        normalizeForSearch(displayName),
        input.phone ?? null,
        input.role ?? 'employee',
        passwordHash,
        input.mustChangePassword ?? false,
        input.isActive ?? true,
      ],
    );
    const id = rows[0]?.id as string;

    const keys = [...expandImplied(input.permissions ?? [])];
    for (const key of keys) {
      await client.query(
        'INSERT INTO user_permissions (user_id, permission_key, granted_by) VALUES ($1, $2, $1)',
        [id, key],
      );
    }
    return { id, username: input.username, password, displayName };
  } finally {
    await client.end();
  }
}

export interface Session {
  cookies: string[];
  csrf: string;
  userId: string;
}

/** Signs a seeded user in and returns the cookie jar plus the CSRF token for writes. */
export async function signIn(
  http: App,
  user: SeededUser,
  options: { isSharedDevice?: boolean } = {},
): Promise<Session> {
  const response = await request(http)
    .post('/api/v1/auth/login')
    .send({
      username_or_phone: user.username,
      password: user.password,
      is_shared_device: options.isSharedDevice ?? false,
    })
    .expect(200);

  const cookies = response.headers['set-cookie'] as unknown as string[];
  const csrf = (cookies.find((cookie) => cookie.startsWith('mizan_csrf=')) ?? '')
    .split(';')[0]
    ?.replace('mizan_csrf=', '') as string;
  return { cookies, csrf, userId: user.id };
}

/** A request already carrying the session cookie and the double-submit CSRF header. */
export function as(http: App, session: Session) {
  const withAuth = (req: request.Test) => req.set('Cookie', session.cookies).set('X-CSRF-Token', session.csrf);
  return {
    get: (url: string) => withAuth(request(http).get(url)),
    post: (url: string) => withAuth(request(http).post(url)),
    patch: (url: string) => withAuth(request(http).patch(url)),
    delete: (url: string) => withAuth(request(http).delete(url)),
  };
}

export async function auditRows(filter: { action?: string; entityId?: string } = {}) {
  const client = new Client({ connectionString: TEST_MIGRATE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT action::text AS action, entity_type, entity_id, entity_label, changes, note, actor_user_id
         FROM audit_log
        WHERE ($1::text IS NULL OR action::text = $1) AND ($2::text IS NULL OR entity_id = $2)
        ORDER BY id ASC`,
      [filter.action ?? null, filter.entityId ?? null],
    );
    return rows;
  } finally {
    await client.end();
  }
}

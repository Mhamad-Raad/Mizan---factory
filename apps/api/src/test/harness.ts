import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import request from 'supertest';
import { expect } from 'vitest';
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

/**
 * `TEST_TRACE=1` prints when an app is created or closed and when the database is emptied,
 * with the test that caused it. Two runs of that were what identified the listener churn
 * below; it is left in because the next person chasing a flake will want it.
 */
function trace(what: string): void {
  if (process.env.TEST_TRACE !== '1') return;
  process.stdout.write(
    `[trace ${new Date().toISOString()}] ${what} :: ${expect.getState().currentTestName ?? '-'}\n`,
  );
}

/**
 * One application per test file, listening on **one** ephemeral port for the whole file.
 *
 * The `listen` matters. Handed a server that is not listening, supertest binds a fresh
 * ephemeral port for every single request and closes it afterwards — about fifteen hundred
 * times per run of this suite. Under that churn a request occasionally reaches a socket whose
 * listener is already going away, and the answer is a bare 404 (or a "Parse Error: Expected
 * HTTP/") from a route that plainly exists. It looks exactly like a race in the application
 * and is nothing of the kind, which is the worst sort of flake to leave in a suite that has to
 * be trusted for years.
 */
export async function createTestApp(): Promise<TestApp> {
  trace('app create');
  const app = await NestFactory.create(AppModule, { logger: process.env.TEST_LOG === '1' ? undefined : false });
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  await app.init();
  await app.listen(0, '127.0.0.1');

  return {
    app,
    http: app.getHttpServer() as App,
    close: async () => {
      trace('app close');
      await app.close();
    },
  };
}

/**
 * Truncating the append-only tables needs the migrate role, because `mizan_app` has no DELETE
 * on them — which is exactly the guarantee under test elsewhere in this suite.
 *
 * `settings` is emptied rather than reset row by row: every key falls back to
 * `DEFAULT_SETTINGS` when its row is absent, so one DELETE restores the whole system to its
 * documented defaults and a test that locked a period cannot leak into the next file.
 */
export async function resetDatabase(): Promise<void> {
  trace('truncate start');
  const client = new Client({ connectionString: TEST_MIGRATE_URL });
  await client.connect();
  await client.query(
    `TRUNCATE audit_log, login_attempts, idempotency_keys, user_permissions, sessions,
              customer_ledger, company_ledger, stock_ledger, order_payment_type_changes,
              order_lines, orders, purchase_lines, purchases, customers, company_rates,
              companies, item_month_prices, items, global_rates, settings, users
     RESTART IDENTITY CASCADE`,
  );
  // `RESTART IDENTITY` only touches sequences a truncated table owns. Document numbers,
  // voucher numbers and the posting order live in standalone sequences (2.2.3), so a test that
  // asserts "voucher #1" needs them restarted too — and nothing else resets them.
  await client.query(
    `ALTER SEQUENCE order_number_seq RESTART;
     ALTER SEQUENCE purchase_number_seq RESTART;
     ALTER SEQUENCE voucher_number_seq RESTART;
     ALTER SEQUENCE customer_ledger_seq RESTART;
     ALTER SEQUENCE company_ledger_seq RESTART;
     ALTER SEQUENCE stock_ledger_seq RESTART`,
  );
  await client.end();
  trace('truncate done');
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
  const response = await request(http).post('/api/v1/auth/login').send({
    username_or_phone: user.username,
    password: user.password,
    is_shared_device: options.isSharedDevice ?? false,
  });
  if (response.status !== 200) {
    // A failed sign-in inside a hook is otherwise reported as a bare status code, which says
    // nothing about *why* — and the why is usually a fixture problem, not an auth problem.
    throw new Error(
      `sign-in for ${user.username} answered ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }

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
    put: (url: string) => withAuth(request(http).put(url)),
    patch: (url: string) => withAuth(request(http).patch(url)),
    delete: (url: string) => withAuth(request(http).delete(url)),
  };
}

/** Runs SQL as the migrate role, for the assertions that read rows the API never returns. */
export async function withDatabase<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: TEST_MIGRATE_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
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

import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { request, test as setup } from '@playwright/test';
import { todayInBaghdad } from '@mizan/i18n';
import { ACCOUNTANT, ADMIN, SALES, WAREHOUSE } from './accounts.js';

/**
 * Seeds the data the selling screens are photographed with (spec 2.12, Definition of done
 * item 6).
 *
 * Everything here goes through the API, not the database: the fixture is then made the way an
 * employee would make it, and a screenshot cannot pass while the endpoint behind it is broken.
 * The one exception is the TRUNCATE that starts it — which needs the migrate role, because the
 * application role has no DELETE on the append-only tables, and that is the point.
 */

const BASE = process.env.E2E_API_URL ?? 'http://localhost:3000/api/v1';
const INITIAL_ADMIN_PASSWORD = 'mizan-e2e-initial-2026';
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://mizan_app:mizan_app@localhost:5432/mizan_test';
const TEST_MIGRATE_URL =
  process.env.TEST_MIGRATE_URL ?? 'postgresql://mizan_migrate:mizan_migrate@localhost:5432/mizan_test';

export interface Fixture {
  copperId: string;
  steelId: string;
  customerId: string;
  orderId: string;
  companyId: string;
  purchaseId: string;
}

setup('seed the selling and buying fixture', async () => {
  await seedFixture();
});

async function seedFixture(): Promise<void> {
  // A screenshot suite has to be deterministic, so it starts from an empty database rather
  // than repairing whatever the last run left behind: a half-created account, a sign-in
  // lockout from a wrong password (FR-101), yesterday's orders.
  await resetTestDatabase();

  // No `baseURL`: a path beginning with "/" would resolve against the origin and drop the
  // /api/v1 prefix, so every call below spells out the full URL.
  const context = await request.newContext();

  let session: Headers | null;
  {
    // The first admin comes from the environment, and its one-time password is exchanged for
    // a known one so the screens are not all the "change password" page.
    execFileSync('pnpm', ['--filter', '@mizan/api', 'seed'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        // Explicit, because the seed script also reads `.env`: without this the fixture
        // would be written into the developer's own database instead of the test one.
        DATABASE_URL: TEST_DATABASE_URL,
        FIRST_ADMIN_USERNAME: ADMIN.username,
        FIRST_ADMIN_DISPLAY_NAME: 'Dara',
        FIRST_ADMIN_PASSWORD: INITIAL_ADMIN_PASSWORD,
      },
    });
    session = await signIn(context, ADMIN.username, INITIAL_ADMIN_PASSWORD);
    if (!session) throw new Error('could not sign in as the seeded admin');
    const changed = await context.post(`${BASE}/auth/change-password`, {
      headers: session,
      data: { current: INITIAL_ADMIN_PASSWORD, new: ADMIN.password },
    });
    if (!changed.ok()) throw new Error(`could not set the admin password: ${changed.status()}`);
  }

  // Business dates are Asia/Baghdad days, through the same helper the application uses.
  const today = todayInBaghdad();
  const month = today.slice(0, 7);

  await post(context, session, '/settings/global-rates', { rate_iqd_per_usd: '1310' });

  const salesUser = await ensureSalesEmployee(context, session);

  const copperId = await createMaterial(context, session, {
    name: 'Copper wire 2 mm',
    pricing_unit: 'per_kg',
    month,
    sale: 850,
    bought: 700,
    openingKg: '6000.000',
  });
  const steelId = await createMaterial(context, session, {
    name: 'Steel sheet 1.2 mm',
    pricing_unit: 'per_piece',
    month,
    sale: 18_000,
    bought: 15_000,
    openingCount: 500,
  });

  const customerId = await createCustomer(context, session, salesUser, today);
  const orderId = await createOrder(context, session, { customerId, copperId, steelId, today });

  // Iteration 2: the supplier side of the same yard — a company with its own rate, a purchase
  // that put stock in and a part payment against it.
  await ensureEmployee(context, session, {
    display_name: 'Hemin',
    account: WAREHOUSE,
    preset_key: 'warehouse',
  });
  await ensureEmployee(context, session, {
    display_name: 'Nazdar',
    account: ACCOUNTANT,
    preset_key: 'accountant',
  });
  const companyId = await createCompany(context, session);
  const purchaseId = await createPurchase(context, session, { companyId, copperId, steelId, today });

  process.env.E2E_FIXTURE = JSON.stringify({
    copperId,
    steelId,
    customerId,
    orderId,
    companyId,
    purchaseId,
  } satisfies Fixture);
  await context.dispose();
}

type Headers = Record<string, string>;

async function signIn(
  context: Awaited<ReturnType<typeof request.newContext>>,
  username: string,
  password: string,
): Promise<Headers | null> {
  const response = await context.post(`${BASE}/auth/login`, {
    data: { username_or_phone: username, password, is_shared_device: false },
  });
  if (!response.ok()) return null;
  const cookies = response.headersArray().filter((header) => header.name.toLowerCase() === 'set-cookie');
  const jar = cookies.map((header) => header.value.split(';')[0]).join('; ');
  const csrf = /mizan_csrf=([^;]+)/.exec(jar)?.[1] ?? '';
  return { Cookie: jar, 'X-CSRF-Token': csrf };
}

async function post(
  context: Awaited<ReturnType<typeof request.newContext>>,
  session: Headers,
  path: string,
  data: unknown,
): Promise<Record<string, unknown>> {
  // Strict: the fixture starts from an empty database, so anything other than success is a
  // real failure and its body is the fastest explanation available.
  const response = await context.post(`${BASE}${path}`, { headers: session, data });
  if (!response.ok()) {
    throw new Error(`POST ${path} failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

async function ensureEmployee(
  context: Awaited<ReturnType<typeof request.newContext>>,
  session: Headers,
  input: { display_name: string; account: { username: string; password: string }; preset_key: string },
): Promise<string> {
  const created = (await post(context, session, '/users', {
    display_name: input.display_name,
    username: input.account.username,
    role: 'employee',
    preset_key: input.preset_key,
  })) as { user?: { id: string }; temporary_password?: string };
  await adoptPassword(input.account, created.temporary_password as string);
  return created.user?.id as string;
}

async function createCompany(
  context: Awaited<ReturnType<typeof request.newContext>>,
  session: Headers,
): Promise<string> {
  const created = (await post(context, session, '/companies', {
    name: 'Al-Noor Steel Co.',
    contact_name: 'Abu Ahmad',
    phone: '0751 222 3344',
    settlement_currency: 'IQD',
  })) as { id: string };

  // The company's own rate, deliberately apart from the global 1,310 (FR-703, 2.3.3).
  await post(context, session, `/companies/${created.id}/rates`, {
    rate_iqd_per_usd: '1305',
    note: 'agreed for September',
  });
  return created.id;
}

async function createPurchase(
  context: Awaited<ReturnType<typeof request.newContext>>,
  session: Headers,
  input: { companyId: string; copperId: string; steelId: string; today: string },
): Promise<string> {
  const created = (await post(context, session, '/purchases', {
    company_id: input.companyId,
    purchase_date: input.today,
    notes: 'delivered by lorry',
    lines: [
      { item_id: input.copperId, qty_kg: '500.000' },
      { item_id: input.steelId, qty_count: 20, qty_kg: '48.000' },
    ],
  })) as { id: string };

  await post(context, session, `/companies/${input.companyId}/payments`, {
    amount: 200_000,
    currency: 'IQD',
    entry_date: input.today,
    note: 'first instalment',
  });

  return created.id;
}

async function ensureSalesEmployee(
  context: Awaited<ReturnType<typeof request.newContext>>,
  session: Headers,
): Promise<string> {
  const created = (await post(context, session, '/users', {
    display_name: 'Rebaz',
    username: SALES.username,
    role: 'employee',
    preset_key: 'sales',
  })) as { user?: { id: string }; temporary_password?: string };
  await adoptPassword(SALES, created.temporary_password as string);
  return created.user?.id as string;
}

/**
 * Turns the one-time password into the one the screenshot specs sign in with (FR-108).
 *
 * It uses its own request context: signing a second person in through a context that already
 * holds someone else's cookies sends that session's CSRF cookie without its header, and the
 * double-submit check refuses the call — correctly (spec 2.8).
 */
async function adoptPassword(
  account: { username: string; password: string },
  temporary: string,
): Promise<void> {
  const context = await request.newContext();
  try {
    const session = await signIn(context, account.username, temporary);
    if (!session) throw new Error(`could not sign in as ${account.username} with the temporary password`);
    const changed = await context.post(`${BASE}/auth/change-password`, {
      headers: session,
      data: { current: temporary, new: account.password },
    });
    if (!changed.ok()) {
      throw new Error(`could not set the password for ${account.username}: ${changed.status()} ${await changed.text()}`);
    }
  } finally {
    await context.dispose();
  }
}

async function createMaterial(
  context: Awaited<ReturnType<typeof request.newContext>>,
  session: Headers,
  input: {
    name: string;
    pricing_unit: 'per_kg' | 'per_piece';
    month: string;
    sale: number;
    bought: number;
    openingKg?: string;
    openingCount?: number;
  },
): Promise<string> {
  const created = (await post(context, session, '/items', {
    name: input.name,
    pricing_unit: input.pricing_unit,
  })) as { id: string };

  await context.put(`${BASE}/items/${created.id}/prices/${input.month}`, {
    headers: session,
    data: {
      sale: { amount: input.sale, currency: 'IQD' },
      bought: { amount: input.bought, currency: 'IQD' },
    },
  });

  await post(context, session, `/items/${created.id}/opening-stock`, {
    entry_date: todayInBaghdad(),
    qty_kg: input.openingKg ?? null,
    qty_count: input.openingCount ?? null,
    note: 'counted at go-live',
  });

  return created.id;
}

async function createCustomer(
  context: Awaited<ReturnType<typeof request.newContext>>,
  session: Headers,
  assignedTo: string,
  today: string,
): Promise<string> {
  const created = (await post(context, session, '/customers', {
    name: 'Kawa Trading',
    phone: '0770 123 4567',
    assigned_user_id: assignedTo,
  })) as { id: string };

  await post(context, session, `/customers/${created.id}/opening-balance`, {
    amount: 450_000,
    currency: 'IQD',
    entry_date: today,
    note: 'owed at go-live',
  });

  return created.id;
}

async function createOrder(
  context: Awaited<ReturnType<typeof request.newContext>>,
  session: Headers,
  input: { customerId: string; copperId: string; steelId: string; today: string },
): Promise<string> {
  const created = (await post(context, session, '/orders', {
    customer_id: input.customerId,
    order_date: input.today,
    payment_type: 'borrowed',
    notes: 'delivered to the yard gate',
    lines: [
      { item_id: input.copperId, qty_kg: '12.500' },
      { item_id: input.steelId, qty_count: 40, qty_kg: '96.000' },
    ],
  })) as { id: string };

  await post(context, session, `/orders/${created.id}/payments`, {
    amount: 300_000,
    currency: 'IQD',
    entry_date: input.today,
    note: 'part payment at the gate',
  });

  return created.id;
}

/**
 * Empties the test database. It runs as the migrate role: `mizan_app` cannot delete a ledger
 * row, which is the guarantee the API tests assert elsewhere (migration 0002, 0007).
 */
async function resetTestDatabase(): Promise<void> {
  const client = new Client({ connectionString: TEST_MIGRATE_URL });
  await client.connect();
  try {
    await client.query(
      `TRUNCATE audit_log, login_attempts, idempotency_keys, user_permissions, sessions,
                customer_ledger, company_ledger, stock_ledger, order_payment_type_changes,
                order_lines, orders, purchase_lines, purchases, customers, company_rates,
                companies, item_month_prices, items, global_rates, settings, users
       RESTART IDENTITY CASCADE`,
    );
    // The order and voucher numbers are their own sequences, which TRUNCATE does not touch.
    // Restarting them keeps "Order #1001" the same on every run, so a screenshot changes only
    // when the interface does.
    await client.query(
      `ALTER SEQUENCE order_number_seq RESTART;
       ALTER SEQUENCE purchase_number_seq RESTART;
       ALTER SEQUENCE voucher_number_seq RESTART;
       ALTER SEQUENCE customer_ledger_seq RESTART;
       ALTER SEQUENCE company_ledger_seq RESTART;
       ALTER SEQUENCE stock_ledger_seq RESTART;`,
    );
  } finally {
    await client.end();
  }
}


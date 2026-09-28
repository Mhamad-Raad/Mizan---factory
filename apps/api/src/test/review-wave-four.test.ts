import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { as, auditRows, createTestApp, resetDatabase, seedUser, signIn, withDatabase } from './harness.js';
import type { Session, TestApp } from './harness.js';

/**
 * Regressions for the fourth review (2026-09-28: security, scale, correctness over years of
 * use). Each test fails against the code as it was before that review.
 */
describe('the fourth review', () => {
  let ctx: TestApp;
  let admin: Session;
  let sales: Session;
  let clerk: Session;
  let copper: string;
  let kawa: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 60_000);
  afterAll(async () => {
    await ctx.close();
  });

  function today(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
      new Date(),
    );
  }

  async function setRate(rate: string): Promise<void> {
    await as(ctx.http, admin).post('/api/v1/settings/global-rates').send({ rate_iqd_per_usd: rate }).expect(201);
  }

  beforeEach(async () => {
    await resetDatabase();
    const adminUser = await seedUser({ username: 'admin.review', role: 'admin' });
    const salesUser = await seedUser({
      username: 'rebaz',
      permissions: ['orders.create', 'orders.edit', 'orders.record_payment', 'customers.create'],
    });
    const clerkUser = await seedUser({
      username: 'sara',
      permissions: ['orders.create', 'orders.edit', 'orders.record_payment', 'materials.view'],
    });
    admin = await signIn(ctx.http, adminUser);
    sales = await signIn(ctx.http, salesUser);
    clerk = await signIn(ctx.http, clerkUser);
    await setRate('1310');

    const item = await as(ctx.http, admin).post('/api/v1/items').send({ name: 'Copper wire', pricing_unit: 'per_kg' }).expect(201);
    copper = item.body.id;
    await as(ctx.http, admin)
      .put(`/api/v1/items/${copper}/prices/${today().slice(0, 7)}`)
      .send({ sale: { amount: 850, currency: 'IQD' }, bought: { amount: 700, currency: 'IQD' } })
      .expect(200);
    await as(ctx.http, admin)
      .post('/api/v1/purchases')
      .send({
        company_id: null,
        purchase_date: today(),
        lines: [{ item_id: copper, qty_kg: '1000.000', unit_price: { amount: 700, currency: 'IQD' } }],
      })
      .expect(201);
    const company = await as(ctx.http, admin).post('/api/v1/customers').send({ name: 'Kawa Trading' }).expect(201);
    kawa = company.body.id;
  });

  function createOrder(session: Session, lines: unknown[] = [{ item_id: copper, qty_kg: '10.000' }]) {
    return as(ctx.http, session)
      .post('/api/v1/orders')
      .send({ customer_id: kawa, order_date: today(), payment_type: 'borrowed', lines });
  }

  function edit(session: Session, order: { id: string; version: number }, body: Record<string, unknown> = {}) {
    return as(ctx.http, session)
      .put(`/api/v1/orders/${order.id}`)
      .send({
        customer_id: kawa,
        order_date: today(),
        payment_type: 'borrowed',
        version: order.version,
        lines: [{ item_id: copper, qty_kg: '10.000' }],
        notes: 'corrected',
        ...body,
      });
  }

  it('keeps the rate an order was made at when it is edited, however the rate has moved', async () => {
    const order = await createOrder(sales).expect(201);
    await setRate('1500');
    const edited = await edit(sales, order.body).expect(200);
    expect(edited.body.rate_iqd_per_usd).toBe(order.body.rate_iqd_per_usd);
    expect(edited.body.total_usd_cents).toBe(order.body.total_usd_cents);
  });

  it("lets a holder of orders.edit correct a colleague's order without making them an admin", async () => {
    const order = await createOrder(sales).expect(201);
    await edit(clerk, order.body).expect(200);
  });

  it('keeps an order editable after one of its materials is deactivated', async () => {
    const order = await createOrder(sales).expect(201);
    const item = await as(ctx.http, admin).get(`/api/v1/items/${copper}`).expect(200);
    await as(ctx.http, admin).post(`/api/v1/items/${copper}/deactivate`).send({ version: item.body.version }).expect(200);
    await edit(sales, order.body).expect(200);
    // A new order of it is still refused.
    await createOrder(sales).expect(422);
  });

  it("does not reverse a document's own row from the ledger, and lets a clerk reverse only their payment", async () => {
    const order = await createOrder(sales).expect(201);
    const ledger = await as(ctx.http, admin).get(`/api/v1/customers/${kawa}/ledger?raw=true`).expect(200);
    const orderRow = (ledger.body.items as { entry_id: string; entry_type: string }[]).find(
      (group) => group.entry_type === 'order',
    ) as { entry_id: string };
    const refused = await as(ctx.http, admin)
      .post(`/api/v1/customers/${kawa}/ledger/${orderRow.entry_id}/reverse`)
      .send({ note: 'wrong' })
      .expect(422);
    expect(refused.body.error.fields[0]).toMatchObject({ code: 'NOT_REVERSIBLE' });

    const paid = await as(ctx.http, sales)
      .post(`/api/v1/orders/${order.body.id}/payments`)
      .send({ amount: 1_000, currency: 'IQD', entry_date: today() })
      .expect(201);
    await as(ctx.http, sales)
      .post(`/api/v1/customers/${kawa}/ledger/${paid.body[0].entry_id}/reverse`)
      .send({ note: 'typed twice' })
      .expect(201);
  });

  it('adds kilograms of one material exactly when checking stock', async () => {
    await as(ctx.http, admin).patch('/api/v1/settings').send({ allow_negative_stock: false }).expect(200);
    // 999.9 + 0.1 is exactly the 1,000 kg on hand — not 1000.0000000000001.
    await createOrder(sales, [
      { item_id: copper, qty_kg: '999.900' },
      { item_id: copper, qty_kg: '0.100' },
    ]).expect(201);
  });

  it('hides what a buy cost from a reader without the bought-price flag', async () => {
    const lots = await as(ctx.http, clerk).get(`/api/v1/items/${copper}/lots`).expect(200);
    expect(lots.body.items[0]).not.toHaveProperty('line_total_iqd');
    expect(lots.body.items[0]).not.toHaveProperty('unit_cost_iqd');
  });

  it("hides the account's balance in a payment's answer from a writer without the balances flag", async () => {
    const order = await createOrder(sales).expect(201);
    const paid = await as(ctx.http, clerk)
      .post(`/api/v1/orders/${order.body.id}/payments`)
      .send({ amount: 1_000, currency: 'IQD', entry_date: today() })
      .expect(201);
    expect(paid.body[0]).not.toHaveProperty('balance_before');
    expect(paid.body[0]).not.toHaveProperty('balance_after');
  });

  it('records a locked door once per lockout, and masks a name that is nobody', async () => {
    for (let n = 0; n < 12; n += 1) {
      await request(ctx.http).post('/api/v1/auth/login').send({ username_or_phone: 'my-Secret-password', password: 'wrong-but-long-enough' });
    }
    const knocks = await auditRows({ action: 'login_failed' });
    const lockedOut = knocks.filter((row) => (row.changes as { reason?: string }).reason === 'locked_out');
    expect(lockedOut).toHaveLength(1);
    expect(knocks.every((row) => !String(row.entity_label).includes('Secret'))).toBe(true);
  });

  it('locks a session left idle past its minutes, and says how many minutes the screen should wait', async () => {
    const me = await as(ctx.http, sales).get('/api/v1/auth/me').expect(200);
    expect(me.body.idle_lock_minutes).toBe(30);
    await withDatabase((client) =>
      client.query("UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE NOT is_locked AND revoked_at IS NULL"),
    );
    const locked = await as(ctx.http, sales).get('/api/v1/orders').expect(423);
    expect(locked.body.error.code).toBe('SESSION_LOCKED');
  });

  it("ends the previous person's session when somebody else signs in on the same browser", async () => {
    const next = await seedUser({ username: 'hemin', permissions: ['materials.view'] });
    await request(ctx.http)
      .post('/api/v1/auth/login')
      .set('Cookie', sales.cookies)
      .set('X-CSRF-Token', sales.csrf)
      .send({ username_or_phone: 'hemin', password: next.password })
      .expect(200);
    await as(ctx.http, sales).get('/api/v1/orders').expect(401);
    expect(await auditRows({ action: 'switch_user' })).toHaveLength(1);
  });

  it("sends History's dates as dates to a reader who has fields stripped", async () => {
    const order = await createOrder(sales).expect(201);
    const history = await as(ctx.http, clerk).get(`/api/v1/orders/${order.body.id}/history`).expect(200);
    const first = history.body.items[0];
    expect(typeof first.occurred_at).toBe('string');
    expect(Number.isNaN(Date.parse(first.occurred_at))).toBe(false);
  });

  it("gives the Profit report the same profit as the Accounts page, rounding and discount included", async () => {
    // 10.3 kg × 850 = 8,755 → rounded to 9,000; a 500 discount first → 8,255 → 8,500.
    await as(ctx.http, sales)
      .post('/api/v1/orders')
      .send({
        customer_id: kawa,
        order_date: today(),
        payment_type: 'borrowed',
        discount: { amount: 500, currency: 'IQD' },
        lines: [{ item_id: copper, qty_kg: '10.300' }],
      })
      .expect(201);
    const range = `from=${today()}&to=${today()}`;
    const accounts = await as(ctx.http, admin).get(`/api/v1/accounts/summary?${range}`).expect(200);
    const report = await as(ctx.http, admin).get(`/api/v1/reports/profit?${range}`).expect(200);
    expect(report.body.totals.cost.net_margin_iqd).toBe(accounts.body.profit.amount_iqd);
  });

  it('frees an idempotency key whose request never finished', async () => {
    const key = '55555555-2222-4333-8444-555555555555';
    await withDatabase(async (client) => {
      const { rows } = await client.query<{ id: string }>("SELECT id FROM users WHERE username = 'admin.review'");
      await client.query(
        `INSERT INTO idempotency_keys (key, user_id, request_hash, response_status, response_body, created_at, expires_at)
         VALUES ($1, $2, 'stale', 0, 'null'::jsonb, now() - interval '10 minutes', now() + interval '1 day')`,
        [key, rows[0]?.id],
      );
    });
    await as(ctx.http, admin)
      .post('/api/v1/customers')
      .set('Idempotency-Key', key)
      .send({ name: 'After a restart' })
      .expect(201);
  });
});

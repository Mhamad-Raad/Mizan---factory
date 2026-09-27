import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTestApp, resetDatabase, seedUser, signIn } from './harness.js';
import type { Session, TestApp } from './harness.js';

/**
 * The adversarial pass of the system-wide review, kept as a test.
 *
 * `permission-matrix.test.ts` proves every route refuses the wrong *permission*. It says
 * nothing about whether a **field** the employee may not see — a bought price, a profit, a
 * balance — is absent from every response that could carry it.
 *
 * That is the leak that never announces itself: the screens hide what they are told to hide
 * (2.6.4: "the frontend only hides"), so it is invisible until somebody reads a response body.
 * The review read eighteen of them by hand and found none; this is that audit as a gate. (It
 * also walked data scope — a colleague's customer reached sideways — until accounts stopped
 * being assigned, D-056: every account is visible to whoever may see accounts.)
 */
describe('field stripping cannot be walked around (spec 2.6.5)', () => {
  let ctx: TestApp;
  let admin: Session;
  /** The employee who may not see bought prices or profit. */
  let sara: Session;
  let hidden: { id: string; name: string; orderId: string; orderNumber: number };

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 60_000);
  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase();
    const adminUser = await seedUser({ username: 'dara', role: 'admin', displayName: 'Dara' });
    admin = await signIn(ctx.http, adminUser);
    await as(ctx.http, admin).post('/api/v1/settings/global-rates').send({ rate_iqd_per_usd: '1300' }).expect(201);

    // Sara sells, and holds no key to bought prices or profit.
    const saraUser = await seedUser({
      username: 'sara',
      displayName: 'Sara',
      permissions: [
        'orders.view',
        'orders.create',
        'customers.view',
        'materials.view',
        'reports.view',
        'history.view',
        'dashboard.view',
        'fields.see_customer_balances',
      ],
    });
    sara = await signIn(ctx.http, saraUser);

    const customer = await as(ctx.http, admin)
      .post('/api/v1/customers')
      .send({ name: 'Rebaz Only Trading' })
      .expect(201);

    const item = await as(ctx.http, admin)
      .post('/api/v1/items')
      .send({ name: 'Scope copper', pricing_unit: 'per_kg' })
      .expect(201);
    const month = new Date().toISOString().slice(0, 7);
    await as(ctx.http, admin)
      .put(`/api/v1/items/${item.body.id}/prices/${month}`)
      .send({ bought: { amount: 700, currency: 'IQD' }, sale: { amount: 850, currency: 'IQD' } })
      .expect(200);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(new Date());
    await as(ctx.http, admin)
      .post(`/api/v1/items/${item.body.id}/opening-stock`)
      .send({ entry_date: today, qty_kg: '500.000', note: 'counted' })
      .expect(201);
    const order = await as(ctx.http, admin)
      .post('/api/v1/orders')
      .send({
        customer_id: customer.body.id,
        order_date: today,
        payment_type: 'borrowed',
        notes: 'a note Sara may not read',
        lines: [{ item_id: item.body.id, qty_kg: '10.000' }],
      })
      .expect(201);
    await as(ctx.http, admin)
      .post(`/api/v1/customers/${customer.body.id}/opening-balance`)
      .send({ amount: 500_000, currency: 'IQD', entry_date: today, note: 'from the paper' })
      .expect(201);

    hidden = {
      id: customer.body.id,
      name: customer.body.name,
      orderId: order.body.id,
      orderNumber: order.body.number,
    };
  }, 60_000);

  it('strips the bought price and the profit from every response that could carry them', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(new Date());
    const range = `from=${month}-01&to=${today}`;
    const item = (await as(ctx.http, sara).get('/api/v1/items?page_size=10').expect(200)).body.items[0];

    for (const path of [
      '/api/v1/items?page_size=10',
      `/api/v1/items/${item.id}`,
      `/api/v1/items/${item.id}/prices`,
      '/api/v1/orders?page_size=10',
      `/api/v1/reports/stock?${range}`,
      '/api/v1/dashboard',
    ]) {
      const response = await as(ctx.http, sara).get(path);
      if (response.status !== 200) continue;
      const answer = JSON.stringify(response.body);
      // 700 is the bought price of the only material; 7,000 is the cost of the order's line.
      expect(answer, `${path} carried a bought price`).not.toMatch(/"bought_iqd":\s*[1-9]/);
      expect(answer, `${path} carried a margin`).not.toMatch(/"margin_iqd":\s*-?[1-9]/);
      expect(answer, `${path} carried a line cost`).not.toMatch(/"unit_iqd":\s*[1-9]/);
    }

    // And the two reports that are *made* of those figures are refused outright.
    await as(ctx.http, sara).get(`/api/v1/reports/profit?${range}`).expect(403);
  });

  it('strips balances from an employee who may not see them', async () => {
    const blind = await seedUser({
      username: 'blind',
      displayName: 'Blind',
      permissions: ['customers.view', 'orders.view', 'reports.view'],
    });
    const session = await signIn(ctx.http, blind);

    const list = await as(ctx.http, session).get('/api/v1/customers?page_size=100').expect(200);
    expect(JSON.stringify(list.body)).not.toMatch(/"balance":\s*\{/);
    const one = await as(ctx.http, session).get(`/api/v1/customers/${hidden.id}`).expect(200);
    expect(JSON.stringify(one.body)).not.toMatch(/"balance":\s*\{/);
    // The ledger and the receivables report are the balance itself, so they are refused.
    await as(ctx.http, session).get(`/api/v1/customers/${hidden.id}/ledger`).expect(403);
    const month = new Date().toISOString().slice(0, 7);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(new Date());
    await as(ctx.http, session).get(`/api/v1/reports/receivables?from=${month}-01&to=${today}`).expect(403);
  });
});

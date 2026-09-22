import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTestApp, resetDatabase, seedUser, signIn } from './harness.js';
import type { Session, TestApp } from './harness.js';

/**
 * The adversarial pass of the system-wide review, kept as a test.
 *
 * `permission-matrix.test.ts` proves every route refuses the wrong *permission*. It says
 * nothing about **data scope**: whether an employee who may not see a colleague's customer can
 * reach that customer sideways — by its id, through one of its orders, through search, through
 * a report or through History — nor whether a **field** the employee may not see is absent from
 * every response that could carry it.
 *
 * Those are the two leaks that never announce themselves: the screens hide what they are told
 * to hide (2.6.4: "the frontend only hides"), so a leak is invisible until somebody reads a
 * response body. The review read eighteen of them by hand and found none; this is that audit
 * as a gate, because the next change to a repository is the one that would undo it.
 */
describe('data scope and field stripping cannot be walked around (spec 2.6.4, 2.6.5)', () => {
  let ctx: TestApp;
  let admin: Session;
  /** The employee who may see only their own customers, and the colleague who owns one. */
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

    // Sara sells, and holds no key to other people's customers, bought prices or profit.
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
    const rebazUser = await seedUser({ username: 'rebaz', displayName: 'Rebaz', permissions: ['orders.view'] });

    const customer = await as(ctx.http, admin)
      .post('/api/v1/customers')
      .send({ name: 'Rebaz Only Trading' })
      .expect(201);
    await as(ctx.http, admin)
      .put(`/api/v1/customers/${customer.body.id}/assignment`)
      .send({ user_id: rebazUser.id, note: 'his account', version: customer.body.version })
      .expect(200);

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

  it('answers 404 — not 403 — on every direct route to a customer out of scope', async () => {
    // 404 rather than 403 on purpose: a refusal would confirm the record exists (2.6.4).
    for (const path of [
      `/api/v1/customers/${hidden.id}`,
      `/api/v1/customers/${hidden.id}/ledger`,
      `/api/v1/customers/${hidden.id}/statement`,
      `/api/v1/customers/${hidden.id}/history`,
      `/api/v1/orders/${hidden.orderId}`,
      `/api/v1/orders/${hidden.orderId}/receipt`,
      `/api/v1/orders/${hidden.orderId}/history`,
    ]) {
      const response = await as(ctx.http, sara).get(path);
      expect(response.status, `${path} answered ${response.status}`).toBe(404);
    }
  });

  it('never names that customer in a list, a search, a report or History', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(new Date());
    const range = `from=${month}-01&to=${today}`;

    for (const path of [
      '/api/v1/customers?page_size=100',
      '/api/v1/orders?page_size=100',
      `/api/v1/customers/${hidden.id}/orders`,
      `/api/v1/search?q=${encodeURIComponent(hidden.name)}`,
      `/api/v1/search?q=${hidden.orderNumber}`,
      `/api/v1/reports/receivables?${range}`,
      `/api/v1/reports/sales?${range}&group_by=customer`,
      '/api/v1/history?limit=100',
      '/api/v1/dashboard',
    ]) {
      const response = await as(ctx.http, sara).get(path);
      expect([200, 403], `${path} answered ${response.status}`).toContain(response.status);
      if (response.status !== 200) continue;
      // The search echoes the query, so the name is looked for in the *answer*, not the request.
      const answer = JSON.stringify({ ...response.body, query: undefined });
      expect(answer, `${path} named a customer out of scope`).not.toContain(hidden.name);
      expect(answer, `${path} carried that customer's note`).not.toContain('a note Sara may not read');
    }
  });

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
      permissions: ['customers.view', 'customers.view_all', 'orders.view', 'reports.view'],
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

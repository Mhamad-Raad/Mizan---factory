import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTestApp, resetDatabase, seedUser, signIn } from './harness.js';
import type { Session, TestApp } from './harness.js';

/**
 * An order's receipt names what the company still owes for earlier orders, order by order (D-109),
 * as the Pallet system's hand-over receipt lists the earlier pallets still out.
 */
describe('earlier orders still owed, on an order’s receipt (D-109)', () => {
  let ctx: TestApp;
  let admin: Session;
  let plain: Session;
  let kawa: string;
  let hawler: string;
  let bolts: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  const today = () =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(new Date());

  beforeEach(async () => {
    await resetDatabase();
    admin = await signIn(ctx.http, await seedUser({ username: 'admin.receipt', role: 'admin' }));
    plain = await signIn(
      ctx.http,
      await seedUser({ username: 'plain', permissions: ['orders.view'] }),
    );
    await as(ctx.http, admin)
      .post('/api/v1/settings/global-rates')
      .send({ rate_iqd_per_usd: '1300' })
      .expect(201);
    kawa = (
      await as(ctx.http, admin).post('/api/v1/customers').send({ name: 'Kawa Trading' }).expect(201)
    ).body.id;
    hawler = (
      await as(ctx.http, admin).post('/api/v1/customers').send({ name: 'Hawler Steel' }).expect(201)
    ).body.id;
    bolts = (
      await as(ctx.http, admin)
        .post('/api/v1/items')
        .send({ name: 'Bolts M8', pricing_unit: 'per_piece' })
        .expect(201)
    ).body.id;
    await as(ctx.http, admin)
      .put(`/api/v1/items/${bolts}/prices/${today().slice(0, 7)}`)
      .send({ sale: { amount: 2_000, currency: 'IQD' } })
      .expect(200);
    await as(ctx.http, admin)
      .post('/api/v1/purchases')
      .send({
        company_id: hawler,
        purchase_date: today(),
        lines: [
          { item_id: bolts, qty_count: 1_000, unit_price: { amount: 1_500, currency: 'IQD' } },
        ],
      })
      .expect(201);
  });

  const sell = (customer: string, count: number) =>
    as(ctx.http, admin)
      .post('/api/v1/orders')
      .send({
        customer_id: customer,
        order_date: today(),
        payment_type: 'borrowed',
        lines: [{ item_id: bolts, qty_count: count }],
      })
      .expect(201)
      .then((response) => response.body as { id: string; number: number; version: number });

  it('counts the company’s earlier orders still owed, and what is left on them', async () => {
    await sell(kawa, 10); // 20,000, nothing paid
    const paid = await sell(kawa, 5); // 10,000, paid below
    const partly = await sell(kawa, 20); // 40,000, 15,000 paid below
    const voided = await sell(kawa, 3);
    await sell(hawler, 7); // another company's
    const current = await sell(kawa, 4);
    await sell(kawa, 6); // a later order of the same company

    await as(ctx.http, admin)
      .post(`/api/v1/orders/${paid.id}/payments`)
      .send({ amount: 10_000, currency: 'IQD', entry_date: today() })
      .expect(201);
    await as(ctx.http, admin)
      .post(`/api/v1/orders/${partly.id}/payments`)
      .send({ amount: 15_000, currency: 'IQD', entry_date: today() })
      .expect(201);
    await as(ctx.http, admin)
      .post(`/api/v1/orders/${voided.id}/void`)
      .send({ reason: 'typed twice' })
      .expect(200);

    const receipt = await as(ctx.http, admin)
      .get(`/api/v1/orders/${current.id}/receipt`)
      .expect(200);
    expect(receipt.body.earlier_owing).toEqual({ count: 2, remaining: 45_000 });
    // The account: 20,000 + 25,000 + this order's 8,000 + the later 12,000.
    expect(receipt.body.balance_after).toBe(65_000);
  });

  it('says nothing earlier on the first order, and nothing at all to a reader without the balances flag', async () => {
    const first = await sell(kawa, 10);
    const second = await sell(kawa, 2);
    expect(
      (await as(ctx.http, admin).get(`/api/v1/orders/${first.id}/receipt`).expect(200)).body
        .earlier_owing,
    ).toEqual({ count: 0, remaining: 0 });
    const hidden = await as(ctx.http, plain).get(`/api/v1/orders/${second.id}/receipt`).expect(200);
    expect(hidden.body.earlier_owing).toBeNull();
    // Stripped from the answer altogether, as before (2.6.2).
    expect(hidden.body.balance_after ?? null).toBeNull();
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTestApp, resetDatabase, seedUser, signIn } from './harness.js';
import type { Session, TestApp } from './harness.js';

/**
 * Buying & selling (D-089): sales and purchases on one list, newest first and paged as one; each
 * reader sees the sides they may; the figures of the two sides are never added together.
 */
describe('buying and selling on one list (D-089)', () => {
  let ctx: TestApp;
  let admin: Session;
  let seller: Session;
  let buyer: Session;
  let nobody: Session;
  let bolts: string;
  let alNoor: string;
  let kawa: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase();
    admin = await signIn(ctx.http, await seedUser({ username: 'admin.trade', role: 'admin' }));
    seller = await signIn(ctx.http, await seedUser({ username: 'seller', permissions: ['orders.view'] }));
    buyer = await signIn(ctx.http, await seedUser({ username: 'buyer', permissions: ['purchases.view'] }));
    nobody = await signIn(ctx.http, await seedUser({ username: 'nobody', permissions: ['materials.view'] }));

    await as(ctx.http, admin).post('/api/v1/settings/global-rates').send({ rate_iqd_per_usd: '1300' }).expect(201);
    alNoor = (await as(ctx.http, admin).post('/api/v1/customers').send({ name: 'Al-Noor Steel Co.' }).expect(201)).body.id;
    kawa = (await as(ctx.http, admin).post('/api/v1/customers').send({ name: 'Kawa Trading' }).expect(201)).body.id;
    bolts = (await as(ctx.http, admin).post('/api/v1/items').send({ name: 'Bolts M8', pricing_unit: 'per_piece' }).expect(201))
      .body.id;
    const month = new Date().toISOString().slice(0, 7);
    await as(ctx.http, admin)
      .put(`/api/v1/items/${bolts}/prices/${month}`)
      .send({ sale: { amount: 2_000, currency: 'IQD' }, bought: { amount: 1_500, currency: 'IQD' } })
      .expect(200);
  });

  function day(back: number): string {
    const date = new Date(Date.now() - back * 86_400_000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(date);
  }

  const buy = (back: number) =>
    as(ctx.http, admin)
      .post('/api/v1/purchases')
      .send({
        company_id: alNoor,
        purchase_date: day(back),
        lines: [{ item_id: bolts, qty_count: 100, unit_price: { amount: 1_500, currency: 'IQD' } }],
      })
      .expect(201);
  const sell = (back: number, payment: 'cash' | 'borrowed' = 'borrowed') =>
    as(ctx.http, admin)
      .post('/api/v1/orders')
      .send({ customer_id: kawa, order_date: day(back), payment_type: payment, lines: [{ item_id: bolts, qty_count: 10 }] })
      .expect(201);

  it('lists sales and purchases newest first, paged as one list', async () => {
    const oldBuy = await buy(3);
    const sale = await sell(2);
    const newBuy = await buy(1);
    const today = await sell(0);

    const all = await as(ctx.http, admin).get('/api/v1/trade').expect(200);
    expect(all.body.total).toBe(4);
    expect(all.body.items.map((row: { kind: string; id: string }) => [row.kind, row.id])).toEqual([
      ['sale', today.body.id],
      ['purchase', newBuy.body.id],
      ['sale', sale.body.id],
      ['purchase', oldBuy.body.id],
    ]);
    // Paging runs across both kinds.
    const second = await as(ctx.http, admin).get('/api/v1/trade?page=2&page_size=3').expect(200);
    expect(second.body.items.map((row: { id: string }) => row.id)).toEqual([oldBuy.body.id]);

    const onlyBuys = await as(ctx.http, admin).get('/api/v1/trade?kind=purchase').expect(200);
    expect(onlyBuys.body.items.every((row: { kind: string }) => row.kind === 'purchase')).toBe(true);
  });

  it('shows each reader the sides they may, and refuses one with neither', async () => {
    await buy(1);
    await sell(0);
    const sales = await as(ctx.http, seller).get('/api/v1/trade').expect(200);
    expect(sales.body.items.map((row: { kind: string }) => row.kind)).toEqual(['sale']);
    expect(sales.body.totals.purchases).toBeUndefined();
    const buys = await as(ctx.http, buyer).get('/api/v1/trade').expect(200);
    expect(buys.body.items.map((row: { kind: string }) => row.kind)).toEqual(['purchase']);
    expect(buys.body.totals.sales).toBeUndefined();
    await as(ctx.http, nobody).get('/api/v1/trade').expect(403);
  });

  it('keeps a sale’s questions to sales, and asks "void" of both', async () => {
    await buy(1);
    const sale = await sell(0);
    const unpaid = await as(ctx.http, admin).get('/api/v1/trade?status=unpaid').expect(200);
    expect(unpaid.body.items.map((row: { id: string }) => row.id)).toEqual([sale.body.id]);
    const cash = await as(ctx.http, admin).get('/api/v1/trade?payment_type=borrowed').expect(200);
    expect(cash.body.items.every((row: { kind: string }) => row.kind === 'sale')).toBe(true);
    const voided = await as(ctx.http, admin).get('/api/v1/trade?status=void').expect(200);
    expect(voided.body.total).toBe(0);
  });

  it('gives each side its own figures, and the owed figures behind their flags', async () => {
    await buy(1);
    await sell(0);
    const all = await as(ctx.http, admin).get('/api/v1/trade').expect(200);
    expect(all.body.totals.sales).toMatchObject({ count: 1, total_iqd: 20_000 });
    expect(all.body.totals.purchases).toMatchObject({ count: 1, cost: { total_iqd: 150_000 } });
    expect(all.body.totals.owed_by_us).toEqual({ companies: 1, owed_iqd: 150_000, owed_usd_cents: 0 });
    expect(all.body.totals.owed_to_us).toEqual({ companies: 1, owed_iqd: 20_000, owed_usd_cents: 0 });

    // Without the flags: no bought prices, no balances, no paid state on a purchase.
    const plain = await as(ctx.http, buyer).get('/api/v1/trade').expect(200);
    expect(plain.body.totals.owed_by_us).toBeUndefined();
    expect(plain.body.totals.purchases.cost).toBeUndefined();
    expect(plain.body.items[0].cost).toBeUndefined();
    expect(plain.body.items[0].payment).toBeUndefined();
  });

  it('filters by company and search on both sides', async () => {
    await buy(1);
    await sell(0);
    const kawaOnly = await as(ctx.http, admin).get(`/api/v1/trade?company_id=${kawa}`).expect(200);
    expect(kawaOnly.body.items.map((row: { kind: string }) => row.kind)).toEqual(['sale']);
    const search = await as(ctx.http, admin).get('/api/v1/trade?q=Al-Noor').expect(200);
    expect(search.body.items.map((row: { kind: string }) => row.kind)).toEqual(['purchase']);
  });

  describe('what the review of D-089 found', () => {
    it('ignores a side the reader cannot switch to, so an old /orders link still shows a buyer their side', async () => {
      await buy(1);
      await sell(0);
      const asBuyer = await as(ctx.http, buyer).get('/api/v1/trade?kind=sale').expect(200);
      expect(asBuyer.body.items.map((row: { kind: string }) => row.kind)).toEqual(['purchase']);
    });

    it('keeps the owed figures when the filter leaves no side to list', async () => {
      await buy(1);
      await sell(0);
      const none = await as(ctx.http, admin).get('/api/v1/trade?kind=purchase&status=paid').expect(200);
      expect(none.body.items).toEqual([]);
      expect(none.body.totals.owed_by_us.owed_iqd).toBe(150_000);
      expect(none.body.totals.owed_to_us.owed_iqd).toBe(20_000);
    });

    it('pages across both kinds without repeating or losing a row', async () => {
      const ids: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        ids.push((await buy(index % 2)).body.id, (await sell(index % 2)).body.id);
      }
      const seen: string[] = [];
      for (let page = 1; page <= 3; page += 1) {
        const response = await as(ctx.http, admin).get(`/api/v1/trade?page=${page}&page_size=3`).expect(200);
        seen.push(...response.body.items.map((row: { id: string }) => row.id));
      }
      expect(seen).toHaveLength(8);
      expect(new Set(seen)).toEqual(new Set(ids));
    });
  });
});

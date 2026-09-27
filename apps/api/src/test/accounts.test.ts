import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTestApp, resetDatabase, seedUser, signIn } from './harness.js';
import type { Session, TestApp } from './harness.js';

/**
 * The warehouse and the accountant (client review, D-062).
 *
 * Buying is creating a material or adding to one, with no company; every buy keeps its price and
 * a sale takes the oldest first; a company that damaged our goods owes us their cost until it
 * pays back in money or in materials; the accountant adds expenses; and the accountant page adds
 * it all up for a period — each figure hand-computed below.
 */
describe('the warehouse and the accountant (D-062)', () => {
  let ctx: TestApp;
  let admin: Session;
  let clerk: Session;
  let bottles: string;
  let kawa: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  function today(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Baghdad',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  beforeEach(async () => {
    await resetDatabase();
    const adminUser = await seedUser({ username: 'admin.accounts', role: 'admin', displayName: 'Dara' });
    const clerkUser = await seedUser({
      username: 'rebaz.accounts',
      displayName: 'Rebaz',
      permissions: ['orders.create', 'materials.view'],
    });
    admin = await signIn(ctx.http, adminUser);
    clerk = await signIn(ctx.http, clerkUser);

    await as(ctx.http, admin).post('/api/v1/settings/global-rates').send({ rate_iqd_per_usd: '1310' }).expect(201);

    // Creating the material *is* buying it: 100 bottles at 1,310 د.ع ($1.00) each.
    const created = await as(ctx.http, admin)
      .post('/api/v1/items')
      .send({
        name: 'Glass bottle 1 L',
        pricing_unit: 'per_piece',
        buy: { qty_count: 100, unit_price: { amount: 1_310, currency: 'IQD' }, purchase_date: today() },
      })
      .expect(201);
    bottles = created.body.id;
    await as(ctx.http, admin)
      .put(`/api/v1/items/${bottles}/prices/${today().slice(0, 7)}`)
      .send({ sale: { amount: 3_000, currency: 'IQD' } })
      .expect(200);

    // A new shipment at $1.50: 200 more bottles at 1,965 د.ع — the same material, the same row.
    await as(ctx.http, admin)
      .post('/api/v1/purchases')
      .send({
        company_id: null,
        purchase_date: today(),
        lines: [{ item_id: bottles, qty_count: 200, unit_price: { amount: 1_965, currency: 'IQD' } }],
      })
      .expect(201);

    kawa = (await as(ctx.http, admin).post('/api/v1/customers').send({ name: 'Kawa Trading' }).expect(201)).body.id;
  });

  it('creates a material with its first buy, and keeps each buy at its own price', async () => {
    const lots = await as(ctx.http, admin).get(`/api/v1/items/${bottles}/lots`).expect(200);
    expect(lots.body.items.map((lot: { unit_cost_iqd: number; remaining: string }) => [lot.unit_cost_iqd, lot.remaining])).toEqual([
      [1_310, '100.000'],
      [1_965, '200.000'],
    ]);

    // Someone without bought prices sees the quantities, never what we paid.
    const plain = await as(ctx.http, clerk).get(`/api/v1/items/${bottles}/lots`).expect(200);
    expect(plain.body.items[0].remaining).toBe('100.000');
    expect('unit_cost_iqd' in plain.body.items[0]).toBe(false);
  });

  it('refuses the first buy to someone who may add materials but not buy', async () => {
    const maker = await seedUser({ username: 'maker', permissions: ['materials.create'] });
    const session = await signIn(ctx.http, maker);
    await as(ctx.http, session)
      .post('/api/v1/items')
      .send({
        name: 'Cork',
        pricing_unit: 'per_piece',
        buy: { qty_count: 5, unit_price: { amount: 100, currency: 'IQD' }, purchase_date: today() },
      })
      .expect(403);
  });

  it('adds up the period: sold, what it cost, profit, bought, expenses, damage and what is left', async () => {
    // 150 bottles sold at 3,000: 100 from the $1.00 buy, 50 from the $1.50 one.
    await as(ctx.http, admin)
      .post('/api/v1/orders')
      .send({ customer_id: kawa, order_date: today(), payment_type: 'borrowed', lines: [{ item_id: bottles, qty_count: 150 }] })
      .expect(201);

    // Rent, paid in dollars: $300 at 1,310 = 393,000 د.ع.
    await as(ctx.http, admin)
      .post('/api/v1/expenses')
      .send({ expense_date: today(), title: 'Warehouse rent', amount: { amount: 30_000, currency: 'USD' } })
      .expect(201);

    // We broke 10 bottles ourselves: the next 10 of the $1.50 buy, 19,650 د.ع of loss.
    await as(ctx.http, admin)
      .post('/api/v1/damages')
      .send({ item_id: bottles, qty_count: 10, damage_date: today(), attribution: 'us' })
      .expect(201);

    const summary = (await as(ctx.http, admin).get('/api/v1/accounts/summary').expect(200)).body;
    // Sold: 150 × 3,000 = 450,000.
    expect(summary.sold).toMatchObject({ amount_iqd: 450_000, count: 1 });
    // Cost: 100 × 1,310 + 50 × 1,965 = 131,000 + 98,250 = 229,250. Profit: 220,750.
    expect(summary.cost_of_sold.amount_iqd).toBe(229_250);
    expect(summary.profit.amount_iqd).toBe(220_750);
    // Bought: 100 × 1,310 + 200 × 1,965 = 131,000 + 393,000 = 524,000, in two buys.
    expect(summary.bought).toMatchObject({ amount_iqd: 524_000, count: 2 });
    expect(summary.expenses).toMatchObject({ amount_iqd: 393_000, amount_usd_cents: 30_000, count: 1 });
    expect(summary.damage_loss).toMatchObject({ amount_iqd: 19_650, count: 1 });
    // What is left: 220,750 − 393,000 − 19,650.
    expect(summary.net.amount_iqd).toBe(220_750 - 393_000 - 19_650);

    const sales = (await as(ctx.http, admin).get('/api/v1/accounts/sales?q=kawa').expect(200)).body;
    expect(sales.total).toBe(1);
    expect(sales.items[0].profit.amount_iqd).toBe(220_750);

    const materials = (await as(ctx.http, admin).get('/api/v1/accounts/materials?q=bottle').expect(200)).body;
    expect(materials.items[0]).toMatchObject({ sold_qty: '150.000', bought_qty: '300.000', stock: '140.000' });
  });

  it('puts a company damage on their account, and takes it off the costs only once paid back', async () => {
    const damage = await as(ctx.http, admin)
      .post('/api/v1/damages')
      .send({ item_id: bottles, qty_count: 10, damage_date: today(), attribution: 'company', company_id: kawa })
      .expect(201);
    expect(damage.body.compensation).toBe('owed');
    // 10 of the oldest buy, 13,100 د.ع, now owed by Kawa.
    const owed = (await as(ctx.http, admin).get(`/api/v1/customers/${kawa}`).expect(200)).body;
    expect(owed.balance.amount_iqd).toBe(13_100);
    let summary = (await as(ctx.http, admin).get('/api/v1/accounts/summary').expect(200)).body;
    expect(summary.damage_loss.amount_iqd).toBe(13_100);
    // The list can be narrowed to what is still owed, and says how much that is.
    const owedList = (await as(ctx.http, admin).get('/api/v1/damages?compensation=owed').expect(200)).body;
    expect(owedList.total).toBe(1);
    expect(owedList.totals.owed_count).toBe(1);
    expect(owedList.totals.cost.owed_iqd).toBe(13_100);

    const paid = await as(ctx.http, admin)
      .post(`/api/v1/damages/${damage.body.id}/paid-back`)
      .send({ method: 'money' })
      .expect(200);
    expect(paid.body.compensation).toBe('paid_money');
    expect((await as(ctx.http, admin).get(`/api/v1/customers/${kawa}`).expect(200)).body.balance.amount_iqd).toBe(0);
    summary = (await as(ctx.http, admin).get('/api/v1/accounts/summary').expect(200)).body;
    expect(summary.damage_loss.amount_iqd).toBe(0);
    expect(summary.damage_recovered).toMatchObject({ amount_iqd: 13_100, count: 1 });
    expect((await as(ctx.http, admin).get('/api/v1/damages?compensation=owed').expect(200)).body.total).toBe(0);
    expect((await as(ctx.http, admin).get('/api/v1/damages?compensation=paid').expect(200)).body.total).toBe(1);

    // Paid back once is paid back: a second time is refused.
    await as(ctx.http, admin).post(`/api/v1/damages/${damage.body.id}/paid-back`).send({ method: 'money' }).expect(422);
  });

  it('puts replaced goods back in stock, into the very buy they came from', async () => {
    const damage = await as(ctx.http, admin)
      .post('/api/v1/damages')
      .send({ item_id: bottles, qty_count: 10, damage_date: today(), attribution: 'company', company_id: kawa })
      .expect(201);
    let lots = (await as(ctx.http, admin).get(`/api/v1/items/${bottles}/lots`).expect(200)).body.items;
    expect(lots[0].remaining).toBe('90.000');

    await as(ctx.http, admin).post(`/api/v1/damages/${damage.body.id}/paid-back`).send({ method: 'materials' }).expect(200);
    lots = (await as(ctx.http, admin).get(`/api/v1/items/${bottles}/lots`).expect(200)).body.items;
    expect(lots[0].remaining).toBe('100.000');
    expect((await as(ctx.http, admin).get(`/api/v1/customers/${kawa}`).expect(200)).body.balance.amount_iqd).toBe(0);
  });

  it('asks for the company money keys before a damage is marked paid back', async () => {
    const damage = await as(ctx.http, admin)
      .post('/api/v1/damages')
      .send({ item_id: bottles, qty_count: 10, damage_date: today(), attribution: 'company', company_id: kawa })
      .expect(201);
    const paidBack = (session: Session, method: 'money' | 'materials') =>
      as(ctx.http, session).post(`/api/v1/damages/${damage.body.id}/paid-back`).send({ method });

    // The warehouse may mark returns, but money and credits on an account are not theirs.
    const warehouse = await signIn(
      ctx.http,
      await seedUser({ username: 'shwan.warehouse', permissions: ['damages.view', 'damages.mark_returned'] }),
    );
    const money = await paidBack(warehouse, 'money').expect(403);
    expect(money.body.error).toMatchObject({
      code: 'PERMISSION_DENIED',
      message_key: 'errors:paid_back_money_needs_permission',
      params: { required: 'companies.record_payment' },
    });
    const materials = await paidBack(warehouse, 'materials').expect(403);
    expect(materials.body.error).toMatchObject({
      message_key: 'errors:paid_back_materials_needs_permission',
      params: { required: 'companies.record_credit' },
    });
    // Nothing was written: the company still owes the damage.
    expect((await as(ctx.http, admin).get(`/api/v1/customers/${kawa}`).expect(200)).body.balance.amount_iqd).toBe(13_100);

    // With the key for the method, the same user may.
    const payer = await signIn(
      ctx.http,
      await seedUser({
        username: 'sara.payer',
        permissions: ['damages.view', 'damages.mark_returned', 'companies.record_payment'],
      }),
    );
    await paidBack(payer, 'materials').expect(403);
    await paidBack(payer, 'money').expect(200);
  });

  it('voids an expense with a reason, and keeps it out of the totals', async () => {
    const expense = await as(ctx.http, admin)
      .post('/api/v1/expenses')
      .send({ expense_date: today(), title: 'Electricity', amount: { amount: 250_000, currency: 'IQD' } })
      .expect(201);
    await as(ctx.http, admin).post(`/api/v1/expenses/${expense.body.id}/void`).send({ reason: 'entered twice' }).expect(200);
    const summary = (await as(ctx.http, admin).get('/api/v1/accounts/summary').expect(200)).body;
    expect(summary.expenses.count).toBe(0);
  });

  it('keeps the accountant page to those allowed to see it', async () => {
    await as(ctx.http, clerk).get('/api/v1/accounts/summary').expect(403);
    await as(ctx.http, clerk)
      .post('/api/v1/expenses')
      .send({ expense_date: today(), title: 'Tea', amount: { amount: 5_000, currency: 'IQD' } })
      .expect(403);
  });
});

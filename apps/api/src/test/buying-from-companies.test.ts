import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTestApp, resetDatabase, seedUser, signIn, withDatabase } from './harness.js';
import type { Session, TestApp } from './harness.js';

/**
 * Buying from companies again (D-085): a buy names the company it came from, what it cost goes on
 * that company's account as what we owe, and what was paid on the spot is a payment written in
 * the same transaction — all of it, or a part in either currency. The Companies list can show
 * only the ones we owe, and the Buys list carries its own figures.
 */
describe('buying from companies, and paying them on the spot (D-085)', () => {
  let ctx: TestApp;
  let admin: Session;
  /** Buys and pays: the purchases keys and the company payment key. */
  let buyer: Session;
  /** Buys, but may not pay a company. */
  let storekeeper: Session;
  /** Sees companies and buys, but neither bought prices nor company money. */
  let looker: Session;
  let bolts: string;
  let alNoor: string;
  let dollarCo: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase();
    const adminUser = await seedUser({ username: 'admin.d085', role: 'admin', displayName: 'Dara' });
    const buyerUser = await seedUser({
      username: 'buyer',
      displayName: 'Rebaz',
      permissions: [
        'purchases.create',
        'purchases.view',
        'companies.view',
        'companies.record_payment',
        'fields.see_company_balances',
        'fields.see_bought_price',
        'materials.create',
      ],
    });
    const storeUser = await seedUser({
      username: 'store',
      displayName: 'Hemin',
      permissions: ['purchases.create', 'purchases.view', 'companies.view', 'materials.create'],
    });
    const lookUser = await seedUser({
      username: 'looker',
      displayName: 'Shilan',
      permissions: ['purchases.view', 'companies.view', 'customers.view'],
    });
    admin = await signIn(ctx.http, adminUser);
    buyer = await signIn(ctx.http, buyerUser);
    storekeeper = await signIn(ctx.http, storeUser);
    looker = await signIn(ctx.http, lookUser);

    await as(ctx.http, admin).post('/api/v1/settings/global-rates').send({ rate_iqd_per_usd: '1300' }).expect(201);
    bolts = (
      await as(ctx.http, admin).post('/api/v1/items').send({ name: 'Bolts M8', pricing_unit: 'per_piece' }).expect(201)
    ).body.id as string;
    alNoor = (await as(ctx.http, admin).post('/api/v1/customers').send({ name: 'Al-Noor Steel Co.' }).expect(201)).body
      .id as string;
    dollarCo = (
      await as(ctx.http, admin)
        .post('/api/v1/customers')
        .send({ name: 'Gulf Fasteners', settlement_currency: 'USD' })
        .expect(201)
    ).body.id as string;
  });

  function today(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Baghdad',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  /** 100 bolts at 1,500 dinars: a buy of 150,000 dinars. */
  function buy(session: Session, extra: Record<string, unknown> = {}) {
    return as(ctx.http, session)
      .post('/api/v1/purchases')
      .send({
        company_id: alNoor,
        purchase_date: today(),
        lines: [{ item_id: bolts, qty_count: 100, unit_price: { amount: 1_500, currency: 'IQD' } }],
        ...extra,
      });
  }

  async function ledgerOf(companyId: string) {
    return withDatabase(async (client) => {
      const { rows } = await client.query<{
        id: string;
        entry_type: string;
        amount_iqd: string;
        amount_usd_cents: string;
        purchase_id: string | null;
        voucher_number: string | null;
        entry_date: string;
      }>(
        `SELECT id, entry_type::text AS entry_type, amount_iqd::text AS amount_iqd,
                amount_usd_cents::text AS amount_usd_cents, purchase_id,
                voucher_number::text AS voucher_number, to_char(entry_date, 'YYYY-MM-DD') AS entry_date
           FROM company_ledger WHERE company_id = $1 ORDER BY posting_seq ASC`,
        [companyId],
      );
      return rows;
    });
  }

  async function purchaseCount(): Promise<number> {
    return withDatabase(async (client) => {
      const { rows } = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM purchases');
      return Number(rows[0]?.n ?? 0);
    });
  }

  it('puts a buy on the company as owed when nothing is paid', async () => {
    const created = await buy(buyer).expect(201);
    expect(created.body.paid_entry_id).toBeNull();
    const ledger = await ledgerOf(alNoor);
    expect(ledger.map((row) => row.entry_type)).toEqual(['purchase']);
    expect(Number(ledger[0]?.amount_iqd)).toBe(150_000);

    const balance = await as(ctx.http, buyer).get(`/api/v1/purchases/${created.body.id}/balance`).expect(200);
    expect(balance.body.cost.remaining).toBe(150_000);
  });

  it('pays all of it on the spot: the buy lands on exactly zero in both currencies', async () => {
    const created = await buy(buyer, { paid: { in_full: true } }).expect(201);
    const ledger = await ledgerOf(alNoor);
    expect(ledger.map((row) => row.entry_type)).toEqual(['purchase', 'payment']);
    const [purchase, payment] = ledger as [(typeof ledger)[number], (typeof ledger)[number]];
    expect(Number(payment.amount_iqd)).toBe(-Number(purchase.amount_iqd));
    expect(Number(payment.amount_usd_cents)).toBe(-Number(purchase.amount_usd_cents));
    // It names the buy, is dated with it, and has a voucher to print.
    expect(payment.purchase_id).toBe(created.body.id);
    expect(payment.entry_date).toBe(today());
    expect(payment.voucher_number).not.toBeNull();
    expect(created.body.paid_entry_id).toBe(payment.id);

    const balance = await as(ctx.http, buyer).get(`/api/v1/purchases/${created.body.id}/balance`).expect(200);
    expect(balance.body.cost.remaining).toBe(0);
    const company = await as(ctx.http, buyer).get(`/api/v1/customers/${alNoor}`).expect(200);
    expect(company.body.payable.amount_iqd).toBe(0);
  });

  it('pays part in the other currency at the buy’s own rate, and the rest stays owed', async () => {
    // $50 at the buy's 1,300 is 65,000 dinars of a 150,000-dinar buy.
    const created = await buy(buyer, {
      rate_iqd_per_usd: '1300',
      paid: { amount: 5_000, currency: 'USD' },
    }).expect(201);
    const ledger = await ledgerOf(alNoor);
    const payment = ledger.find((row) => row.entry_type === 'payment');
    expect(Number(payment?.amount_iqd)).toBe(-65_000);
    expect(Number(payment?.amount_usd_cents)).toBe(-5_000);

    const balance = await as(ctx.http, buyer).get(`/api/v1/purchases/${created.body.id}/balance`).expect(200);
    expect(balance.body.cost.remaining).toBe(85_000);
  });

  it('pays a dollar company all of it to the cent', async () => {
    const created = await buy(buyer, { company_id: dollarCo, paid: { in_full: true } }).expect(201);
    const ledger = await ledgerOf(dollarCo);
    const sum = (key: 'amount_iqd' | 'amount_usd_cents') => ledger.reduce((total, row) => total + Number(row[key]), 0);
    expect(sum('amount_iqd')).toBe(0);
    expect(sum('amount_usd_cents')).toBe(0);
    const balance = await as(ctx.http, buyer).get(`/api/v1/purchases/${created.body.id}/balance`).expect(200);
    expect(balance.body.settlement_currency).toBe('USD');
    expect(balance.body.cost.remaining).toBe(0);
  });

  it('refuses to pay more than the buy, and then writes nothing at all', async () => {
    const refused = await buy(buyer, { paid: { amount: 150_001, currency: 'IQD' } }).expect(422);
    expect(refused.body.error.fields[0].path).toBe('paid.amount');
    expect(refused.body.error.fields[0].code).toBe('EXCEEDS_TOTAL');
    expect(await purchaseCount()).toBe(0);
    expect(await ledgerOf(alNoor)).toEqual([]);
  });

  it('refuses "paid now" on a buy from no company, and from someone who may not pay companies', async () => {
    const noCompany = await buy(buyer, { company_id: null, paid: { in_full: true } }).expect(422);
    expect(noCompany.body.error.fields[0].code).toBe('NO_COMPANY');
    await buy(storekeeper, { paid: { in_full: true } }).expect(403);
    expect(await purchaseCount()).toBe(0);
    // The same person may still buy on credit.
    await buy(storekeeper).expect(201);
  });

  it('never takes "paid now" on an edit', async () => {
    const created = await buy(buyer).expect(201);
    await as(ctx.http, admin)
      .put(`/api/v1/purchases/${created.body.id}`)
      .send({
        company_id: alNoor,
        purchase_date: today(),
        version: created.body.version,
        lines: [{ item_id: bolts, qty_count: 100, unit_price: { amount: 1_500, currency: 'IQD' } }],
        paid: { in_full: true },
      })
      .expect(200);
    expect((await ledgerOf(alNoor)).filter((row) => row.entry_type === 'payment')).toEqual([]);
  });

  it('buys a new material from a company and pays part of it in the same request', async () => {
    const created = await as(ctx.http, buyer)
      .post('/api/v1/items')
      .send({
        name: 'Washers M8',
        pricing_unit: 'per_piece',
        buy: {
          qty_count: 200,
          unit_price: { amount: 250, currency: 'IQD' },
          purchase_date: today(),
          company_id: alNoor,
          paid: { amount: 20_000, currency: 'IQD' },
        },
      })
      .expect(201);
    expect(created.body.id).toBeTruthy();
    const ledger = await ledgerOf(alNoor);
    expect(ledger.map((row) => [row.entry_type, Number(row.amount_iqd)])).toEqual([
      ['purchase', 50_000],
      ['payment', -20_000],
    ]);
    const company = await as(ctx.http, buyer).get(`/api/v1/customers/${alNoor}`).expect(200);
    expect(company.body.payable.amount_iqd).toBe(30_000);
  });

  it('lists only the companies we owe, for anyone who may see what we owe', async () => {
    await buy(buyer).expect(201);
    // Gulf is bought from and paid in full: we owe it nothing.
    await buy(buyer, { company_id: dollarCo, paid: { in_full: true } }).expect(201);

    const owed = await as(ctx.http, buyer).get('/api/v1/customers?balance=we_owe').expect(200);
    expect(owed.body.items.map((row: { id: string }) => row.id)).toEqual([alNoor]);

    // Without the buying side's flag the filter is ignored, so it tells them nothing.
    const ignored = await as(ctx.http, looker).get('/api/v1/customers?balance=we_owe').expect(200);
    expect(ignored.body.total).toBeGreaterThanOrEqual(2);
  });

  it('gives the Buys list its figures, each behind its own flag', async () => {
    await buy(buyer).expect(201);
    const second = await buy(buyer, { paid: { amount: 50_000, currency: 'IQD' } }).expect(201);
    const voided = await buy(buyer).expect(201);
    await as(ctx.http, admin)
      .post(`/api/v1/purchases/${voided.body.id}/void`)
      .send({ reason: 'typed twice' })
      .expect(200);

    const list = await as(ctx.http, buyer).get('/api/v1/purchases').expect(200);
    // A voided buy is listed but bought nothing.
    expect(list.body.total).toBe(3);
    expect(list.body.totals.buys).toBe(2);
    expect(list.body.totals.cost).toEqual({ total_iqd: 300_000, total_usd_cents: expect.any(Number) });
    // 150,000 + 100,000 still owed, on one company.
    expect(list.body.totals.owed_by_us.companies).toBe(1);
    expect(list.body.totals.owed_by_us.owed_iqd).toBe(250_000);
    expect(second.body.paid_entry_id).toBeTruthy();

    const stripped = await as(ctx.http, looker).get('/api/v1/purchases').expect(200);
    expect(stripped.body.totals.buys).toBe(2);
    expect(stripped.body.totals.cost).toBeUndefined();
    expect(stripped.body.totals.owed_by_us).toBeUndefined();
  });

  it('names the purchase on every account row and statement row that is about one (D-086)', async () => {
    const created = await buy(buyer, { paid: { amount: 50_000, currency: 'IQD' } }).expect(201);
    const number = created.body.number as number;

    const ledger = await as(ctx.http, buyer).get(`/api/v1/companies/${alNoor}/ledger`).expect(200);
    expect(ledger.body.items.map((row: { entry_type: string; purchase_number: number | null }) => [row.entry_type, row.purchase_number])).toEqual([
      ['payment', number],
      ['purchase', number],
    ]);

    const statement = await as(ctx.http, buyer)
      .get(`/api/v1/companies/${alNoor}/statement?from=${today()}&to=${today()}`)
      .expect(200);
    expect(statement.body.items.every((row: { purchase_number: number | null }) => row.purchase_number === number)).toBe(true);
    expect(statement.body.closing_balance).toBe(100_000);
  });
});

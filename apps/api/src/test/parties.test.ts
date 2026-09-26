import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTestApp, resetDatabase, seedUser, signIn, withDatabase } from './harness.js';
import type { Session, TestApp } from './harness.js';

/**
 * Customers and companies are one record per business (D-054).
 *
 * The client's words: "companies and customers are one thing". A business may be a customer, a
 * company we buy from, or both; it has one rate, used on both sides; and one net balance — what
 * it owes us less what we owe it — while each side keeps its own append-only ledger, so nothing
 * the money kernel guarantees changes. These cases are the acceptance criteria of that change.
 */
describe('one record per business (D-054)', () => {
  let ctx: TestApp;
  let admin: Session;
  /** Rebaz: sells, sees his own customers and their balances. */
  let sales: Session;
  /** Hemin: buys, sees every company. */
  let warehouse: Session;
  /** Nazdar: pays companies, sees what we owe but not what customers owe. */
  let accountant: Session;
  let salesUserId: string;
  let copper: string;
  /** A customer only, assigned to Rebaz. */
  let kawa: string;
  /** A customer *and* a company we buy from, assigned to nobody. */
  let zagros: string;
  /** A company only. */
  let alNoor: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase();

    const adminUser = await seedUser({ username: 'admin.parties', role: 'admin', displayName: 'Dara' });
    const salesUser = await seedUser({
      username: 'rebaz',
      displayName: 'Rebaz',
      permissions: ['orders.create', 'customers.create', 'customers.edit', 'fields.see_customer_balances'],
    });
    const warehouseUser = await seedUser({
      username: 'hemin',
      displayName: 'Hemin',
      permissions: ['purchases.create', 'companies.create', 'companies.edit', 'companies.view'],
    });
    const accountantUser = await seedUser({
      username: 'nazdar',
      displayName: 'Nazdar',
      permissions: ['companies.record_payment', 'companies.set_rate', 'fields.see_company_balances'],
    });
    salesUserId = salesUser.id;

    admin = await signIn(ctx.http, adminUser);
    sales = await signIn(ctx.http, salesUser);
    warehouse = await signIn(ctx.http, warehouseUser);
    accountant = await signIn(ctx.http, accountantUser);

    await as(ctx.http, admin)
      .post('/api/v1/settings/global-rates')
      .send({ rate_iqd_per_usd: '1300' })
      .expect(201);

    const item = await as(ctx.http, admin)
      .post('/api/v1/items')
      .send({ name: 'Copper wire 2 mm', pricing_unit: 'per_kg' })
      .expect(201);
    copper = item.body.id;
    await as(ctx.http, admin)
      .put(`/api/v1/items/${copper}/prices/${new Date().toISOString().slice(0, 7)}`)
      .send({ sale: { amount: 850, currency: 'IQD' }, bought: { amount: 700, currency: 'IQD' } })
      .expect(200);

    kawa = await createParty(admin, { name: 'Kawa Trading', assigned_user_id: salesUserId });
    zagros = await createParty(admin, { name: 'Zagros Metals', is_customer: true, is_supplier: true });
    alNoor = await createParty(admin, { name: 'Al-Noor Steel Co.', is_customer: false, is_supplier: true });
  });

  async function createParty(session: Session, body: Record<string, unknown>): Promise<string> {
    const created = await as(ctx.http, session).post('/api/v1/customers').send(body).expect(201);
    return created.body.id as string;
  }

  function today(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Baghdad',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  function buyFrom(session: Session, companyId: string, kg: string) {
    return as(ctx.http, session)
      .post('/api/v1/purchases')
      .send({ company_id: companyId, purchase_date: today(), lines: [{ item_id: copper, qty_kg: kg }] });
  }

  function sellTo(session: Session, customerId: string, kg: string) {
    return as(ctx.http, session).post('/api/v1/orders').send({
      customer_id: customerId,
      order_date: today(),
      payment_type: 'borrowed',
      lines: [{ item_id: copper, qty_kg: kg }],
    });
  }

  describe('one balance per business', () => {
    it('nets what they owe us against what we owe them', async () => {
      await buyFrom(admin, zagros, '200.000').expect(201); // we owe them 140,000
      await sellTo(admin, zagros, '100.000').expect(201); // they owe us 85,000

      const detail = await as(ctx.http, admin).get(`/api/v1/customers/${zagros}`).expect(200);
      expect(detail.body).toMatchObject({ is_customer: true, is_supplier: true });
      expect(detail.body.balance.amount_iqd).toBe(85_000);
      expect(detail.body.payable.amount_iqd).toBe(140_000);
      expect(detail.body.net.amount_iqd).toBe(-55_000);

      // The list carries the same net, and "we owe them" finds it.
      const list = await as(ctx.http, admin)
        .get('/api/v1/customers')
        .query({ balance: 'credit' })
        .expect(200);
      expect(list.body.items.map((row: { id: string }) => row.id)).toEqual([zagros]);
      expect(list.body.items[0].net.amount_iqd).toBe(-55_000);
    });

    it('shows each side only to whoever may see it, and the net only to whoever may see both', async () => {
      await buyFrom(admin, zagros, '200.000').expect(201);
      await sellTo(admin, zagros, '100.000').expect(201);

      // The accountant sees what we owe, not what customers owe — and so not the net either,
      // which would give the hidden side away.
      const theirs = await as(ctx.http, accountant).get(`/api/v1/customers/${zagros}`).expect(200);
      expect('balance' in theirs.body).toBe(false);
      expect(theirs.body.payable.amount_iqd).toBe(140_000);
      expect(theirs.body.net).toBeNull();
    });
  });

  describe('one rate per business', () => {
    it('prices both its orders and its purchases at its own rate, stored as its own', async () => {
      await as(ctx.http, accountant)
        .post(`/api/v1/customers/${zagros}/rates`)
        .send({ rate_iqd_per_usd: '1320', note: 'agreed with Zagros' })
        .expect(201);

      const purchase = await buyFrom(admin, zagros, '10.000').expect(201);
      const order = await sellTo(admin, zagros, '10.000').expect(201);

      for (const document of [purchase.body, order.body]) {
        expect(document.rate_iqd_per_usd).toBe('1320.0000');
        expect(document.rate_source).toBe('company');
      }
    });

    it('re-bases both ledgers when the business changes its settlement currency', async () => {
      await buyFrom(admin, zagros, '200.000').expect(201);
      await sellTo(admin, zagros, '100.000').expect(201);

      const changed = await as(ctx.http, admin)
        .put(`/api/v1/customers/${zagros}/settlement-currency`)
        .send({ currency: 'USD', note: 'settles in dollars now', rebase_rate: '1300' })
        .expect(200);
      expect(changed.body.settlement_currency).toBe('USD');

      const sums = await withDatabase(async (client) => {
        const { rows } = await client.query<{ side: string; usd: string; markers: string }>(
          `SELECT 'selling' AS side, sum(amount_usd_cents)::text AS usd,
                  count(*) FILTER (WHERE entry_type = 'settlement_change')::text AS markers
             FROM customer_ledger WHERE customer_id = $1
           UNION ALL
           SELECT 'buying', sum(amount_usd_cents)::text,
                  count(*) FILTER (WHERE entry_type = 'settlement_change')::text
             FROM company_ledger WHERE company_id = $1`,
          [zagros],
        );
        return Object.fromEntries(rows.map((row) => [row.side, row]));
      });
      // 85,000 and 140,000 dinars at the agreed 1,300: $65.38 and $107.69, one marker each.
      expect(sums.selling).toMatchObject({ usd: '6538', markers: '1' });
      expect(sums.buying).toMatchObject({ usd: '10769', markers: '1' });
      expect(changed.body.net.amount_usd_cents).toBe(6538 - 10769);
    });
  });

  describe('who sees and makes which side', () => {
    it('shows a warehouse employee every company and none of anybody else’s customers', async () => {
      const seen = await as(ctx.http, warehouse).get('/api/v1/customers').expect(200);
      expect(seen.body.items.map((row: { name: string }) => row.name).sort()).toEqual([
        'Al-Noor Steel Co.',
        'Zagros Metals',
      ]);

      const suppliers = await as(ctx.http, sales).get('/api/v1/customers').expect(200);
      expect(suppliers.body.items.map((row: { name: string }) => row.name)).toEqual(['Kawa Trading']);
    });

    it('filters the list to one side', async () => {
      const onlyCompanies = await as(ctx.http, admin)
        .get('/api/v1/customers')
        .query({ side: 'supplier' })
        .expect(200);
      expect(onlyCompanies.body.items.map((row: { name: string }) => row.name).sort()).toEqual([
        'Al-Noor Steel Co.',
        'Zagros Metals',
      ]);
    });

    it('asks for the permission of each side the new record takes part in', async () => {
      await as(ctx.http, sales)
        .post('/api/v1/customers')
        .send({ name: 'Somebody we buy from', is_customer: false, is_supplier: true })
        .expect(403);
      await as(ctx.http, warehouse).post('/api/v1/customers').send({ name: 'A new customer' }).expect(403);
      await as(ctx.http, warehouse)
        .post('/api/v1/customers')
        .send({ name: 'Erbil Wire', is_customer: false, is_supplier: true })
        .expect(201);

      const neither = await as(ctx.http, admin)
        .post('/api/v1/customers')
        .send({ name: 'Nobody', is_customer: false, is_supplier: false })
        .expect(422);
      expect(neither.body.error.fields[0].code).toBe('NO_SIDE');
    });
  });

  describe('each side keeps its documents', () => {
    it('refuses an order to a business we only buy from, and a purchase from one we only sell to', async () => {
      const order = await sellTo(admin, alNoor, '1.000').expect(422);
      expect(order.body.error.fields[0].code).toBe('NOT_A_CUSTOMER');

      const purchase = await buyFrom(admin, kawa, '1.000');
      expect(purchase.status).not.toBe(201);
    });

    it('will not switch off a side that already has documents on it', async () => {
      await buyFrom(admin, zagros, '5.000').expect(201);
      const current = await as(ctx.http, admin).get(`/api/v1/customers/${zagros}`).expect(200);

      const refused = await as(ctx.http, admin)
        .patch(`/api/v1/customers/${zagros}`)
        .send({ is_supplier: false, version: current.body.version })
        .expect(422);
      expect(refused.body.error.fields[0]).toMatchObject({ path: 'is_supplier', code: 'SIDE_IN_USE' });

      // The side with nothing on it can go.
      const changed = await as(ctx.http, admin)
        .patch(`/api/v1/customers/${zagros}`)
        .send({ is_customer: false, version: current.body.version })
        .expect(200);
      expect(changed.body).toMatchObject({ is_customer: false, is_supplier: true });
    });

    it('tells the whole story of the business in its History, both sides', async () => {
      await buyFrom(admin, zagros, '5.000').expect(201);
      await sellTo(admin, zagros, '5.000').expect(201);

      const history = await as(ctx.http, admin).get(`/api/v1/customers/${zagros}/history`).expect(200);
      const kinds = new Set(history.body.items.map((row: { entity_type: string }) => row.entity_type));
      expect([...kinds].sort()).toEqual(['company', 'customer']);
    });
  });
});

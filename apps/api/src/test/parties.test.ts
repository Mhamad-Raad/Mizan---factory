import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTestApp, resetDatabase, seedUser, signIn, withDatabase } from './harness.js';
import type { Session, TestApp } from './harness.js';

/**
 * One kind of account: a company (D-054, D-055).
 *
 * The client's words: "companies and customers are one thing … there is only company". Every
 * account can be sold to and bought from; it has one rate, used on both sides; and one net
 * balance — what it owes us less what we owe it — while each side keeps its own append-only
 * ledger, so nothing the money kernel guarantees changes. The walk-in customer is the one record
 * that is not an ordinary account: cash at the counter, never a purchase.
 */
describe('one kind of account (D-054, D-055)', () => {
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
  /** Assigned to Rebaz. */
  let kawa: string;
  /** Assigned to nobody; we both buy from it and sell to it. */
  let zagros: string;
  /** Assigned to nobody. */
  let alNoor: string;
  let walkIn: string;

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
    zagros = await createParty(admin, { name: 'Zagros Metals' });
    alNoor = await createParty(admin, { name: 'Al-Noor Steel Co.' });
    walkIn = await withDatabase(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO customers (name, name_normalized, is_system, created_by, updated_by)
         VALUES ('Walk-in customer', 'walk-in customer', true, $1, $1) RETURNING id`,
        [adminUser.id],
      );
      return rows[0]?.id as string;
    });
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
      expect(detail.body).not.toHaveProperty('is_customer');
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

  describe('the rate on the account form (D-055)', () => {
    it('takes the rate typed on the form, prices the orders at it, and keeps it on each order', async () => {
      const created = await as(ctx.http, admin)
        .post('/api/v1/customers')
        .send({ name: 'Soran Steel', rate_iqd_per_usd: '1320' })
        .expect(201);
      expect(created.body.rate).toMatchObject({ rate_iqd_per_usd: '1320.0000', is_customer_rate: true });

      const first = await sellTo(admin, created.body.id, '10.000').expect(201);
      expect(first.body).toMatchObject({ rate_iqd_per_usd: '1320.0000', rate_source: 'company' });

      // A new rate on the edit form is a new row: the order made before it keeps its own.
      await as(ctx.http, admin)
        .patch(`/api/v1/customers/${created.body.id}`)
        .send({ rate_iqd_per_usd: '1335', version: created.body.version })
        .expect(200);
      const second = await sellTo(admin, created.body.id, '10.000').expect(201);
      expect(second.body.rate_iqd_per_usd).toBe('1335.0000');
      const before = await as(ctx.http, admin).get(`/api/v1/orders/${first.body.id}`).expect(200);
      expect(before.body.rate_iqd_per_usd).toBe('1320.0000');
    });

    it('says who changed the rate, when and from what, and filters History to it', async () => {
      await as(ctx.http, accountant)
        .post(`/api/v1/customers/${zagros}/rates`)
        .send({ rate_iqd_per_usd: '1320' })
        .expect(201);
      await as(ctx.http, accountant)
        .post(`/api/v1/customers/${zagros}/rates`)
        .send({ rate_iqd_per_usd: '1325', note: 'new agreement' })
        .expect(201);
      await sellTo(admin, zagros, '5.000').expect(201);

      const rates = await as(ctx.http, admin)
        .get(`/api/v1/customers/${zagros}/history`)
        .query({ action: 'rate_change' })
        .expect(200);
      expect(rates.body.items.map((row: { action: string }) => row.action)).toEqual(['rate_change', 'rate_change']);
      expect(rates.body.items[0]).toMatchObject({
        actor_display_name: 'Nazdar',
        note: 'new agreement',
        changes: { rate_iqd_per_usd: { old: '1320.0000', new: '1325.0000' } },
      });
    });

    it('refuses a rate on the form from somebody who may not set rates', async () => {
      await as(ctx.http, sales)
        .post('/api/v1/customers')
        .send({ name: 'Erbil Wire', rate_iqd_per_usd: '1400' })
        .expect(403);
    });
  });

  describe('who sees and makes an account', () => {
    it('shows whoever may see the companies every account, and a salesman his own', async () => {
      const seen = await as(ctx.http, warehouse).get('/api/v1/customers').expect(200);
      expect(seen.body.items.map((row: { name: string }) => row.name).sort()).toEqual([
        'Al-Noor Steel Co.',
        'Kawa Trading',
        'Walk-in customer',
        'Zagros Metals',
      ]);

      const own = await as(ctx.http, sales).get('/api/v1/customers').expect(200);
      expect(own.body.items.map((row: { name: string }) => row.name).sort()).toEqual([
        'Kawa Trading',
        'Walk-in customer',
      ]);
    });

    it('lets either side’s permission create an account, and refuses somebody with neither', async () => {
      await as(ctx.http, sales).post('/api/v1/customers').send({ name: 'Erbil Wire' }).expect(201);
      await as(ctx.http, warehouse).post('/api/v1/customers').send({ name: 'Duhok Steel' }).expect(201);
      await as(ctx.http, accountant).post('/api/v1/customers').send({ name: 'Nobody' }).expect(403);
    });
  });

  describe('every account on both sides', () => {
    it('sells to and buys from any account, and never buys from the walk-in', async () => {
      await sellTo(admin, alNoor, '1.000').expect(201);
      await buyFrom(admin, kawa, '1.000').expect(201);

      const fromTheCounter = await buyFrom(admin, walkIn, '1.000');
      expect(fromTheCounter.status).not.toBe(201);
    });

    it('tells the whole story of the account in its History, both sides', async () => {
      await buyFrom(admin, zagros, '5.000').expect(201);
      await sellTo(admin, zagros, '5.000').expect(201);

      const history = await as(ctx.http, admin).get(`/api/v1/customers/${zagros}/history`).expect(200);
      const kinds = new Set(history.body.items.map((row: { entity_type: string }) => row.entity_type));
      expect([...kinds].sort()).toEqual(['company', 'customer']);
    });
  });
});

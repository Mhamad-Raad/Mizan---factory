import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  as,
  auditRows,
  createTestApp,
  resetDatabase,
  seedUser,
  signIn,
  withDatabase,
} from './harness.js';
import type { Session, TestApp } from './harness.js';

/**
 * Orders, payments and the customer ledger (FR-501 to FR-507, FR-601 to FR-612).
 *
 * The cases are the acceptance criteria of iteration 1: the 850 IQD/kg × 5,000 kg figure, the
 * cash order with the currency received, borrowed → partial → paid, settle in full with no
 * residue, the payment-type switch in both directions, edit and void with compensating
 * movements, the period lock, the scope rules, and the invariant that a customer's balance is
 * the sum of their ledger.
 */
describe('orders, payments and the customer ledger (FR-601 to FR-612)', () => {
  let ctx: TestApp;
  let admin: Session;
  /** Rebaz: the Sales preset — his own customers only. */
  let sales: Session;
  /** Sara: another sales employee, to prove the scope rules. */
  let otherSales: Session;
  let salesUserId: string;
  let otherSalesUserId: string;
  let copper: string;
  let steel: string;
  let kawa: string;
  let walkIn: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase();

    const adminUser = await seedUser({
      username: 'admin.orders',
      role: 'admin',
      displayName: 'Dara',
    });
    const salesUser = await seedUser({
      username: 'rebaz',
      displayName: 'Rebaz',
      permissions: [
        'orders.create',
        'orders.edit',
        'orders.void',
        'orders.change_payment_type',
        'orders.record_payment',
        'orders.credit',
        'customers.create',
        'customers.edit',
        'customers.opening_balance',
        'fields.see_customer_balances',
      ],
    });
    const otherUser = await seedUser({
      username: 'sara',
      displayName: 'Sara',
      permissions: ['orders.create', 'customers.create', 'fields.see_customer_balances'],
    });
    salesUserId = salesUser.id;
    otherSalesUserId = otherUser.id;

    admin = await signIn(ctx.http, adminUser);
    sales = await signIn(ctx.http, salesUser);
    otherSales = await signIn(ctx.http, otherUser);

    await as(ctx.http, admin)
      .post('/api/v1/settings/global-rates')
      .send({ rate_iqd_per_usd: '1310' })
      .expect(201);

    copper = await createMaterial('Copper wire 2 mm', 'per_kg', { sale: 850, bought: 700 });
    steel = await createMaterial('Steel sheet 1.2 mm', 'per_piece', {
      sale: 18_000,
      bought: 15_000,
    });
    await addStock(copper, '6000.000');
    await addStock(steel, '500.000', 500);

    // "Kawa Trading", assigned to Rebaz (the demo script's customer).
    const customer = await as(ctx.http, admin)
      .post('/api/v1/customers')
      .send({ name: 'Kawa Trading', phone: '0770 123 4567', assigned_user_id: salesUserId })
      .expect(201);
    kawa = customer.body.id;

    const system = await withDatabase(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO customers (name, name_normalized, is_system, created_by, updated_by)
         VALUES ('Walk-in customer', 'walk-in customer', true, $1, $1) RETURNING id`,
        [adminUser.id],
      );
      return rows[0]?.id as string;
    });
    walkIn = system;
  });

  async function createMaterial(
    name: string,
    pricingUnit: 'per_kg' | 'per_piece',
    prices: { sale: number; bought: number },
  ): Promise<string> {
    const created = await as(ctx.http, admin)
      .post('/api/v1/items')
      .send({ name, pricing_unit: pricingUnit })
      .expect(201);
    const id = created.body.id as string;
    await as(ctx.http, admin)
      .put(`/api/v1/items/${id}/prices/${new Date().toISOString().slice(0, 7)}`)
      .send({
        sale: { amount: prices.sale, currency: 'IQD' },
        bought: { amount: prices.bought, currency: 'IQD' },
      })
      .expect(200);
    return id;
  }

  async function addStock(itemId: string, kg: string, count?: number): Promise<void> {
    await as(ctx.http, admin)
      .post(`/api/v1/items/${itemId}/opening-stock`)
      .send({
        entry_date: today(),
        qty_kg: kg,
        qty_count: count ?? null,
        note: 'go-live count',
      })
      .expect(201);
  }

  function today(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Baghdad',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  /** Not `async`: the caller chains `.expect(...)` on the supertest request itself. */
  function createOrder(session: Session, body: Record<string, unknown>) {
    return as(ctx.http, session)
      .post('/api/v1/orders')
      .send({ customer_id: kawa, order_date: today(), payment_type: 'borrowed', ...body });
  }

  describe('line totals and document totals (FR-602, FR-603, spec 2.3.4)', () => {
    it('follows the entered-currency rule: 850 IQD/kg × 5,000 kg is $3,244.27, not $3,250', async () => {
      const response = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '5000.000' }],
      }).expect(201);

      const line = response.body.lines[0];
      expect(line.unit_price_iqd).toBe(850);
      // The calculated unit price is stored rounded for display and never multiplied.
      expect(line.unit_price_usd_cents).toBe(65);
      expect(line.line_total_iqd).toBe(4_250_000);
      expect(line.line_total_usd_cents).toBe(324_427);
      expect(response.body.total_iqd).toBe(4_250_000);
      expect(response.body.total_usd_cents).toBe(324_427);
    });

    it('sums each currency on its own, never converting the other total', async () => {
      const response = await createOrder(sales, {
        lines: [
          { item_id: copper, qty_kg: '12.500' },
          { item_id: steel, qty_count: 40, qty_kg: '96.000' },
        ],
      }).expect(201);

      // 850 × 12.5 = 10,625 IQD (≈ 811¢) and 18,000 × 40 = 720,000 IQD (≈ 54,962¢).
      expect(
        response.body.lines.map((line: { line_total_iqd: number }) => line.line_total_iqd),
      ).toEqual([10_625, 720_000]);
      expect(response.body.total_iqd).toBe(730_625);
      expect(response.body.total_usd_cents).toBe(811 + 54_962);
    });

    it('defaults the price from the month list and marks an override', async () => {
      const response = await createOrder(sales, {
        lines: [
          { item_id: copper, qty_kg: '10.000' },
          { item_id: copper, qty_kg: '10.000', unit_price: { amount: 900, currency: 'IQD' } },
        ],
      }).expect(201);

      expect(response.body.lines[0]).toMatchObject({ price_source: 'month', unit_price_iqd: 850 });
      expect(response.body.lines[1]).toMatchObject({
        price_source: 'override',
        unit_price_iqd: 900,
      });
    });

    it('applies a rate typed for this order to the calculated side of every line', async () => {
      const response = await createOrder(sales, {
        rate_iqd_per_usd: '1300',
        lines: [{ item_id: copper, qty_kg: '1000.000' }],
      }).expect(201);

      expect(response.body.rate_source).toBe('manual');
      expect(response.body.rate_iqd_per_usd).toBe('1300.0000');
      // 850,000 IQD ÷ 1,300 = $653.85, not the $648.85 the global rate would give.
      expect(response.body.total_usd_cents).toBe(65_385);
    });

    it("defaults an order to the customer's own rate, not the global one", async () => {
      const rateCo = await as(ctx.http, admin)
        .post('/api/v1/customers')
        .send({ name: 'Rate Co', assigned_user_id: salesUserId })
        .expect(201);
      // Give the customer their own rate (1,300), apart from the global 1,310.
      await as(ctx.http, admin)
        .post(`/api/v1/customers/${rateCo.body.id}/rates`)
        .send({ rate_iqd_per_usd: '1300' })
        .expect(201);

      const detail = await as(ctx.http, admin).get(`/api/v1/customers/${rateCo.body.id}`).expect(200);
      expect(detail.body.rate).toMatchObject({ rate_iqd_per_usd: '1300.0000', is_customer_rate: true });

      // No rate typed on the order — it must fall to the customer's rate, not the global one.
      const order = await createOrder(sales, {
        customer_id: rateCo.body.id,
        lines: [{ item_id: copper, qty_kg: '1000.000' }],
      }).expect(201);
      expect(order.body.rate_iqd_per_usd).toBe('1300.0000');
      expect(order.body.total_usd_cents).toBe(65_385); // at 1,300, not 64,885 at the global 1,310
    });

    it('snapshots the cost per line and leaves it alone when a price is edited later', async () => {
      const order = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '10.000' }],
      }).expect(201);
      const asAdmin = await as(ctx.http, admin).get(`/api/v1/orders/${order.body.id}`).expect(200);
      expect(asAdmin.body.lines[0].cost).toMatchObject({ unit_iqd: 700, source: 'month' });

      await as(ctx.http, admin)
        .put(`/api/v1/items/${copper}/prices/${new Date().toISOString().slice(0, 7)}`)
        .send({ bought: { amount: 999, currency: 'IQD' } })
        .expect(200);

      const again = await as(ctx.http, admin).get(`/api/v1/orders/${order.body.id}`).expect(200);
      expect(again.body.lines[0].cost.unit_iqd).toBe(700);
    });

    it('marks a carried-forward price and refuses a line for a material that has no price', async () => {
      const unpriced = await as(ctx.http, admin)
        .post('/api/v1/items')
        .send({ name: 'Zinc bar', pricing_unit: 'per_kg' })
        .expect(201);

      const refused = await createOrder(sales, {
        lines: [{ item_id: unpriced.body.id, qty_kg: '1.000' }],
      }).expect(422);
      expect(refused.body.error.fields[0].code).toBe('PRICE_REQUIRED');
    });

    it('hides the cost snapshot from an employee without the bought-price flag', async () => {
      const order = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '10.000' }],
      }).expect(201);
      const read = await as(ctx.http, sales).get(`/api/v1/orders/${order.body.id}`).expect(200);
      expect('cost' in read.body.lines[0]).toBe(false);
    });
  });

  describe('a borrowed order and its payments (FR-604, FR-606, FR-607, FR-612)', () => {
    it('raises the balance by exactly the stored totals and follows unpaid → partial → paid', async () => {
      const order = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '100.000' }],
      }).expect(201);
      expect(order.body.status).toBe('unpaid');
      expect(order.body.total_iqd).toBe(85_000);

      const customer = await as(ctx.http, sales).get(`/api/v1/customers/${kawa}`).expect(200);
      expect(customer.body.balance).toMatchObject({
        amount_iqd: 85_000,
        currency: 'IQD',
        kind: 'derived',
      });

      const partial = await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/payments`)
        .send({ amount: 30_000, currency: 'IQD', entry_date: today() })
        .expect(201);
      expect(partial.body[0]).toMatchObject({ balance_before: 85_000, balance_after: 55_000 });
      expect(partial.body[0].order).toMatchObject({ remaining: 55_000, status: 'partially_paid' });
      expect(partial.body[0].voucher_number).toBeGreaterThan(0);

      const rest = await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/payments`)
        .send({ amount: 55_000, currency: 'IQD', entry_date: today() })
        .expect(201);
      expect(rest.body[0].order).toMatchObject({ remaining: 0, status: 'paid' });

      const ledger = await as(ctx.http, sales).get(`/api/v1/customers/${kawa}/ledger`).expect(200);
      expect(ledger.body.balance).toBe(0);
      // Newest first, and the running balance agrees with what History recorded.
      expect(ledger.body.items.map((row: { balance_after: number }) => row.balance_after)).toEqual([
        0, 55_000, 85_000,
      ]);

      const audit = await auditRows({ action: 'ledger_entry' });
      expect(audit.at(-1)?.changes).toMatchObject({
        balance: { before: { amount: 55_000 }, after: { amount: 0 } },
      });
    });

    it('records the excess as credit on the order only when the user confirms it (FR-606)', async () => {
      const order = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '10.000' }],
      }).expect(201);

      const refused = await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/payments`)
        .send({ amount: 20_000, currency: 'IQD', entry_date: today() })
        .expect(422);
      expect(refused.body.error.fields[0].code).toBe('EXCEEDS_REMAINING');

      const confirmed = await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/payments`)
        .send({ amount: 20_000, currency: 'IQD', entry_date: today(), allow_excess: true })
        .expect(201);
      expect(confirmed.body[0].order).toMatchObject({ remaining: -11_500, status: 'paid' });
      expect(confirmed.body[0].balance_after).toBe(-11_500);
    });

    it('settles the rest in dollars with no residue, storing the manual-rate pair (FR-606)', async () => {
      const order = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '100.000' }],
      }).expect(201);
      await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/payments`)
        .send({ amount: 30_000, currency: 'IQD', entry_date: today() })
        .expect(201);

      // 55,000 IQD remain; the customer hands over $42 (55,000 ÷ 1,310 = $41.98).
      const settled = await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/payments`)
        .send({ amount: 4_200, currency: 'USD', entry_date: today(), settle_in_full: true })
        .expect(201);

      expect(settled.body[0]).toMatchObject({
        amount_iqd: -55_000,
        amount_usd_cents: -4_200,
        balance_after: 0,
      });
      expect(settled.body[0].order).toMatchObject({ remaining: 0, status: 'paid' });

      const stored = await withDatabase(async (client) => {
        const { rows } = await client.query<{
          rate_source: string;
          entered_currency: string;
          rate: string;
        }>(
          `SELECT rate_source::text AS rate_source, entered_currency::text AS entered_currency,
                  rate_iqd_per_usd::text AS rate
             FROM customer_ledger WHERE id = $1`,
          [settled.body[0].entry_id],
        );
        return rows[0];
      });
      // The money that arrived was dollars, and the pair says at what rate (FR-604, 2.3.6).
      expect(stored).toMatchObject({ rate_source: 'manual', entered_currency: 'USD' });
      expect(Number(stored?.rate)).toBeCloseTo(1309.52, 1);
    });

    it('closes a shortfall inside the tolerance with an automatic credit (FR-606)', async () => {
      const order = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '100.000' }],
      }).expect(201);

      // 85,000 owed, 84,900 handed over in dinars: 100 IQD is inside the 250 IQD tolerance.
      const settled = await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/payments`)
        .send({ amount: 84_900, currency: 'IQD', entry_date: today(), settle_in_full: true })
        .expect(201);

      expect(settled.body).toHaveLength(2);
      expect(settled.body[0].amount_iqd).toBe(-84_900);
      expect(settled.body[1]).toMatchObject({ entry_type: 'credit', amount_iqd: -100 });
      expect(settled.body[1].order).toMatchObject({ remaining: 0, status: 'paid' });
    });

    it('refuses a settle-in-full whose difference is too large to be a rate', async () => {
      const order = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '100.000' }],
      }).expect(201);
      const refused = await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/payments`)
        .send({ amount: 60_000, currency: 'IQD', entry_date: today(), settle_in_full: true })
        .expect(422);
      expect(refused.body.error.code).toBe('RECEIVED_AMOUNT_OUT_OF_TOLERANCE');
    });

    it('stores a split payment as two rows sharing one note (FR-617)', async () => {
      const order = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '100.000' }],
      }).expect(201);
      const split = await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/payments`)
        .send({
          amount: 0,
          currency: 'IQD',
          entry_date: today(),
          note: 'half and half',
          split: [
            { amount: 50_000, currency: 'IQD' },
            { amount: 2_000, currency: 'USD' },
          ],
        })
        .expect(201);

      expect(split.body).toHaveLength(2);
      expect(split.body[0].amount_iqd).toBe(-50_000);
      expect(split.body[1].amount_usd_cents).toBe(-2_000);
    });

    it('reverses a payment instead of editing it, and refuses a second reversal', async () => {
      const order = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '100.000' }],
      }).expect(201);
      const payment = await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/payments`)
        .send({ amount: 30_000, currency: 'IQD', entry_date: today() })
        .expect(201);

      const reversed = await as(ctx.http, sales)
        .post(`/api/v1/customers/${kawa}/ledger/${payment.body[0].entry_id}/reverse`)
        .send({ note: 'wrong customer' })
        .expect(201);
      expect(reversed.body).toMatchObject({
        entry_type: 'reversal',
        amount_iqd: 30_000,
        balance_after: 85_000,
      });

      const again = await as(ctx.http, sales)
        .post(`/api/v1/customers/${kawa}/ledger/${payment.body[0].entry_id}/reverse`)
        .send({ note: 'again' })
        .expect(409);
      expect(again.body.error.params.reason).toBe('already_reversed');
    });
  });

  describe('cash orders (FR-604, A-24)', () => {
    it('writes the order and its settlement, and is Paid immediately', async () => {
      const order = await as(ctx.http, sales)
        .post('/api/v1/orders')
        .send({
          customer_id: kawa,
          order_date: today(),
          payment_type: 'cash',
          received_currency: 'IQD',
          lines: [{ item_id: copper, qty_kg: '100.000' }],
        })
        .expect(201);

      expect(order.body.status).toBe('paid');
      expect(order.body.received_currency).toBe('IQD');

      const ledger = await as(ctx.http, sales).get(`/api/v1/customers/${kawa}/ledger`).expect(200);
      expect(ledger.body.balance).toBe(0);
      // The pair collapses to one row on screen (2.4.5) and says which currency arrived.
      expect(ledger.body.items).toHaveLength(1);
      expect(ledger.body.items[0]).toMatchObject({ kind: 'cash_order', received_currency: 'IQD' });
      expect(ledger.body.items[0].rows).toHaveLength(2);
    });

    it('records what was handed over in dollars, keeping the order exactly paid', async () => {
      const order = await as(ctx.http, sales)
        .post('/api/v1/orders')
        .send({
          customer_id: kawa,
          order_date: today(),
          payment_type: 'cash',
          received_currency: 'USD',
          received_amount: 6_500,
          lines: [{ item_id: copper, qty_kg: '100.000' }],
        })
        .expect(201);

      expect(order.body.status).toBe('paid');
      expect(order.body.remaining).toBe(0);

      const raw = await as(ctx.http, sales)
        .get(`/api/v1/customers/${kawa}/ledger?raw=true`)
        .expect(200);
      const settlement = raw.body.items.find(
        (row: { entry_type: string }) => row.entry_type === 'cash_settlement',
      );
      expect(settlement).toMatchObject({
        amount_iqd: -85_000,
        amount_usd_cents: -6_500,
        entered_currency: 'USD',
      });
    });

    it('keeps the walk-in customer out of the ledger tab but in the orders list (2.4.5)', async () => {
      const order = await as(ctx.http, sales)
        .post('/api/v1/orders')
        .send({
          customer_id: walkIn,
          order_date: today(),
          payment_type: 'cash',
          received_currency: 'USD',
          lines: [{ item_id: steel, qty_count: 2 }],
        })
        .expect(201);
      expect(order.body.status).toBe('paid');

      await as(ctx.http, sales).get(`/api/v1/customers/${walkIn}/ledger`).expect(404);

      const list = await as(ctx.http, sales).get('/api/v1/orders').expect(200);
      expect(list.body.items.some((row: { id: string }) => row.id === order.body.id)).toBe(true);
    });

    it('refuses a borrowed order for the walk-in customer (FR-501)', async () => {
      const refused = await as(ctx.http, sales)
        .post('/api/v1/orders')
        .send({
          customer_id: walkIn,
          order_date: today(),
          payment_type: 'borrowed',
          lines: [{ item_id: steel, qty_count: 1 }],
        })
        .expect(422);
      expect(refused.body.error.fields[0].code).toBe('SYSTEM_CUSTOMER_CASH_ONLY');
    });
  });

  describe('changing the payment type (FR-605)', () => {
    it('borrowed → cash settles the remainder and records the change', async () => {
      const order = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '100.000' }],
      }).expect(201);
      await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/payments`)
        .send({ amount: 30_000, currency: 'IQD', entry_date: today() })
        .expect(201);

      const changed = await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/payment-type`)
        .send({ to: 'cash', note: 'paid at counter', received_currency: 'IQD' })
        .expect(200);

      expect(changed.body).toMatchObject({ payment_type: 'cash', status: 'paid', remaining: 0 });

      const history = await as(ctx.http, sales)
        .get(`/api/v1/orders/${order.body.id}/history`)
        .expect(200);
      expect(history.body.payment_type_changes[0]).toMatchObject({
        from_type: 'borrowed',
        to_type: 'cash',
        note: 'paid at counter',
        changed_by_name: 'Rebaz',
      });
    });

    it('cash → borrowed reverses the settlement so the order is owed again', async () => {
      const order = await as(ctx.http, sales)
        .post('/api/v1/orders')
        .send({
          customer_id: kawa,
          order_date: today(),
          payment_type: 'cash',
          received_currency: 'IQD',
          lines: [{ item_id: copper, qty_kg: '100.000' }],
        })
        .expect(201);

      const changed = await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/payment-type`)
        .send({ to: 'borrowed', note: 'customer will pay next week' })
        .expect(200);

      expect(changed.body).toMatchObject({
        payment_type: 'borrowed',
        status: 'unpaid',
        remaining: 85_000,
      });

      const raw = await as(ctx.http, sales)
        .get(`/api/v1/customers/${kawa}/ledger?raw=true`)
        .expect(200);
      expect(
        raw.body.items.filter((row: { entry_type: string }) => row.entry_type === 'reversal'),
      ).toHaveLength(1);
    });

    it('requires a note, and refuses a switch to the type it already has', async () => {
      const order = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '10.000' }],
      }).expect(201);
      await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/payment-type`)
        .send({ to: 'cash', received_currency: 'IQD' })
        .expect(422);
      await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/payment-type`)
        .send({ to: 'borrowed', note: 'no change' })
        .expect(422);
    });
  });

  describe('stock (FR-608, FR-303)', () => {
    it('reduces stock by each line and shows the material as last sold today', async () => {
      await createOrder(sales, {
        lines: [
          { item_id: copper, qty_kg: '100.000' },
          { item_id: steel, qty_count: 10 },
        ],
      }).expect(201);

      const material = await as(ctx.http, admin).get(`/api/v1/items/${copper}`).expect(200);
      expect(material.body.stock.stock_kg).toBe('5900.000');
      expect(material.body.last_sold_on).toBe(today());

      const movements = await as(ctx.http, admin)
        .get(`/api/v1/items/${copper}/movements`)
        .expect(200);
      expect(movements.body.items[0]).toMatchObject({
        movement_type: 'sale_out',
        qty_kg: '-100.000',
      });
    });

    it('warns when the line exceeds stock, and refuses it when negative stock is blocked', async () => {
      const warned = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '9000.000' }],
      }).expect(201);
      expect(warned.body.stock_warnings[0]).toMatchObject({
        item_name: 'Copper wire 2 mm',
        available: '6000.000',
        requested: '9000.000',
      });

      await as(ctx.http, admin)
        .patch('/api/v1/settings')
        .send({ allow_negative_stock: false })
        .expect(200);

      const refused = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '9000.000' }],
      }).expect(422);
      expect(refused.body.error.fields[0]).toMatchObject({ code: 'STOCK_INSUFFICIENT' });
    });
  });

  describe('editing and voiding (FR-610, spec 2.5.3)', () => {
    it('writes reversals and new movements on an edit, and logs the diff', async () => {
      const order = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '100.000' }],
      }).expect(201);

      const edited = await as(ctx.http, sales)
        .put(`/api/v1/orders/${order.body.id}`)
        .send({
          customer_id: kawa,
          order_date: today(),
          payment_type: 'borrowed',
          version: order.body.version,
          lines: [{ item_id: copper, qty_kg: '80.000' }],
        })
        .expect(200);

      expect(edited.body.total_iqd).toBe(68_000);
      expect(edited.body.remaining).toBe(68_000);

      const movements = await as(ctx.http, admin)
        .get(`/api/v1/items/${copper}/movements`)
        .expect(200);
      const types = movements.body.items.map((row: { movement_type: string }) => row.movement_type);
      expect(types).toEqual(['sale_out', 'reversal', 'sale_out', 'opening']);

      const material = await as(ctx.http, admin).get(`/api/v1/items/${copper}`).expect(200);
      expect(material.body.stock.stock_kg).toBe('5920.000');

      const ledger = await as(ctx.http, sales).get(`/api/v1/customers/${kawa}/ledger`).expect(200);
      expect(ledger.body.balance).toBe(68_000);
      // The three rows read as one "edited" line carrying the new amount (2.4.5).
      expect(ledger.body.items).toHaveLength(1);
      expect(ledger.body.items[0]).toMatchObject({ kind: 'edited', amount_iqd: 68_000 });

      const audit = await auditRows({ action: 'update', entityId: order.body.id });
      expect(audit[0]?.changes).toMatchObject({
        total: { old: { iqd: 85_000 }, new: { iqd: 68_000 } },
      });
    });

    it('keeps the cost snapshot of a line whose material and month did not change', async () => {
      const order = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '100.000' }],
      }).expect(201);
      await as(ctx.http, admin)
        .put(`/api/v1/items/${copper}/prices/${new Date().toISOString().slice(0, 7)}`)
        .send({ bought: { amount: 999, currency: 'IQD' } })
        .expect(200);

      await as(ctx.http, sales)
        .put(`/api/v1/orders/${order.body.id}`)
        .send({
          customer_id: kawa,
          order_date: today(),
          payment_type: 'borrowed',
          version: order.body.version,
          lines: [{ item_id: copper, qty_kg: '80.000' }],
        })
        .expect(200);

      const edited = await as(ctx.http, admin).get(`/api/v1/orders/${order.body.id}`).expect(200);
      expect(edited.body.lines[0].cost.unit_iqd).toBe(700);
    });

    it('allows an edit even once a payment is linked (edit window removed)', async () => {
      const order = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '100.000' }],
      }).expect(201);
      await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/payments`)
        .send({ amount: 10_000, currency: 'IQD', entry_date: today() })
        .expect(201);

      const edited = await as(ctx.http, sales)
        .put(`/api/v1/orders/${order.body.id}`)
        .send({
          customer_id: kawa,
          order_date: today(),
          payment_type: 'borrowed',
          version: order.body.version,
          lines: [{ item_id: copper, qty_kg: '80.000' }],
        })
        .expect(200);
      expect(edited.body.version).toBeGreaterThan(order.body.version);
    });

    it('voids with a reason: stock restored, the order off the balance, the payment left as credit', async () => {
      const order = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '100.000' }],
      }).expect(201);
      await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/payments`)
        .send({ amount: 30_000, currency: 'IQD', entry_date: today() })
        .expect(201);

      const voided = await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/void`)
        .send({ reason: 'customer cancelled' })
        .expect(200);

      expect(voided.body).toMatchObject({
        doc_status: 'void',
        status: 'void',
        void_reason: 'customer cancelled',
      });

      const material = await as(ctx.http, admin).get(`/api/v1/items/${copper}`).expect(200);
      expect(material.body.stock.stock_kg).toBe('6000.000');

      // The 30,000 that did arrive stays on the account as credit (FR-610).
      const customer = await as(ctx.http, sales).get(`/api/v1/customers/${kawa}`).expect(200);
      expect(customer.body.balance.amount_iqd).toBe(-30_000);

      const refund = await as(ctx.http, sales)
        .post(`/api/v1/customers/${kawa}/refunds`)
        .send({ amount: 30_000, currency: 'IQD', entry_date: today(), note: 'cash returned' })
        .expect(201);
      expect(refund.body.balance_after).toBe(0);
    });

    it('cannot void twice, and cannot edit a voided order', async () => {
      const order = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '10.000' }],
      }).expect(201);
      await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/void`)
        .send({ reason: 'mistake' })
        .expect(200);

      await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/void`)
        .send({ reason: 'again' })
        .expect(409);

      const edit = await as(ctx.http, sales)
        .put(`/api/v1/orders/${order.body.id}`)
        .send({
          customer_id: kawa,
          order_date: today(),
          payment_type: 'borrowed',
          version: order.body.version,
          lines: [{ item_id: copper, qty_kg: '5.000' }],
        })
        .expect(409);
      expect(edit.body.error.code).toBe('DOCUMENT_VOID');
    });

    it('lets the creator undo within eight seconds, and hides the undone order from the list', async () => {
      const order = await createOrder(otherSales, {
        customer_id: walkIn,
        payment_type: 'cash',
        received_currency: 'IQD',
        lines: [{ item_id: steel, qty_count: 1 }],
      }).expect(201);

      // Sara holds no `orders.void` key at all; the undo is the toast action (FR-610).
      const undone = await as(ctx.http, otherSales)
        .post(`/api/v1/orders/${order.body.id}/undo`)
        .send({})
        .expect(200);
      expect(undone.body).toMatchObject({ doc_status: 'void', void_reason: 'undo' });

      const list = await as(ctx.http, otherSales).get('/api/v1/orders').expect(200);
      expect(list.body.items.some((row: { id: string }) => row.id === order.body.id)).toBe(false);

      const withUndone = await as(ctx.http, otherSales)
        .get('/api/v1/orders?include_undone=true')
        .expect(200);
      expect(withUndone.body.items.some((row: { id: string }) => row.id === order.body.id)).toBe(
        true,
      );
    });
  });

  describe('scope and assignment (FR-501, FR-502, spec 2.6.4)', () => {
    it("hides another employee's customer and their orders, with 404 rather than 403", async () => {
      const order = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '10.000' }],
      }).expect(201);

      await as(ctx.http, otherSales).get(`/api/v1/customers/${kawa}`).expect(404);
      await as(ctx.http, otherSales).get(`/api/v1/orders/${order.body.id}`).expect(404);

      const list = await as(ctx.http, otherSales).get('/api/v1/customers').expect(200);
      expect(list.body.items.map((row: { name: string }) => row.name)).toEqual([
        'Walk-in customer',
      ]);
    });

    it('names the assignee when a duplicate belongs to someone else (FR-501)', async () => {
      const duplicates = await as(ctx.http, otherSales)
        .get('/api/v1/customers/duplicates?name=Kawa%20Trading')
        .expect(200);
      expect(duplicates.body.duplicates[0]).toMatchObject({
        name: 'Kawa Trading',
        assigned_user_name: 'Rebaz',
      });
    });

    it('assigns a customer created by a scoped employee to that employee (FR-501)', async () => {
      const created = await as(ctx.http, otherSales)
        .post('/api/v1/customers')
        .send({ name: 'Zana Metals' })
        .expect(201);
      expect(created.body.assigned_user_id).toBe(otherSalesUserId);

      const mine = await as(ctx.http, otherSales).get('/api/v1/customers').expect(200);
      expect(mine.body.items.map((row: { name: string }) => row.name)).toContain('Zana Metals');
    });

    it('opens the customer up once an admin grants "sees all customers"', async () => {
      await as(ctx.http, admin)
        .post(`/api/v1/users/${otherSalesUserId}/permissions`)
        .send({
          keys: [
            'orders.create',
            'customers.create',
            'customers.view_all',
            'fields.see_customer_balances',
          ],
        })
        .expect(201);

      const list = await as(ctx.http, otherSales).get('/api/v1/customers').expect(200);
      expect(list.body.items.map((row: { name: string }) => row.name)).toContain('Kawa Trading');
    });

    it('keeps an order visible to the employee who entered it after a reassignment', async () => {
      const order = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '10.000' }],
      }).expect(201);
      await as(ctx.http, admin)
        .put(`/api/v1/customers/${kawa}/assignment`)
        .send({ user_id: otherSalesUserId, note: 'handover' })
        .expect(200);

      const stillVisible = await as(ctx.http, sales)
        .get(`/api/v1/orders/${order.body.id}`)
        .expect(200);
      expect(stillVisible.body.id).toBe(order.body.id);
    });
  });

  describe('the customer ledger and its invariants (FR-503, FR-504)', () => {
    it('records an opening balance with its note and shows it in the ledger', async () => {
      const opening = await as(ctx.http, sales)
        .post(`/api/v1/customers/${kawa}/opening-balance`)
        .send({ amount: 450_000, currency: 'IQD', entry_date: today(), note: 'owed at go-live' })
        .expect(201);
      expect(opening.body).toMatchObject({ balance_before: 0, balance_after: 450_000 });

      const ledger = await as(ctx.http, sales).get(`/api/v1/customers/${kawa}/ledger`).expect(200);
      expect(ledger.body.items[0]).toMatchObject({
        entry_type: 'opening',
        note: 'owed at go-live',
      });
    });

    it('keeps the balance equal to the sum of the ledger through a day of work', async () => {
      await as(ctx.http, sales)
        .post(`/api/v1/customers/${kawa}/opening-balance`)
        .send({ amount: 450_000, currency: 'IQD', entry_date: today(), note: 'go-live' })
        .expect(201);
      const order = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '100.000' }],
      }).expect(201);
      await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/payments`)
        .send({ amount: 30_000, currency: 'IQD', entry_date: today() })
        .expect(201);
      await as(ctx.http, sales)
        .post(`/api/v1/customers/${kawa}/credits`)
        .send({
          amount: 5_000,
          currency: 'IQD',
          entry_date: today(),
          note: 'damaged goods returned',
        })
        .expect(201);

      const [ledger, customer, sum] = await Promise.all([
        as(ctx.http, sales).get(`/api/v1/customers/${kawa}/ledger`).expect(200),
        as(ctx.http, sales).get(`/api/v1/customers/${kawa}`).expect(200),
        withDatabase(async (client) => {
          const { rows } = await client.query<{ total: string }>(
            'SELECT coalesce(sum(amount_iqd), 0)::text AS total FROM customer_ledger WHERE customer_id = $1',
            [kawa],
          );
          return Number(rows[0]?.total);
        }),
      ]);

      expect(ledger.body.balance).toBe(500_000);
      expect(customer.body.balance.amount_iqd).toBe(500_000);
      expect(sum).toBe(500_000);
    });

    it('hides balances from an employee without the field flag (FR-503)', async () => {
      const plain = await seedUser({
        username: 'plain',
        displayName: 'Plain',
        permissions: ['customers.view', 'customers.view_all', 'orders.view'],
      });
      const session = await signIn(ctx.http, plain);

      const customer = await as(ctx.http, session).get(`/api/v1/customers/${kawa}`).expect(200);
      expect('balance' in customer.body).toBe(false);

      const list = await as(ctx.http, session).get('/api/v1/customers').expect(200);
      expect('balance' in list.body.items[0]).toBe(false);
    });

    it('re-bases the balance when the settlement currency changes (spec 2.3.5)', async () => {
      await as(ctx.http, sales)
        .post(`/api/v1/customers/${kawa}/opening-balance`)
        .send({ amount: 1_310_000, currency: 'IQD', entry_date: today(), note: 'go-live' })
        .expect(201);

      const refused = await as(ctx.http, admin)
        .put(`/api/v1/customers/${kawa}/settlement-currency`)
        .send({ currency: 'USD', note: 'customer settles in dollars now' })
        .expect(422);
      expect(refused.body.error.code).toBe('REBASE_RATE_REQUIRED');

      const rebased = await as(ctx.http, admin)
        .put(`/api/v1/customers/${kawa}/settlement-currency`)
        .send({ currency: 'USD', note: 'agreed at 1,310', rebase_rate: '1310' })
        .expect(200);

      expect(rebased.body.settlement_currency).toBe('USD');
      // 1,310,000 IQD is $1,000 at the agreed rate; the USD column already summed $1,000.00,
      // so the marker row's delta is zero and the balance is $1,000 exactly.
      expect(rebased.body.balance.amount_usd_cents).toBe(100_000);

      const ledger = await as(ctx.http, admin).get(`/api/v1/customers/${kawa}/ledger`).expect(200);
      expect(ledger.body.items[0]).toMatchObject({
        kind: 'rebase',
        entry_type: 'settlement_change',
      });

      // A re-basing row is corrected by another change, never reversed (2.3.5).
      await as(ctx.http, admin)
        .post(`/api/v1/customers/${kawa}/ledger/${ledger.body.items[0].entry_id}/reverse`)
        .send({ note: 'undo the rebase' })
        .expect(422);
    });

    it('warns when a borrowed order pushes the balance past the credit limit (FR-616)', async () => {
      const limited = await as(ctx.http, admin)
        .post('/api/v1/customers')
        .send({
          name: 'Small Shop',
          assigned_user_id: salesUserId,
          credit_limit: { amount: 50_000, currency: 'IQD' },
        })
        .expect(201);

      const order = await as(ctx.http, sales)
        .post('/api/v1/orders')
        .send({
          customer_id: limited.body.id,
          order_date: today(),
          payment_type: 'borrowed',
          lines: [{ item_id: copper, qty_kg: '100.000' }],
        })
        .expect(201);

      // A warning on the response, never a refusal.
      expect(order.body.credit_limit_warning).toMatchObject({
        limit: 50_000,
        balance_after: 85_000,
      });
    });
  });

  describe('the receipt, the voucher and the statement (FR-613 to FR-615)', () => {
    it('returns the figures of a receipt with the balance after the order', async () => {
      const order = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '100.000' }],
      }).expect(201);
      const receipt = await as(ctx.http, sales)
        .get(`/api/v1/orders/${order.body.id}/receipt`)
        .expect(200);

      expect(receipt.body.order.total_iqd).toBe(85_000);
      expect(receipt.body.customer).toMatchObject({ name: 'Kawa Trading', phone: '0770 123 4567' });
      expect(receipt.body.balance_after).toBe(85_000);
    });

    it('returns a voucher for a payment, and marks a reversed one cancelled', async () => {
      const order = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '100.000' }],
      }).expect(201);
      const payment = await as(ctx.http, sales)
        .post(`/api/v1/orders/${order.body.id}/payments`)
        .send({ amount: 30_000, currency: 'IQD', entry_date: today(), note: 'cash at the gate' })
        .expect(201);

      const voucher = await as(ctx.http, sales)
        .get(`/api/v1/customers/${kawa}/ledger/${payment.body[0].entry_id}/voucher`)
        .expect(200);
      expect(voucher.body).toMatchObject({
        entry_type: 'payment',
        amount_iqd: -30_000,
        note: 'cash at the gate',
        performed_by_name: 'Rebaz',
        is_cancelled: false,
      });
      expect(voucher.body.voucher_number).toBeGreaterThan(0);

      await as(ctx.http, sales)
        .post(`/api/v1/customers/${kawa}/ledger/${payment.body[0].entry_id}/reverse`)
        .send({ note: 'mistake' })
        .expect(201);

      const cancelled = await as(ctx.http, sales)
        .get(`/api/v1/customers/${kawa}/ledger/${payment.body[0].entry_id}/voucher`)
        .expect(200);
      expect(cancelled.body.is_cancelled).toBe(true);
    });

    it('returns a statement whose closing balance matches the ledger', async () => {
      await as(ctx.http, sales)
        .post(`/api/v1/customers/${kawa}/opening-balance`)
        .send({ amount: 450_000, currency: 'IQD', entry_date: today(), note: 'go-live' })
        .expect(201);
      await createOrder(sales, { lines: [{ item_id: copper, qty_kg: '100.000' }] }).expect(201);

      const statement = await as(ctx.http, sales)
        .get(`/api/v1/customers/${kawa}/statement?from=${today()}&to=${today()}`)
        .expect(200);

      expect(statement.body.opening_balance).toBe(0);
      expect(statement.body.closing_balance).toBe(535_000);
      expect(statement.body.items).toHaveLength(2);
    });
  });

  describe('the orders list (FR-611)', () => {
    it('filters by status, payment type, customer, employee and free text', async () => {
      const borrowed = await createOrder(sales, {
        lines: [{ item_id: copper, qty_kg: '10.000' }],
        notes: 'urgent',
      }).expect(201);
      await as(ctx.http, sales)
        .post('/api/v1/orders')
        .send({
          customer_id: walkIn,
          order_date: today(),
          payment_type: 'cash',
          received_currency: 'IQD',
          lines: [{ item_id: steel, qty_count: 1 }],
        })
        .expect(201);

      const unpaid = await as(ctx.http, sales).get('/api/v1/orders?status=unpaid').expect(200);
      expect(unpaid.body.items.map((row: { id: string }) => row.id)).toEqual([borrowed.body.id]);

      const cash = await as(ctx.http, sales).get('/api/v1/orders?payment_type=cash').expect(200);
      expect(cash.body.items).toHaveLength(1);

      const byCustomer = await as(ctx.http, sales)
        .get(`/api/v1/customers/${kawa}/orders`)
        .expect(200);
      expect(byCustomer.body.items).toHaveLength(1);

      const byNote = await as(ctx.http, sales).get('/api/v1/orders?q=urgent').expect(200);
      expect(byNote.body.items).toHaveLength(1);

      const byNumber = await as(ctx.http, sales)
        .get(`/api/v1/orders?q=${borrowed.body.number}`)
        .expect(200);
      expect(byNumber.body.items).toHaveLength(1);

      const byEmployee = await as(ctx.http, sales)
        .get(`/api/v1/orders?done_by=${salesUserId}`)
        .expect(200);
      expect(byEmployee.body.items).toHaveLength(2);
    });
  });

  describe('idempotency on a bad connection (FR-1305)', () => {
    it('does not write the same order twice when the request is retried', async () => {
      const key = '11111111-2222-4333-8444-555555555555';
      const body = {
        customer_id: kawa,
        order_date: today(),
        payment_type: 'borrowed',
        lines: [{ item_id: copper, qty_kg: '10.000' }],
      };

      const first = await as(ctx.http, sales)
        .post('/api/v1/orders')
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      const retry = await as(ctx.http, sales)
        .post('/api/v1/orders')
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);

      expect(retry.body.id).toBe(first.body.id);

      const list = await as(ctx.http, sales).get('/api/v1/orders').expect(200);
      expect(list.body.items).toHaveLength(1);
    });
  });
});

/**
 * Regressions for the defects found in the Iteration 1 review. Each one fails against the
 * code as it was written before the review.
 */
describe('iteration 1 review regressions', () => {
  let ctx: TestApp;
  let admin: Session;
  let sales: Session;
  let salesUserId: string;
  let otherSalesUserId: string;
  let otherSales: Session;
  let copper: string;
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
    const adminUser = await seedUser({
      username: 'admin.review',
      role: 'admin',
      displayName: 'Dara',
    });
    const salesUser = await seedUser({
      username: 'rebaz.review',
      displayName: 'Rebaz',
      permissions: [
        'orders.create',
        'orders.edit',
        'orders.void',
        'orders.record_payment',
        'orders.credit',
        'customers.create',
        'fields.see_customer_balances',
      ],
    });
    const other = await seedUser({
      username: 'sara.review',
      displayName: 'Sara',
      permissions: ['orders.view', 'customers.view', 'fields.see_customer_balances'],
    });
    salesUserId = salesUser.id;
    otherSalesUserId = other.id;

    admin = await signIn(ctx.http, adminUser);
    sales = await signIn(ctx.http, salesUser);
    otherSales = await signIn(ctx.http, other);

    await as(ctx.http, admin)
      .post('/api/v1/settings/global-rates')
      .send({ rate_iqd_per_usd: '1310' })
      .expect(201);

    const item = await as(ctx.http, admin)
      .post('/api/v1/items')
      .send({ name: 'Copper wire 2 mm', pricing_unit: 'per_kg' })
      .expect(201);
    copper = item.body.id;
    await as(ctx.http, admin)
      .put(`/api/v1/items/${copper}/prices/${today().slice(0, 7)}`)
      .send({ sale: { amount: 850, currency: 'IQD' }, bought: { amount: 700, currency: 'IQD' } })
      .expect(200);
    await as(ctx.http, admin)
      .post(`/api/v1/items/${copper}/opening-stock`)
      .send({ entry_date: today(), qty_kg: '1000.000', note: 'go-live' })
      .expect(201);

    const customer = await as(ctx.http, admin)
      .post('/api/v1/customers')
      .send({ name: 'Kawa Trading', assigned_user_id: salesUserId })
      .expect(201);
    kawa = customer.body.id;
  });

  function cashOrder(body: Record<string, unknown>) {
    return as(ctx.http, sales)
      .post('/api/v1/orders')
      .send({
        customer_id: kawa,
        order_date: today(),
        payment_type: 'cash',
        lines: [{ item_id: copper, qty_kg: '100.000' }],
        ...body,
      });
  }

  it('never records dinars handed over as cents on a cash settlement', async () => {
    // 85,000 د.ع is owed and 84,900 د.ع is handed over: in the *same* currency that is a
    // discount or a part payment, not a rate difference. Before the fix the 84,900 was
    // written into the dollar column as 84,900 cents — a $849 settlement.
    const refused = await cashOrder({ received_currency: 'IQD', received_amount: 84_900 }).expect(
      422,
    );
    expect(refused.body.error.code).toBe('RECEIVED_AMOUNT_OUT_OF_TOLERANCE');
    expect(refused.body.error.params.reason).toBe('same_currency');

    const exact = await cashOrder({ received_currency: 'IQD' }).expect(201);
    const raw = await as(ctx.http, sales)
      .get(`/api/v1/customers/${kawa}/ledger?raw=true`)
      .expect(200);
    const settlement = raw.body.items.find(
      (row: { entry_type: string }) => row.entry_type === 'cash_settlement',
    );
    // The settlement is the exact negation of the order entry, in both columns.
    expect(settlement).toMatchObject({
      amount_iqd: -85_000,
      amount_usd_cents: -exact.body.total_usd_cents,
      entered_currency: 'IQD',
    });
    expect(exact.body.remaining).toBe(0);
  });

  it('reverses a payment that belongs to an order voided afterwards', async () => {
    const order = await as(ctx.http, sales)
      .post('/api/v1/orders')
      .send({
        customer_id: kawa,
        order_date: today(),
        payment_type: 'borrowed',
        lines: [{ item_id: copper, qty_kg: '100.000' }],
      })
      .expect(201);
    const payment = await as(ctx.http, sales)
      .post(`/api/v1/orders/${order.body.id}/payments`)
      .send({ amount: 30_000, currency: 'IQD', entry_date: today() })
      .expect(201);
    await as(ctx.http, sales)
      .post(`/api/v1/orders/${order.body.id}/void`)
      .send({ reason: 'cancelled' })
      .expect(200);

    // Before the fix this answered 409 DOCUMENT_VOID: the status lookup refused the very
    // order whose payment was being handed back.
    const reversed = await as(ctx.http, admin)
      .post(`/api/v1/customers/${kawa}/ledger/${payment.body[0].entry_id}/reverse`)
      .send({ note: 'money returned in cash' })
      .expect(201);
    expect(reversed.body).toMatchObject({ entry_type: 'reversal', amount_iqd: 30_000 });
    expect(reversed.body.order.status).toBe('void');

    const customer = await as(ctx.http, sales).get(`/api/v1/customers/${kawa}`).expect(200);
    expect(customer.body.balance.amount_iqd).toBe(0);
  });

  it('lets the employee who entered an order pay it off after the customer is reassigned', async () => {
    const order = await as(ctx.http, sales)
      .post('/api/v1/orders')
      .send({
        customer_id: kawa,
        order_date: today(),
        payment_type: 'borrowed',
        lines: [{ item_id: copper, qty_kg: '100.000' }],
      })
      .expect(201);

    await as(ctx.http, admin)
      .put(`/api/v1/customers/${kawa}/assignment`)
      .send({ user_id: otherSalesUserId, note: 'handover' })
      .expect(200);

    // The customer is out of Rebaz's scope now, but the order he entered is not (2.6.4).
    await as(ctx.http, sales).get(`/api/v1/customers/${kawa}`).expect(404);
    const payment = await as(ctx.http, sales)
      .post(`/api/v1/orders/${order.body.id}/payments`)
      .send({ amount: 30_000, currency: 'IQD', entry_date: today() })
      .expect(201);
    expect(payment.body[0].order.status).toBe('partially_paid');

    // A payment not tied to an order still obeys the customer scope.
    await as(ctx.http, sales)
      .post(`/api/v1/customers/${kawa}/payments`)
      .send({ amount: 1_000, currency: 'IQD', entry_date: today() })
      .expect(404);
    expect(otherSales).toBeDefined();
  });

  it('refuses an edit that would move the order to another customer', async () => {
    const other = await as(ctx.http, admin)
      .post('/api/v1/customers')
      .send({ name: 'Zana Metals', assigned_user_id: salesUserId })
      .expect(201);
    const order = await as(ctx.http, sales)
      .post('/api/v1/orders')
      .send({
        customer_id: kawa,
        order_date: today(),
        payment_type: 'borrowed',
        lines: [{ item_id: copper, qty_kg: '100.000' }],
      })
      .expect(201);

    // Before the fix the new customer was silently ignored, which reads as a successful edit.
    const refused = await as(ctx.http, sales)
      .put(`/api/v1/orders/${order.body.id}`)
      .send({
        customer_id: other.body.id,
        order_date: today(),
        payment_type: 'borrowed',
        version: order.body.version,
        lines: [{ item_id: copper, qty_kg: '100.000' }],
      })
      .expect(422);
    expect(refused.body.error.fields[0].code).toBe('IMMUTABLE');
  });

  it('marks a line whose price was carried forward from an earlier month (FR-306)', async () => {
    const zinc = await as(ctx.http, admin)
      .post('/api/v1/items')
      .send({ name: 'Zinc bar', pricing_unit: 'per_kg' })
      .expect(201);
    // Priced in January only, so an order today carries that price forward quietly.
    await as(ctx.http, admin)
      .put(`/api/v1/items/${zinc.body.id}/prices/${today().slice(0, 4)}-01`)
      .send({ sale: { amount: 1_000, currency: 'IQD' } })
      .expect(200);

    const order = await as(ctx.http, sales)
      .post('/api/v1/orders')
      .send({
        customer_id: kawa,
        order_date: today(),
        payment_type: 'borrowed',
        lines: [{ item_id: zinc.body.id, qty_kg: '1.000' }],
      })
      .expect(201);

    // Before the fix this was always null, so the saved order never showed "from January".
    expect(order.body.lines[0].price_from_month).toBe(`${today().slice(0, 4)}-01-01`);

    const thisMonth = await as(ctx.http, admin)
      .put(`/api/v1/items/${zinc.body.id}/prices/${today().slice(0, 7)}`)
      .send({ sale: { amount: 1_200, currency: 'IQD' } })
      .expect(200);
    expect(thisMonth.body.sale.amount_iqd).toBe(1_200);

    const withOwnPrice = await as(ctx.http, sales)
      .post('/api/v1/orders')
      .send({
        customer_id: kawa,
        order_date: today(),
        payment_type: 'borrowed',
        lines: [{ item_id: zinc.body.id, qty_kg: '1.000' }],
      })
      .expect(201);
    expect(withOwnPrice.body.lines[0].price_from_month).toBeNull();
  });
});

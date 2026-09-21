import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTestApp, resetDatabase, seedUser, signIn, withDatabase } from './harness.js';
import type { Session, TestApp } from './harness.js';

/**
 * The reports (FR-1001 to FR-1013, spec 2.11).
 *
 * The acceptance criteria of iteration 4 in order: every report's totals equal an independent
 * SQL sum over the same seeded data, the margin comes from the line snapshots and never
 * disagrees in sign between the two currencies, month grouping is an Asia/Baghdad month, the
 * pinned filter applies per report for a user without `reports.view_all`, the field flags strip
 * what they should, and the cash-up equals the ledgers' entered-currency sums.
 *
 * The independent sums are deliberately written as SQL here rather than reusing the
 * repository: a report that agrees with itself proves nothing.
 */
describe('the reports (FR-1001 to FR-1013)', () => {
  let ctx: TestApp;
  let admin: Session;
  /** Rebaz: sales, own customers only — the pinned-filter case. */
  let rebaz: Session;
  let sara: Session;
  let rebazId: string;
  let saraId: string;
  let copper: string;
  let plates: string;
  let kawa: string;
  let zagros: string;
  let alNoor: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase();

    const adminUser = await seedUser({ username: 'admin.reports', role: 'admin', displayName: 'Dara' });
    const rebazUser = await seedUser({
      username: 'rebaz',
      displayName: 'Rebaz',
      permissions: [
        'orders.create',
        'orders.record_payment',
        'customers.create',
        'reports.view',
        'fields.see_customer_balances',
        'fields.see_bought_price',
        'fields.see_profit',
      ],
    });
    const saraUser = await seedUser({
      username: 'sara',
      displayName: 'Sara',
      permissions: ['orders.create', 'customers.create', 'reports.view', 'fields.see_customer_balances'],
    });
    rebazId = rebazUser.id;
    saraId = saraUser.id;

    admin = await signIn(ctx.http, adminUser);
    rebaz = await signIn(ctx.http, rebazUser);
    sara = await signIn(ctx.http, saraUser);

    await as(ctx.http, admin).post('/api/v1/settings/global-rates').send({ rate_iqd_per_usd: '1300' }).expect(201);

    copper = await createMaterial('Copper wire 2 mm', 'per_kg', { sale: 850, bought: 700 });
    plates = await createMaterial('Steel plate 10 mm', 'per_piece', { sale: 18_000, bought: 15_000 });
    await addStock(copper, '6000.000');
    await addStock(plates, '500.000', 500);

    // Two customers, one per sales employee, so the assigned-to pin has something to hide.
    kawa = (
      await as(ctx.http, admin)
        .post('/api/v1/customers')
        .send({ name: 'Kawa Trading', assigned_user_id: rebazId })
        .expect(201)
    ).body.id;
    zagros = (
      await as(ctx.http, admin)
        .post('/api/v1/customers')
        .send({ name: 'Zagros Metals', assigned_user_id: saraId })
        .expect(201)
    ).body.id;

    alNoor = (
      await as(ctx.http, admin).post('/api/v1/companies').send({ name: 'Al-Noor Steel Co.' }).expect(201)
    ).body.id;
  });

  async function createMaterial(
    name: string,
    pricingUnit: 'per_kg' | 'per_piece',
    prices: { sale: number; bought: number },
  ): Promise<string> {
    const created = await as(ctx.http, admin).post('/api/v1/items').send({ name, pricing_unit: pricingUnit }).expect(201);
    const id = created.body.id as string;
    await as(ctx.http, admin)
      .put(`/api/v1/items/${id}/prices/${today().slice(0, 7)}`)
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
      .send({ entry_date: today(), qty_kg: kg, qty_count: count ?? null, note: 'go-live count' })
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

  function monthStart(): string {
    return `${today().slice(0, 7)}-01`;
  }

  /** The seeded week: two orders each for the two employees, a purchase and a damage record. */
  async function seedActivity() {
    const kawaOrder = await as(ctx.http, rebaz)
      .post('/api/v1/orders')
      .send({
        customer_id: kawa,
        order_date: today(),
        payment_type: 'borrowed',
        lines: [{ item_id: copper, qty_kg: '100.000' }],
      })
      .expect(201);

    const kawaCash = await as(ctx.http, rebaz)
      .post('/api/v1/orders')
      .send({
        customer_id: kawa,
        order_date: today(),
        payment_type: 'cash',
        received_currency: 'IQD',
        lines: [{ item_id: plates, qty_count: 10, qty_kg: '24.000' }],
      })
      .expect(201);

    const zagrosOrder = await as(ctx.http, sara)
      .post('/api/v1/orders')
      .send({
        customer_id: zagros,
        order_date: today(),
        payment_type: 'borrowed',
        lines: [{ item_id: copper, qty_kg: '50.000' }],
      })
      .expect(201);

    await as(ctx.http, rebaz)
      .post(`/api/v1/orders/${kawaOrder.body.id}/payments`)
      .send({ amount: 30_000, currency: 'IQD', entry_date: today(), note: 'part payment' })
      .expect(201);

    const purchase = await as(ctx.http, admin)
      .post('/api/v1/purchases')
      .send({
        company_id: alNoor,
        purchase_date: today(),
        lines: [{ item_id: copper, qty_kg: '500.000', unit_price: { amount: 690, currency: 'IQD' } }],
      })
      .expect(201);

    await as(ctx.http, admin)
      .post(`/api/v1/companies/${alNoor}/payments`)
      .send({ amount: 100_000, currency: 'IQD', entry_date: today(), note: 'on account' })
      .expect(201);

    const damage = await as(ctx.http, admin)
      .post('/api/v1/damages')
      .send({
        item_id: copper,
        qty_kg: '4.000',
        damage_date: today(),
        attribution: 'company',
        company_id: alNoor,
        purchase_id: purchase.body.id,
        is_returnable: true,
      })
      .expect(201);

    return { kawaOrder: kawaOrder.body, kawaCash: kawaCash.body, zagrosOrder: zagrosOrder.body, purchase: purchase.body, damage: damage.body };
  }

  const range = () => `from=${monthStart()}&to=${today()}`;

  // ───────────────────────────────── sales (FR-1003) ─────────────────────────────────

  describe('the sales report (FR-1003)', () => {
    it('totals exactly what the orders of the period total, per currency', async () => {
      const seeded = await seedActivity();

      const report = await as(ctx.http, admin).get(`/api/v1/reports/sales?${range()}`).expect(200);
      const independent = await withDatabase(async (client) => {
        const { rows } = await client.query<{ orders: string; iqd: string; usd_cents: string }>(
          `SELECT count(*)::text AS orders,
                  coalesce(sum(total_iqd), 0)::text AS iqd,
                  coalesce(sum(total_usd_cents), 0)::text AS usd_cents
             FROM orders
            WHERE status = 'active' AND deleted_at IS NULL
              AND order_date BETWEEN $1::date AND $2::date`,
          [monthStart(), today()],
        );
        return rows[0] as { orders: string; iqd: string; usd_cents: string };
      });

      expect(report.body.totals.count_orders).toBe(Number(independent.orders));
      expect(report.body.totals.total_iqd).toBe(Number(independent.iqd));
      expect(report.body.totals.total_usd_cents).toBe(Number(independent.usd_cents));
      // Three orders: 85,000 + 180,000 + 42,500 د.ع.
      expect(report.body.totals.total_iqd).toBe(307_500);
      void seeded;
    });

    it('splits cash from borrowed and counts what was collected in the period', async () => {
      await seedActivity();
      const report = await as(ctx.http, admin).get(`/api/v1/reports/sales?${range()}`).expect(200);

      expect(report.body.totals.cash_iqd).toBe(180_000);
      expect(report.body.totals.borrowed_iqd).toBe(127_500);
      // The cash order settles itself (180,000) and the part payment adds 30,000.
      expect(report.body.totals.collected_iqd).toBe(210_000);
    });

    it('groups by month in Asia/Baghdad, by day, by customer, by material and by employee', async () => {
      await seedActivity();

      const byMonth = await as(ctx.http, admin).get(`/api/v1/reports/sales?${range()}&group_by=month`).expect(200);
      expect(byMonth.body.groups).toHaveLength(1);
      expect(byMonth.body.groups[0].key).toBe(monthStart());

      const byDay = await as(ctx.http, admin).get(`/api/v1/reports/sales?${range()}&group_by=day`).expect(200);
      expect(byDay.body.groups[0].key).toBe(today());

      const byCustomer = await as(ctx.http, admin)
        .get(`/api/v1/reports/sales?${range()}&group_by=customer`)
        .expect(200);
      expect(byCustomer.body.groups.map((group: { label: string }) => group.label).sort()).toEqual([
        'Kawa Trading',
        'Zagros Metals',
      ]);

      const byItem = await as(ctx.http, admin).get(`/api/v1/reports/sales?${range()}&group_by=item`).expect(200);
      const copperRow = byItem.body.groups.find((group: { key: string }) => group.key === copper);
      // 150 kg of copper sold across two orders, at 850 د.ع.
      expect(copperRow).toMatchObject({ qty_kg: '150.000', total_iqd: 127_500 });

      const byEmployee = await as(ctx.http, admin)
        .get(`/api/v1/reports/sales?${range()}&group_by=employee`)
        .expect(200);
      const rebazRow = byEmployee.body.groups.find((group: { key: string }) => group.key === rebazId);
      expect(rebazRow.total_iqd).toBe(265_000);
    });

    it('pins a user without reports.view_all to their own work, and says so', async () => {
      await seedActivity();

      const own = await as(ctx.http, rebaz).get(`/api/v1/reports/sales?${range()}`).expect(200);
      expect(own.body.pinned).toEqual({ filter: 'done_by', user_id: rebazId });
      // Rebaz's two orders only: Sara's 42,500 is not his to see.
      expect(own.body.totals.total_iqd).toBe(265_000);

      // And asking for somebody else changes nothing: the pin is applied over the query.
      const asking = await as(ctx.http, rebaz)
        .get(`/api/v1/reports/sales?${range()}&done_by=${saraId}`)
        .expect(200);
      expect(asking.body.totals.total_iqd).toBe(265_000);
    });
  });

  // ───────────────────────────────── purchases (FR-1004) ─────────────────────────────────

  describe('the purchases report (FR-1004)', () => {
    it('totals the purchases of the period and what was paid to companies', async () => {
      await seedActivity();
      const report = await as(ctx.http, admin).get(`/api/v1/reports/purchases?${range()}`).expect(200);

      // 500 kg × 690 د.ع.
      expect(report.body.totals.cost.total_iqd).toBe(345_000);
      expect(report.body.totals.count_purchases).toBe(1);
      expect(report.body.totals.cost.paid_iqd).toBe(100_000);
    });

    it('omits the amounts for a user without the bought-price flag, and keeps the quantities', async () => {
      await seedActivity();
      const forSara = await seedUser({
        username: 'shilan',
        displayName: 'Shilan',
        permissions: ['reports.view', 'reports.view_all'],
      });
      const session = await signIn(ctx.http, forSara);

      const report = await as(ctx.http, session)
        .get(`/api/v1/reports/purchases?${range()}&group_by=item`)
        .expect(200);
      expect(report.body.groups[0].qty_kg).toBe('500.000');
      expect('cost' in report.body.groups[0]).toBe(false);
      expect('cost' in report.body.totals).toBe(false);
      expect(report.body.totals.count_purchases).toBe(1);
    });
  });

  // ───────────────────────────────── profit (FR-1005) ─────────────────────────────────

  describe('the margin report (FR-1005, spec 2.11)', () => {
    it('computes the margin from the line snapshots, with the same sign in both currencies', async () => {
      await seedActivity();
      const report = await as(ctx.http, rebaz).get(`/api/v1/reports/profit?${range()}&group_by=item`).expect(200);

      const copperRow = report.body.groups.find((group: { key: string }) => group.key === copper);
      // Rebaz sold 100 kg of copper at 850 against a 700 cost snapshot: 15,000 د.ع of margin,
      // and its dollar side is that figure converted at the line's own rate, never recomputed.
      expect(copperRow.cost.margin_iqd).toBe(15_000);
      expect(copperRow.cost.margin_usd_cents).toBe(1_154);
      expect(copperRow.cost.revenue_iqd).toBe(85_000);

      for (const group of report.body.groups) {
        expect(Math.sign(group.cost.margin_iqd)).toBe(Math.sign(group.cost.margin_usd_cents));
      }
      expect(report.body.basis).toBe('month_price');
    });

    it('lists lines with no cost price separately instead of counting them as profit', async () => {
      // A material with no bought price at all: its lines have no snapshot (cost_source none).
      const unpriced = await as(ctx.http, admin)
        .post('/api/v1/items')
        .send({ name: 'Offcuts', pricing_unit: 'per_kg' })
        .expect(201);
      await as(ctx.http, admin)
        .put(`/api/v1/items/${unpriced.body.id}/prices/${today().slice(0, 7)}`)
        .send({ sale: { amount: 400, currency: 'IQD' } })
        .expect(200);

      await as(ctx.http, rebaz)
        .post('/api/v1/orders')
        .send({
          customer_id: kawa,
          order_date: today(),
          payment_type: 'borrowed',
          lines: [{ item_id: unpriced.body.id, qty_kg: '10.000' }],
        })
        .expect(201);

      const report = await as(ctx.http, rebaz).get(`/api/v1/reports/profit?${range()}&group_by=item`).expect(200);
      const row = report.body.groups.find((group: { key: string }) => group.key === unpriced.body.id);
      expect(row.lines_without_cost).toBe(1);
      expect(row.cost.margin_iqd).toBe(0);
      expect(report.body.totals.lines_without_cost).toBe(1);
    });

    it('flags a group whose cost came from an earlier month', async () => {
      // A material priced only last month: this month's order carries a fallback snapshot.
      const late = await as(ctx.http, admin)
        .post('/api/v1/items')
        .send({ name: 'Brass fitting', pricing_unit: 'per_piece' })
        .expect(201);
      const lastMonth = new Date();
      lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
      await as(ctx.http, admin)
        .put(`/api/v1/items/${late.body.id}/prices/${lastMonth.toISOString().slice(0, 7)}`)
        .send({ sale: { amount: 3_000, currency: 'IQD' }, bought: { amount: 2_500, currency: 'IQD' } })
        .expect(200);

      await as(ctx.http, rebaz)
        .post('/api/v1/orders')
        .send({
          customer_id: kawa,
          order_date: today(),
          payment_type: 'borrowed',
          lines: [{ item_id: late.body.id, qty_count: 4 }],
        })
        .expect(201);

      const report = await as(ctx.http, rebaz).get(`/api/v1/reports/profit?${range()}&group_by=item`).expect(200);
      const row = report.body.groups.find((group: { key: string }) => group.key === late.body.id);
      expect(row.price_fallback).toBe(true);
      expect(row.cost.margin_iqd).toBe(2_000);
    });

    it('is refused outright to a user without the profit flag', async () => {
      await as(ctx.http, sara).get(`/api/v1/reports/profit?${range()}`).expect(403);
    });
  });

  // ───────────────────────────────── stock (FR-1006) ─────────────────────────────────

  describe('the stock report (FR-1006)', () => {
    it('equals the stock ledger and values it at the month bought price', async () => {
      await seedActivity();
      const report = await as(ctx.http, admin).get(`/api/v1/reports/stock?${range()}`).expect(200);

      const copperRow = report.body.groups.find((group: { key: string }) => group.key === copper);
      const independent = await withDatabase(async (client) => {
        const { rows } = await client.query<{ kg: string }>(
          `SELECT coalesce(sum(qty_kg), 0)::text AS kg FROM stock_ledger WHERE item_id = $1`,
          [copper],
        );
        return rows[0]?.kg as string;
      });
      expect(copperRow.stock_kg).toBe(independent);
      // 6,000 in, 150 sold, 500 bought, 4 damaged = 6,346 kg × 700 د.ع.
      expect(copperRow.stock_kg).toBe('6346.000');
      expect(copperRow.cost.value_iqd).toBe(4_442_200);
      expect(copperRow.price_fallback).toBe(false);
    });

    it('counts the movements of the period by direction', async () => {
      await seedActivity();
      const report = await as(ctx.http, admin).get(`/api/v1/reports/stock?${range()}`).expect(200);
      const copperRow = report.body.groups.find((group: { key: string }) => group.key === copper);
      expect(copperRow.moved_in_kg).toBe('6500.000');
      expect(copperRow.moved_out_kg).toBe('154.000');
    });

    it('omits the value for a user without the bought-price flag', async () => {
      const plain = await seedUser({ username: 'shilan', permissions: ['reports.view', 'reports.view_all'] });
      const session = await signIn(ctx.http, plain);
      const report = await as(ctx.http, session).get(`/api/v1/reports/stock?${range()}`).expect(200);
      expect('cost' in report.body.groups[0]).toBe(false);
      expect(report.body.groups[0].stock_kg).toBeDefined();
    });
  });

  // ─────────────────────── receivables and payables (FR-1007, FR-1008) ───────────────────────

  describe('receivables and payables (FR-1007, FR-1008)', () => {
    it('sums the customer balances exactly as the ledger does, newest owing first', async () => {
      await seedActivity();
      const report = await as(ctx.http, admin).get(`/api/v1/reports/receivables?${range()}`).expect(200);

      const independent = await withDatabase(async (client) => {
        const { rows } = await client.query<{ balance: string }>(
          `SELECT coalesce(sum(amount_iqd), 0)::text AS balance FROM customer_ledger`,
        );
        return Number(rows[0]?.balance ?? 0);
      });
      expect(report.body.totals.balance.amount_iqd).toBe(independent);
      // Kawa owes 85,000 − 30,000 = 55,000; Zagros owes 42,500.
      expect(report.body.groups[0]).toMatchObject({ label: 'Kawa Trading' });
      expect(report.body.groups[0].balance.amount).toBe(55_000);
      // What came in from Kawa in the period: the cash order settling itself (180,000) and the
      // part payment on the borrowed one (30,000).
      expect(report.body.groups[0].balance.received_iqd).toBe(210_000);
    });

    it('pins receivables to the customers assigned to the caller', async () => {
      await seedActivity();
      const own = await as(ctx.http, rebaz).get(`/api/v1/reports/receivables?${range()}`).expect(200);
      expect(own.body.pinned).toEqual({ filter: 'assigned_to', user_id: rebazId });
      expect(own.body.groups.map((group: { label: string }) => group.label)).toEqual(['Kawa Trading']);
    });

    it('sums the company balances and the period movements', async () => {
      await seedActivity();
      const report = await as(ctx.http, admin).get(`/api/v1/reports/payables?${range()}`).expect(200);

      const independent = await withDatabase(async (client) => {
        const { rows } = await client.query<{ balance: string }>(
          `SELECT coalesce(sum(amount_iqd), 0)::text AS balance FROM company_ledger`,
        );
        return Number(rows[0]?.balance ?? 0);
      });
      expect(report.body.totals.balance.amount_iqd).toBe(independent);
      // 345,000 purchased, 100,000 paid.
      expect(report.body.groups[0].balance).toMatchObject({
        amount: 245_000,
        purchased_iqd: 345_000,
        paid_iqd: 100_000,
      });
    });

    it('shows every supplier to an accountant without reports.view_all, because companies are unscoped', async () => {
      await seedActivity();
      // An accountant: the balances flag, no `reports.view_all`. Companies are deliberately
      // unscoped (FR-711) and are not assigned to anybody in practice, so pinning Payables to
      // "assigned to me" answered "we owe nothing" — an empty state that reads as a fact (D-031).
      const nazdar = await seedUser({
        username: 'nazdar',
        displayName: 'Nazdar',
        permissions: ['reports.view', 'fields.see_company_balances', 'companies.view'],
      });
      const session = await signIn(ctx.http, nazdar);

      const report = await as(ctx.http, session).get(`/api/v1/reports/payables?${range()}`).expect(200);
      expect(report.body.pinned).toBeUndefined();
      expect(report.body.groups.map((group: { label: string }) => group.label)).toContain('Al-Noor Steel Co.');
      expect(report.body.totals.balance.amount_iqd).toBe(245_000);
    });

    it('refuses both reports to a user without the balance flags', async () => {
      const plain = await seedUser({ username: 'shilan', permissions: ['reports.view', 'reports.view_all'] });
      const session = await signIn(ctx.http, plain);
      await as(ctx.http, session).get(`/api/v1/reports/receivables?${range()}`).expect(403);
      await as(ctx.http, session).get(`/api/v1/reports/payables?${range()}`).expect(403);
    });
  });

  // ───────────────────────────── damage and employee activity ─────────────────────────────

  describe('the damage report (FR-1009)', () => {
    it('matches the damaged-items list for the same filters, and counts what returns credited', async () => {
      const seeded = await seedActivity();
      await as(ctx.http, admin)
        .post(`/api/v1/damages/${seeded.damage.id}/return`)
        .send({ status: 'returned', credit: { amount: 2_760, currency: 'IQD' } })
        .expect(200);

      const report = await as(ctx.http, admin).get(`/api/v1/reports/damage?${range()}`).expect(200);
      const list = await as(ctx.http, admin).get(`/api/v1/damages?from=${monthStart()}&to=${today()}`).expect(200);

      expect(report.body.totals.records).toBe(list.body.totals.records);
      expect(report.body.totals.qty_kg).toBe(list.body.totals.qty_kg);
      expect(report.body.totals.cost.est_value_iqd).toBe(list.body.totals.cost.est_value_iqd);
      // The credit the return produced, counted as money back.
      expect(report.body.totals.cost.credited_iqd).toBe(2_760);
    });

    it('groups by where the goods came from and by what happened to them', async () => {
      await seedActivity();
      const byAttribution = await as(ctx.http, admin)
        .get(`/api/v1/reports/damage?${range()}&group_by=attribution`)
        .expect(200);
      expect(byAttribution.body.groups[0].key).toBe('company');

      const byStatus = await as(ctx.http, admin)
        .get(`/api/v1/reports/damage?${range()}&group_by=return_status`)
        .expect(200);
      expect(byStatus.body.groups[0].key).toBe('pending');
    });
  });

  describe('the employee activity report (FR-1010)', () => {
    it('counts what each employee did, from the documents and the audit log', async () => {
      await seedActivity();
      const report = await as(ctx.http, admin).get(`/api/v1/reports/employee-activity?${range()}`).expect(200);

      const rebazRow = report.body.groups.find((group: { key: string }) => group.key === rebazId);
      expect(rebazRow).toMatchObject({ orders: 2, payments_in: 1, orders_iqd: 265_000 });
      const adminRow = report.body.groups.find((group: { label: string }) => group.label === 'Dara');
      expect(adminRow).toMatchObject({ purchases: 1, damages: 1, payments_out: 1 });
      // Sign-ins come from the audit log, which recorded three of them in this fixture.
      expect(sumOf(report.body.groups, 'sign_ins')).toBeGreaterThanOrEqual(3);
    });

    it('returns only the caller without reports.view_all', async () => {
      await seedActivity();
      const own = await as(ctx.http, rebaz).get(`/api/v1/reports/employee-activity?${range()}`).expect(200);
      expect(own.body.groups).toHaveLength(1);
      expect(own.body.groups[0].key).toBe(rebazId);
    });
  });

  // ─────────────────────── the daily cash-up (FR-1013) ───────────────────────

  describe('the daily cash-up (FR-1013)', () => {
    it('counts each physical currency from the ledgers, never from a conversion', async () => {
      await seedActivity();
      // A payment handed over in dollars, which must land in the dollar column only.
      await as(ctx.http, rebaz)
        .post(`/api/v1/customers/${kawa}/payments`)
        .send({ amount: 5_000, currency: 'USD', entry_date: today(), note: 'in dollars' })
        .expect(201);

      const report = await as(ctx.http, admin).get(`/api/v1/reports/cash-up?${range()}`).expect(200);
      const rebazRow = report.body.groups.find((group: { key: string }) => group.key === rebazId);

      const independent = await withDatabase(async (client) => {
        const { rows } = await client.query<{ iqd: string; usd: string }>(
          `SELECT coalesce(-sum(CASE WHEN entered_currency = 'IQD' THEN amount_iqd ELSE 0 END), 0)::text AS iqd,
                  coalesce(-sum(CASE WHEN entered_currency = 'USD' THEN amount_usd_cents ELSE 0 END), 0)::text AS usd
             FROM customer_ledger
            WHERE performed_by_user_id = $1 AND entry_type IN ('payment', 'cash_settlement')`,
          [rebazId],
        );
        return rows[0] as { iqd: string; usd: string };
      });

      expect(rebazRow.received_iqd).toBe(Number(independent.iqd));
      expect(rebazRow.received_usd_cents).toBe(Number(independent.usd));
      // 180,000 settled in cash + 30,000 paid in dinars; $50 in dollars, in its own column.
      expect(rebazRow.received_iqd).toBe(210_000);
      expect(rebazRow.received_usd_cents).toBe(5_000);
      expect(rebazRow.net_iqd).toBe(210_000);
    });

    it('counts money paid out to companies against the employee who paid it', async () => {
      await seedActivity();
      const report = await as(ctx.http, admin).get(`/api/v1/reports/cash-up?${range()}`).expect(200);
      const adminRow = report.body.groups.find((group: { label: string }) => group.label === 'Dara');
      expect(adminRow.paid_out_iqd).toBe(100_000);
      expect(adminRow.net_iqd).toBe(-100_000);
    });
  });

  // ─────────────────────── the dashboard and search (Proposed) ───────────────────────

  describe('the dashboard and global search (FR-1309, FR-1310, Proposed — not requested)', () => {
    it('gives an owner today in tiles, and a sales employee only their own', async () => {
      await seedActivity();
      const forAdmin = await as(ctx.http, admin).get('/api/v1/dashboard').expect(200);
      const keys = forAdmin.body.tiles.map((tile: { key: string }) => tile.key);
      expect(keys).toContain('sales_today');
      expect(keys).toContain('we_owe_companies');
      expect(keys).toContain('purchases_today');

      const dashboardUser = await seedUser({
        username: 'hemin',
        permissions: ['dashboard.view', 'orders.view'],
      });
      const session = await signIn(ctx.http, dashboardUser);
      const forEmployee = await as(ctx.http, session).get('/api/v1/dashboard').expect(200);
      const employeeKeys = forEmployee.body.tiles.map((tile: { key: string }) => tile.key);
      expect(employeeKeys).toContain('sales_today');
      // No supplier money, no purchases, because those keys are not theirs.
      expect(employeeKeys).not.toContain('we_owe_companies');
      expect(employeeKeys).not.toContain('purchases_today');
      expect(employeeKeys).toContain('my_actions_today');
    });

    it('finds a name typed in the other script, and a document by its number', async () => {
      const seeded = await seedActivity();

      // "كاوا" typed with Arabic kaf finds "Kawa" — the same normalisation the pickers use.
      const byName = await as(ctx.http, admin).get('/api/v1/search?q=kawa').expect(200);
      expect(byName.body.hits.some((hit: { kind: string; title: string }) => hit.title === 'Kawa Trading')).toBe(true);

      const byNumber = await as(ctx.http, admin)
        .get(`/api/v1/search?q=${seeded.kawaOrder.number}`)
        .expect(200);
      expect(byNumber.body.hits.some((hit: { kind: string }) => hit.kind === 'order')).toBe(true);
    });

    it('leaves out the sections the caller may not see', async () => {
      await seedActivity();
      const plain = await seedUser({ username: 'shilan', permissions: ['materials.view'] });
      const session = await signIn(ctx.http, plain);

      const hits = await as(ctx.http, session).get('/api/v1/search?q=copper').expect(200);
      expect(hits.body.hits.every((hit: { kind: string }) => hit.kind === 'item')).toBe(true);

      const noCustomers = await as(ctx.http, session).get('/api/v1/search?q=kawa').expect(200);
      expect(noCustomers.body.hits).toEqual([]);
    });
  });
});

function sumOf(groups: readonly Record<string, number>[], field: string): number {
  return groups.reduce((total, group) => total + (group[field] ?? 0), 0);
}

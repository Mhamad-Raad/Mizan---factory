import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { lineMargin } from '@mizan/money';
import { Database } from '../database/pool.js';
import { ReportsRepository } from '../reports/reports.repository.js';
import { as, createTestApp, resetDatabase, seedUser, signIn, withDatabase } from './harness.js';
import type { Session, TestApp } from './harness.js';

/**
 * The shape of the reads behind the reports — the Iteration 4 review's data-growth findings
 * (spec NFR-03, NFR-13).
 *
 * Three reports asked a grouping *view* — `order_balances`, `item_stats` — a question about one
 * row at a time. A view that groups every order ever placed cannot be narrowed from outside it,
 * so Postgres evaluated it again for every customer and every material: at 63,000 orders that
 * was 668 ms for Receivables and 190 ms for Stock. Rewritten as one grouped pass each, they are
 * 37.6 ms and 19.1 ms. The same mistake the I1 review found on the Orders list, which is why it
 * is worth a test rather than a note.
 *
 * A wall-clock assertion would prove nothing at test scale, so these tests take the statement
 * the endpoint actually issued and ask two things of it: that it does not reach for either
 * per-row aggregate view, and that its plan reads about as many rows out of the growing tables
 * as those tables hold — rather than that many times the number of groups, which is what a view
 * asked per row costs. The number of *scans* is deliberately not asserted: a nested loop over
 * an index is a reasonable plan on small data, and the planner will rightly choose one.
 * Parallelism is off while measuring, because a gathered scan reports its rows per worker.
 */
describe('the reports read each growing table once (I4 review)', () => {
  let ctx: TestApp;
  let admin: Session;
  let copper: string;
  const customers: string[] = [];

  /** Enough customers that a per-row plan is a plan the planner would actually choose. */
  const CUSTOMER_COUNT = 24;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase();
    const adminUser = await seedUser({
      username: 'admin.shape',
      role: 'admin',
      displayName: 'Dara',
    });
    admin = await signIn(ctx.http, adminUser);
    await as(ctx.http, admin)
      .post('/api/v1/settings/global-rates')
      .send({ rate_iqd_per_usd: '1300' })
      .expect(201);

    copper = (
      await as(ctx.http, admin)
        .post('/api/v1/items')
        .send({ name: 'Copper wire 2 mm', pricing_unit: 'per_kg' })
        .expect(201)
    ).body.id;
    await as(ctx.http, admin)
      .put(`/api/v1/items/${copper}/prices/${today().slice(0, 7)}`)
      .send({ sale: { amount: 850, currency: 'IQD' }, bought: { amount: 700, currency: 'IQD' } })
      .expect(200);
    await as(ctx.http, admin)
      .post(`/api/v1/items/${copper}/opening-stock`)
      .send({ entry_date: today(), qty_kg: '100000.000', note: 'go-live count' })
      .expect(201);

    customers.length = 0;
    for (let index = 0; index < CUSTOMER_COUNT; index += 1) {
      const created = await as(ctx.http, admin)
        .post('/api/v1/customers')
        .send({ name: `Customer ${String(index).padStart(2, '0')}` })
        .expect(201);
      customers.push(created.body.id as string);

      // Two orders each: one still owed, one settled in cash — so "unpaid" is a real question.
      await as(ctx.http, admin)
        .post('/api/v1/orders')
        .send({
          customer_id: created.body.id,
          order_date: today(),
          payment_type: 'borrowed',
          lines: [{ item_id: copper, qty_kg: '10.000' }],
        })
        .expect(201);
      await as(ctx.http, admin)
        .post('/api/v1/orders')
        .send({
          customer_id: created.body.id,
          order_date: today(),
          payment_type: 'cash',
          received_currency: 'IQD',
          lines: [{ item_id: copper, qty_kg: '5.000' }],
        })
        .expect(201);
    }
  }, 120_000);

  function today(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Baghdad',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  const range = () => `from=${today().slice(0, 7)}-01&to=${today()}`;

  /**
   * Runs the request and returns every statement it issued, so a test can explain the one it
   * cares about. The endpoint is called over HTTP, so what is measured is what runs in
   * production — not a query re-typed in a test, which would drift the day the report changes.
   */
  async function statementsOf(path: string): Promise<{ text: string; values: unknown[] }[]> {
    const database = ctx.app.get(Database);
    const captured: { text: string; values: unknown[] }[] = [];
    const original = database.query.bind(database);
    Object.assign(database, {
      query: (text: string, values: unknown[] = []) => {
        captured.push({ text, values });
        return original(text, values);
      },
    });
    try {
      await as(ctx.http, admin).get(path).expect(200);
    } finally {
      Object.assign(database, { query: original });
    }
    return captured;
  }

  function statementMatching(
    statements: readonly { text: string; values: unknown[] }[],
    needle: RegExp,
  ): { text: string; values: unknown[] } {
    const found = statements.filter((statement) => needle.test(statement.text));
    expect(found.length, `no statement matched ${needle}`).toBeGreaterThan(0);
    return found[0]!;
  }

  /**
   * How many rows the plan actually read out of `relation`, counting every loop of every scan.
   *
   * This, and not the number of scans, is the invariant worth asserting. A nested loop that
   * probes an index once per row is fine and the planner will choose it on small data; what is
   * not fine is a plan that reads *the whole table* once per group, which is what a grouping
   * view asked per row does. So the question is: did the report read about as many rows as the
   * table has, or as many as the table has times the number of groups?
   */
  /**
   * The two per-row aggregate views this iteration's reports must not join.
   *
   * `order_balances` groups every order ever placed and `item_stats` every line ever sold; both
   * are right for one record and wrong for a report, because a predicate on one customer or one
   * material cannot be pushed inside them. Asserted on the statement the endpoint issued rather
   * than on its plan, because Postgres inlines a view and the plan no longer names it — and the
   * point of the rule is that a report should not reach for them in the first place.
   */
  function readsNoAggregateView(statement: { text: string }): void {
    expect(statement.text).not.toMatch(/order_balances|item_stats/);
  }

  function rowsRead(plan: Record<string, unknown>, relation: string): number {
    let total = 0;
    const walk = (node: Record<string, unknown>): void => {
      if (node['Relation Name'] === relation) {
        total += Number(node['Actual Rows'] ?? 0) * Number(node['Actual Loops'] ?? 1);
      }
      for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child);
    };
    walk(plan);
    return total;
  }

  async function planOf(statement: {
    text: string;
    values: unknown[];
  }): Promise<Record<string, unknown>> {
    return withDatabase(async (client) => {
      await client.query('SET max_parallel_workers_per_gather = 0');
      const { rows } = await client.query<{ plan: [{ Plan: Record<string, unknown> }] }>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`,
        statement.values as never[],
      );
      // node-postgres names the single column of EXPLAIN (FORMAT JSON) "QUERY PLAN".
      const raw = (rows[0] as unknown as Record<string, unknown>)['QUERY PLAN'] as [
        { Plan: Record<string, unknown> },
      ];
      return raw[0]!.Plan;
    });
  }

  it('reads the orders once for Receivables, not once per customer', async () => {
    const statements = await statementsOf(`/api/v1/reports/receivables?${range()}`);
    const receivables = statementMatching(statements, /unpaid_orders/);
    readsNoAggregateView(receivables);
    const plan = await planOf(receivables);

    // The previous code joined the `order_balances` view per customer, so it read all 48 orders
    // twenty-four times over — 1,152 rows to answer a question about 48. A few passes over the
    // data is the bound; a pass per group is the defect.
    const orders = CUSTOMER_COUNT * 2;
    expect(rowsRead(plan, 'orders')).toBeLessThanOrEqual(orders * 3);
    expect(rowsRead(plan, 'customers')).toBeLessThanOrEqual(CUSTOMER_COUNT * 4);
  });

  it('counts the same unpaid orders the ledger does', async () => {
    const report = await as(ctx.http, admin)
      .get(`/api/v1/reports/receivables?${range()}`)
      .expect(200);
    const reported = Object.fromEntries(
      report.body.groups.map((group: { key: string; unpaid_orders: number }) => [
        group.key,
        group.unpaid_orders,
      ]),
    );

    const independent = await withDatabase(async (client) => {
      const { rows } = await client.query<{ customer_id: string; unpaid: string }>(
        `SELECT customer_id, count(*)::text AS unpaid FROM (
           SELECT o.customer_id, o.id,
                  coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd
                                    ELSE l.amount_usd_cents END), 0) AS remaining
             FROM orders o
             JOIN customers c ON c.id = o.customer_id
             LEFT JOIN customer_ledger l ON l.order_id = o.id
            WHERE o.status = 'active' AND o.deleted_at IS NULL
            GROUP BY o.customer_id, o.id
         ) per_order WHERE remaining > 0 GROUP BY customer_id`,
      );
      return Object.fromEntries(rows.map((row) => [row.customer_id, Number(row.unpaid)]));
    });

    // One borrowed order each, and the cash ones settled at the till.
    expect(Object.keys(independent).length).toBe(CUSTOMER_COUNT);
    for (const [customerId, unpaid] of Object.entries(independent)) {
      expect(reported[customerId], `customer ${customerId}`).toBe(unpaid);
    }
  });

  it('reads only its page of the catalogue for the Stock report', async () => {
    const statements = await statementsOf(`/api/v1/reports/stock?${range()}`);
    const stock = statementMatching(statements, /last_sold_on/);
    readsNoAggregateView(stock);
    const plan = await planOf(stock);

    /**
     * The invariant changed in I6 and is worth stating plainly.
     *
     * I4 asserted one grouped pass over `order_lines`, because `item_stats` had asked "when was
     * this last sold?" once per material over the whole table. At the design point that grouped
     * pass read every line ever sold to send two hundred rows. So the report now takes its page
     * of materials **first** and looks each one up — per-material work again, but bounded by
     * the page rather than by the catalogue (REVIEW-I6).
     *
     * What must never come back is a pass over the catalogue: `items` is read for the page and
     * for nothing else.
     */
    expect(rowsRead(plan, 'items')).toBeLessThanOrEqual(220);

    /**
     * And neither does it read the documents. Both dates of FR-304 come from the stock ledger
     * since migration 0019 — the oldest purchase movement and the newest sale that was not
     * reversed — because `max(order_date)` over every line of a material is the query that
     * grows with a decade of trading: it was 200 of this report's 430 ms at the design point,
     * and the review measured it after the fixture's stock ledger was finally filled.
     */
    expect(stock.text).not.toMatch(/order_lines/);
  });

  it('keeps each material\'s stock as a sum over its movements, maintained (2.2.6)', async () => {
    /**
     * `item_stock` is a view over the maintained table of migration 0017 rather than a grouped
     * pass over the whole stock ledger. The figure is still a sum over the ledger — nothing
     * writes it but the trigger, and the application role cannot — and this test is what says
     * the sum is still right after movements in both directions, including a reversal.
     */
    const item = (
      await as(ctx.http, admin)
        .post('/api/v1/items')
        .send({ name: 'Plan-shape brass', pricing_unit: 'per_kg' })
        .expect(201)
    ).body.id as string;
    await as(ctx.http, admin)
      .put(`/api/v1/items/${item}/prices/${today().slice(0, 7)}`)
      .send({ sale: { amount: 900, currency: 'IQD' }, bought: { amount: 800, currency: 'IQD' } })
      .expect(200);
    await as(ctx.http, admin)
      .post(`/api/v1/items/${item}/opening-stock`)
      .send({ entry_date: today(), qty_kg: '1000.000', note: 'counted' })
      .expect(201);
    const sold = (
      await as(ctx.http, admin)
        .post('/api/v1/orders')
        .send({
          customer_id: customers[0],
          order_date: today(),
          payment_type: 'borrowed',
          lines: [{ item_id: item, qty_kg: '120.500' }],
        })
        .expect(201)
    ).body.id as string;
    await as(ctx.http, admin)
      .post(`/api/v1/orders/${sold}/void`)
      .send({ reason: 'the lorry never left the yard' })
      .expect(200);

    const fromLedger = await withDatabase(async (client) => {
      const { rows } = await client.query<{ total: string; movements: string }>(
        `SELECT coalesce(sum(qty_kg), 0)::text AS total, count(*)::text AS movements
           FROM stock_ledger WHERE item_id = $1`,
        [item],
      );
      return rows[0];
    });
    const maintained = await withDatabase(async (client) => {
      const { rows } = await client.query<{ stock_kg: string; movements: string }>(
        `SELECT stock_kg::text AS stock_kg, movements::text AS movements
           FROM item_stock_totals WHERE item_id = $1`,
        [item],
      );
      return rows[0];
    });

    expect(maintained.stock_kg).toBe(fromLedger.total);
    expect(maintained.movements).toBe(fromLedger.movements);
    // The void put the 120.5 kg back, so the material is where the opening count left it.
    expect(maintained.stock_kg).toBe('1000.000');

    const view = await withDatabase(async (client) => {
      const { rows } = await client.query<{ stock_kg: string; kg_complete: boolean }>(
        `SELECT stock_kg::text AS stock_kg, kg_complete FROM item_stock WHERE item_id = $1`,
        [item],
      );
      return rows[0];
    });
    expect(view.stock_kg).toBe('1000.000');
    expect(view.kg_complete).toBe(true);
  });

  it("reads the orders once for the dashboard's unpaid tile", async () => {
    const statements = await statementsOf('/api/v1/dashboard');
    // Matched by a fragment both shapes share, so the test fails on the plan rather than on
    // the needle when it is run against the previous code.
    const unpaid = statementMatching(statements, /::text AS count,[\s\S]*coalesce\(sum\(/);
    readsNoAggregateView(unpaid);
    const plan = await planOf(unpaid);

    const orders = CUSTOMER_COUNT * 2;
    expect(rowsRead(plan, 'orders')).toBeLessThanOrEqual(orders * 3);
  });

  it('sums the margins the kernel stored, line by line', async () => {
    const reports = ctx.app.get(ReportsRepository);
    const filters = { from: `${today().slice(0, 7)}-01`, to: today(), group_by: 'month' as const };

    // What the report sums is what the kernel wrote when each line was saved (D-039). This
    // recomputes it from the line's own snapshot — the kernel, not a second formula — and the
    // two must agree exactly, or the stored figure is a fiction.
    const stored = await reports.margins(filters);
    const lines = await withDatabase(async (client) => {
      const { rows } = await client.query(
        `SELECT ol.priced_measure::text AS priced_measure, ol.qty_count, ol.qty_kg::text AS qty_kg,
                ol.unit_price_iqd::int AS unit_price_iqd,
                ol.unit_price_usd_cents::int AS unit_price_usd_cents,
                ol.price_entered_currency::text AS price_entered_currency,
                ol.rate_iqd_per_usd::text AS rate_iqd_per_usd,
                ol.cost_unit_iqd::int AS cost_unit_iqd,
                ol.cost_unit_usd_cents::int AS cost_unit_usd_cents,
                ol.cost_source::text AS cost_source,
                ol.margin_iqd::int AS margin_iqd, ol.margin_usd_cents::int AS margin_usd_cents
           FROM order_lines ol JOIN orders o ON o.id = ol.order_id
          WHERE o.status = 'active' AND o.deleted_at IS NULL AND ol.deleted_at IS NULL`,
      );
      return rows;
    });

    expect(lines.length).toBe(CUSTOMER_COUNT * 2);
    for (const line of lines) {
      const computed = lineMargin(line as never);
      expect(line.margin_iqd).toBe(computed?.margin_iqd ?? null);
      expect(line.margin_usd_cents).toBe(computed?.margin_usd_cents ?? null);
    }

    const summed = lines.reduce((total, line) => total + (line.margin_iqd ?? 0), 0);
    expect(Number(stored[0]?.margin_iqd ?? 0)).toBe(summed);

    const report = await as(ctx.http, admin).get(`/api/v1/reports/profit?${range()}`).expect(200);
    expect(report.body.totals.cost.margin_iqd).toBe(summed);
    // 15 kg of copper a customer at 150 د.ع of margin a kilo.
    expect(summed).toBe(CUSTOMER_COUNT * 15 * 150);
  });

  it('agrees with Receivables about what is owed, tile and report', async () => {
    const dashboard = await as(ctx.http, admin).get('/api/v1/dashboard').expect(200);
    const tile = dashboard.body.tiles.find(
      (candidate: { key: string }) => candidate.key === 'unpaid_orders',
    );
    const report = await as(ctx.http, admin)
      .get(`/api/v1/reports/receivables?${range()}`)
      .expect(200);
    const unpaidInReport = report.body.groups.reduce(
      (total: number, group: { unpaid_orders: number }) => total + group.unpaid_orders,
      0,
    );

    expect(Number(tile.count)).toBe(unpaidInReport);
    expect(unpaidInReport).toBe(CUSTOMER_COUNT);
  });
});

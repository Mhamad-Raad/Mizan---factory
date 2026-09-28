import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTestApp, resetDatabase, seedUser, signIn, withDatabase } from './harness.js';
import type { Session, TestApp } from './harness.js';

/**
 * The maintained sums of migration 0033 and the performance review at ten years (D-075).
 *
 * `account_totals` (both ledgers per account) and `lot_balances` (what each buy has given out,
 * and whether it is live) are written only by triggers, and every screen that used to sum the
 * ledgers now reads them — so after every kind of write the suite checks them against the rows
 * they summarise, with the same queries `scripts/check-integrity.mjs` runs on a restore drill.
 * Then the three request flags the review added: `totals=false` on the Orders list, `all=true`
 * on the reports, and the used-up buys a page at a time.
 */
describe('maintained totals and the ten-year review (D-075)', () => {
  let ctx: TestApp;
  let admin: Session;
  let plain: Session;
  let bottles: string;
  let kawa: string;
  let zagros: string;

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
    const adminUser = await seedUser({ username: 'admin.totals', role: 'admin', displayName: 'Dara' });
    // May read reports, materials and orders, but sees neither balances nor bought prices.
    const plainUser = await seedUser({
      username: 'rebaz.totals',
      displayName: 'Rebaz',
      permissions: ['reports.view', 'materials.view', 'orders.view'],
    });
    admin = await signIn(ctx.http, adminUser);
    plain = await signIn(ctx.http, plainUser);
    await as(ctx.http, admin).post('/api/v1/settings/global-rates').send({ rate_iqd_per_usd: '1310' }).expect(201);

    // 100 bottles bought at 1,310 د.ع each: the material and its first buy.
    bottles = (
      await as(ctx.http, admin)
        .post('/api/v1/items')
        .send({
          name: 'Glass bottle 1 L',
          pricing_unit: 'per_piece',
          buy: { qty_count: 100, unit_price: { amount: 1_310, currency: 'IQD' }, purchase_date: today() },
        })
        .expect(201)
    ).body.id;
    await as(ctx.http, admin)
      .put(`/api/v1/items/${bottles}/prices/${today().slice(0, 7)}`)
      .send({ sale: { amount: 3_000, currency: 'IQD' } })
      .expect(200);

    kawa = (await as(ctx.http, admin).post('/api/v1/customers').send({ name: 'Kawa Trading' }).expect(201)).body.id;
    zagros = (
      await as(ctx.http, admin)
        .post('/api/v1/customers')
        .send({ name: 'Zagros Metals', settlement_currency: 'USD' })
        .expect(201)
    ).body.id;
  });

  /** A buy of `count` bottles at `price` dinars each; returns the purchase. */
  async function buy(count: number, price: number) {
    return (
      await as(ctx.http, admin)
        .post('/api/v1/purchases')
        .send({
          company_id: null,
          purchase_date: today(),
          lines: [{ item_id: bottles, qty_count: count, unit_price: { amount: price, currency: 'IQD' } }],
        })
        .expect(201)
    ).body as { id: string; version: number };
  }

  function sell(customer: string, count: number, paymentType: 'borrowed' | 'cash' = 'borrowed') {
    return as(ctx.http, admin)
      .post('/api/v1/orders')
      .send({
        customer_id: customer,
        order_date: today(),
        payment_type: paymentType,
        ...(paymentType === 'cash' ? { received_currency: 'IQD' } : {}),
        lines: [{ item_id: bottles, qty_count: count }],
      });
  }

  /**
   * Every maintained row against the rows it sums — the checks of `check-integrity.mjs`. Zero
   * differences, and every purchase line has its lot row.
   */
  async function expectMaintainedTotalsTrue(): Promise<void> {
    const wrong = await withDatabase(async (client) => {
      const accounts = await client.query<{ n: string }>(
        `WITH r AS (SELECT customer_id id, sum(amount_iqd) i, sum(amount_usd_cents) u, count(*) n FROM customer_ledger GROUP BY 1),
              p AS (SELECT company_id id, sum(amount_iqd) i, sum(amount_usd_cents) u, count(*) n FROM company_ledger GROUP BY 1)
         SELECT count(*)::text AS n
           FROM account_totals t
           FULL JOIN r ON r.id = t.account_id
           FULL JOIN p ON p.id = coalesce(t.account_id, r.id)
          WHERE (coalesce(t.receivable_iqd, 0), coalesce(t.receivable_usd_cents, 0), coalesce(t.receivable_entries, 0))
                  <> (coalesce(r.i, 0), coalesce(r.u, 0), coalesce(r.n, 0))
             OR (coalesce(t.payable_iqd, 0), coalesce(t.payable_usd_cents, 0), coalesce(t.payable_entries, 0))
                  <> (coalesce(p.i, 0), coalesce(p.u, 0), coalesce(p.n, 0))`,
      );
      const lots = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM purchase_lines l
           JOIN purchases p ON p.id = l.purchase_id
           LEFT JOIN lot_balances b ON b.purchase_line_id = l.id
           LEFT JOIN (SELECT purchase_line_id, sum(qty) AS t FROM lot_allocations GROUP BY 1) a
             ON a.purchase_line_id = l.id
          WHERE b.purchase_line_id IS NULL
             OR b.taken <> coalesce(a.t, 0)
             OR b.item_id <> l.item_id
             OR b.quantity IS DISTINCT FROM (CASE WHEN l.priced_measure = 'count' THEN l.qty_count::numeric ELSE l.qty_kg END)
             OR b.live <> (l.deleted_at IS NULL AND p.status = 'active' AND p.deleted_at IS NULL)`,
      );
      // The net figure every screen shows, from the maintained sums, against both ledgers summed
      // in each account's settlement currency *today* — the definition migration 0023 gave it.
      const party = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM customers c
           JOIN party_balances pb ON pb.customer_id = c.id
          WHERE (pb.receivable, pb.payable) <> (
                  (SELECT coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END), 0)
                     FROM customer_ledger l WHERE l.customer_id = c.id),
                  (SELECT coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END), 0)
                     FROM company_ledger l WHERE l.company_id = c.id))`,
      );
      // What each account owes on its orders (0035), per currency set, against the orders.
      const owing = await client.query<{ n: number }>(
        `WITH x AS (
           SELECT o.customer_id AS id,
                  count(*) FILTER (WHERE r.remaining_iqd > 0) AS iqd_orders,
                  coalesce(sum(r.remaining_iqd) FILTER (WHERE r.remaining_iqd > 0), 0) AS iqd_remaining_iqd,
                  coalesce(sum(r.remaining_usd_cents) FILTER (WHERE r.remaining_iqd > 0), 0) AS iqd_remaining_usd_cents,
                  coalesce(sum(o.total_iqd) FILTER (WHERE r.remaining_iqd > 0), 0) AS iqd_total_iqd,
                  coalesce(sum(o.total_usd_cents) FILTER (WHERE r.remaining_iqd > 0), 0) AS iqd_total_usd_cents,
                  count(*) FILTER (WHERE r.remaining_iqd > 0 AND r.remaining_iqd >= o.total_iqd) AS iqd_unpaid_orders,
                  coalesce(sum(r.remaining_iqd) FILTER (WHERE r.remaining_iqd > 0 AND r.remaining_iqd >= o.total_iqd), 0) AS iqd_unpaid_remaining_iqd,
                  coalesce(sum(r.remaining_usd_cents) FILTER (WHERE r.remaining_iqd > 0 AND r.remaining_iqd >= o.total_iqd), 0) AS iqd_unpaid_remaining_usd_cents,
                  coalesce(sum(o.total_iqd) FILTER (WHERE r.remaining_iqd > 0 AND r.remaining_iqd >= o.total_iqd), 0) AS iqd_unpaid_total_iqd,
                  coalesce(sum(o.total_usd_cents) FILTER (WHERE r.remaining_iqd > 0 AND r.remaining_iqd >= o.total_iqd), 0) AS iqd_unpaid_total_usd_cents,
                  count(*) FILTER (WHERE r.remaining_usd_cents > 0) AS usd_orders,
                  coalesce(sum(r.remaining_iqd) FILTER (WHERE r.remaining_usd_cents > 0), 0) AS usd_remaining_iqd,
                  coalesce(sum(r.remaining_usd_cents) FILTER (WHERE r.remaining_usd_cents > 0), 0) AS usd_remaining_usd_cents,
                  coalesce(sum(o.total_iqd) FILTER (WHERE r.remaining_usd_cents > 0), 0) AS usd_total_iqd,
                  coalesce(sum(o.total_usd_cents) FILTER (WHERE r.remaining_usd_cents > 0), 0) AS usd_total_usd_cents,
                  count(*) FILTER (WHERE r.remaining_usd_cents > 0 AND r.remaining_usd_cents >= o.total_usd_cents) AS usd_unpaid_orders,
                  coalesce(sum(r.remaining_iqd) FILTER (WHERE r.remaining_usd_cents > 0 AND r.remaining_usd_cents >= o.total_usd_cents), 0) AS usd_unpaid_remaining_iqd,
                  coalesce(sum(r.remaining_usd_cents) FILTER (WHERE r.remaining_usd_cents > 0 AND r.remaining_usd_cents >= o.total_usd_cents), 0) AS usd_unpaid_remaining_usd_cents,
                  coalesce(sum(o.total_iqd) FILTER (WHERE r.remaining_usd_cents > 0 AND r.remaining_usd_cents >= o.total_usd_cents), 0) AS usd_unpaid_total_iqd,
                  coalesce(sum(o.total_usd_cents) FILTER (WHERE r.remaining_usd_cents > 0 AND r.remaining_usd_cents >= o.total_usd_cents), 0) AS usd_unpaid_total_usd_cents
             FROM order_remaining r
             JOIN orders o ON o.id = r.order_id
            WHERE o.status = 'active' AND o.deleted_at IS NULL
            GROUP BY o.customer_id
         )
         SELECT count(*)::int AS n
           FROM x
           FULL JOIN account_owing a ON a.account_id = x.id
          WHERE (coalesce(x.iqd_orders, 0), coalesce(x.iqd_remaining_iqd, 0), coalesce(x.iqd_remaining_usd_cents, 0), coalesce(x.iqd_total_iqd, 0), coalesce(x.iqd_total_usd_cents, 0), coalesce(x.iqd_unpaid_orders, 0), coalesce(x.iqd_unpaid_remaining_iqd, 0), coalesce(x.iqd_unpaid_remaining_usd_cents, 0), coalesce(x.iqd_unpaid_total_iqd, 0), coalesce(x.iqd_unpaid_total_usd_cents, 0), coalesce(x.usd_orders, 0), coalesce(x.usd_remaining_iqd, 0), coalesce(x.usd_remaining_usd_cents, 0), coalesce(x.usd_total_iqd, 0), coalesce(x.usd_total_usd_cents, 0), coalesce(x.usd_unpaid_orders, 0), coalesce(x.usd_unpaid_remaining_iqd, 0), coalesce(x.usd_unpaid_remaining_usd_cents, 0), coalesce(x.usd_unpaid_total_iqd, 0), coalesce(x.usd_unpaid_total_usd_cents, 0))
             <> (coalesce(a.iqd_orders, 0), coalesce(a.iqd_remaining_iqd, 0), coalesce(a.iqd_remaining_usd_cents, 0), coalesce(a.iqd_total_iqd, 0), coalesce(a.iqd_total_usd_cents, 0), coalesce(a.iqd_unpaid_orders, 0), coalesce(a.iqd_unpaid_remaining_iqd, 0), coalesce(a.iqd_unpaid_remaining_usd_cents, 0), coalesce(a.iqd_unpaid_total_iqd, 0), coalesce(a.iqd_unpaid_total_usd_cents, 0), coalesce(a.usd_orders, 0), coalesce(a.usd_remaining_iqd, 0), coalesce(a.usd_remaining_usd_cents, 0), coalesce(a.usd_total_iqd, 0), coalesce(a.usd_total_usd_cents, 0), coalesce(a.usd_unpaid_orders, 0), coalesce(a.usd_unpaid_remaining_iqd, 0), coalesce(a.usd_unpaid_remaining_usd_cents, 0), coalesce(a.usd_unpaid_total_iqd, 0), coalesce(a.usd_unpaid_total_usd_cents, 0))`,
      );
      return {
        accounts: Number(accounts.rows[0]?.n),
        lots: Number(lots.rows[0]?.n),
        party: Number(party.rows[0]?.n),
        owing: Number(owing.rows[0]?.n),
      };
    });
    expect(wrong).toEqual({ accounts: 0, lots: 0, party: 0, owing: 0 });
  }

  it('keeps both maintained sums equal to their rows through every kind of write', async () => {
    await expectMaintainedTotalsTrue();

    // An order on credit, part-paid, the payment reversed, then the order voided.
    const order = (await sell(kawa, 30).expect(201)).body;
    await expectMaintainedTotalsTrue();
    const payment = await as(ctx.http, admin)
      .post(`/api/v1/orders/${order.id}/payments`)
      .send({ amount: 20_000, currency: 'IQD', entry_date: today() })
      .expect(201);
    await expectMaintainedTotalsTrue();
    await as(ctx.http, admin)
      .post(`/api/v1/customers/${kawa}/ledger/${payment.body[0].entry_id}/reverse`)
      .send({ note: 'wrong customer' })
      .expect(201);
    await expectMaintainedTotalsTrue();
    await as(ctx.http, admin).post(`/api/v1/orders/${order.id}/void`).send({ reason: 'typed twice' }).expect(200);
    await expectMaintainedTotalsTrue();

    // A dollar account's order, edited to a larger total, and a cash sale to it.
    const dollars = (await sell(zagros, 10).expect(201)).body;
    await as(ctx.http, admin)
      .put(`/api/v1/orders/${dollars.id}`)
      .send({
        customer_id: zagros,
        order_date: today(),
        payment_type: 'borrowed',
        version: dollars.version,
        lines: [{ item_id: bottles, qty_count: 12 }],
      })
      .expect(200);
    await expectMaintainedTotalsTrue();
    await sell(zagros, 5, 'cash').expect(201);
    await expectMaintainedTotalsTrue();

    // A change of settlement currency converts the balance with one settlement_change row; the
    // maintained sums hold both columns, so the balance in the new currency is right at once.
    const before = (await as(ctx.http, admin).get(`/api/v1/customers/${zagros}`).expect(200)).body;
    await as(ctx.http, admin)
      .put(`/api/v1/customers/${zagros}/settlement-currency`)
      .send({ currency: 'IQD', note: 'settles in dinars now', rebase_rate: '1310' })
      .expect(200);
    await expectMaintainedTotalsTrue();
    const after = (await as(ctx.http, admin).get(`/api/v1/customers/${zagros}`).expect(200)).body;
    expect(after.settlement_currency).toBe('IQD');
    expect(before.balance.amount_usd_cents).toBeGreaterThan(0);
    expect(after.balance.amount_iqd).toBeGreaterThan(0);

    // The buying side: an opening balance we owe, a payment to them, an adjustment.
    await as(ctx.http, admin)
      .post(`/api/v1/companies/${kawa}/opening-balance`)
      .send({ amount: 2_000_000, currency: 'IQD', entry_date: today(), note: 'owed at go-live' })
      .expect(201);
    await as(ctx.http, admin)
      .post(`/api/v1/companies/${kawa}/payments`)
      .send({ amount: 500_000, currency: 'IQD', entry_date: today() })
      .expect(201);
    await as(ctx.http, admin)
      .post(`/api/v1/companies/${kawa}/adjustments`)
      .send({ delta: -100_000, currency: 'IQD', entry_date: today(), note: 'agreed discount' })
      .expect(201);
    await expectMaintainedTotalsTrue();

    // A company's damage charged to them, paid back in money; another paid back in materials.
    const charged = await as(ctx.http, admin)
      .post('/api/v1/damages')
      .send({ item_id: bottles, qty_count: 4, damage_date: today(), attribution: 'company', company_id: kawa })
      .expect(201);
    await expectMaintainedTotalsTrue();
    await as(ctx.http, admin).post(`/api/v1/damages/${charged.body.id}/paid-back`).send({ method: 'money' }).expect(200);
    await expectMaintainedTotalsTrue();
    const replaced = await as(ctx.http, admin)
      .post('/api/v1/damages')
      .send({ item_id: bottles, qty_count: 3, damage_date: today(), attribution: 'company', company_id: kawa })
      .expect(201);
    await as(ctx.http, admin).post(`/api/v1/damages/${replaced.body.id}/paid-back`).send({ method: 'materials' }).expect(200);
    await expectMaintainedTotalsTrue();

    // A buy edited (its lines replaced) and another voided: neither is a lot any more.
    const edited = await buy(50, 1_500);
    await as(ctx.http, admin)
      .put(`/api/v1/purchases/${edited.id}`)
      .send({
        company_id: null,
        purchase_date: today(),
        version: edited.version,
        lines: [{ item_id: bottles, qty_count: 40, unit_price: { amount: 1_500, currency: 'IQD' } }],
      })
      .expect(200);
    await expectMaintainedTotalsTrue();
    const voided = await buy(20, 1_600);
    await as(ctx.http, admin).post(`/api/v1/purchases/${voided.id}/void`).send({ reason: 'never arrived' }).expect(200);
    await expectMaintainedTotalsTrue();
    const live = await withDatabase(async (client) =>
      (
        await client.query<{ live: number; dead: number }>(
          `SELECT count(*) FILTER (WHERE live)::int AS live, count(*) FILTER (WHERE NOT live)::int AS dead
             FROM lot_balances WHERE item_id = $1`,
          [bottles],
        )
      ).rows[0],
    );
    // The first buy and the edited buy's new line are live; the replaced line and the void are not.
    expect(live).toEqual({ live: 2, dead: 2 });
  });

  it('is not the application’s to write', async () => {
    const refused = await withDatabase(async (client) => {
      const { rows } = await client.query<{ table: string; writable: boolean }>(
        `SELECT t AS table,
                has_table_privilege('mizan_app', t, 'INSERT') OR has_table_privilege('mizan_app', t, 'UPDATE')
                  OR has_table_privilege('mizan_app', t, 'DELETE') AS writable
           FROM unnest(ARRAY['account_owing', 'account_totals', 'lot_balances']) AS t`,
      );
      return rows;
    });
    expect(refused).toEqual([
      { table: 'account_owing', writable: false },
      { table: 'account_totals', writable: false },
      { table: 'lot_balances', writable: false },
    ]);
  });

  it('answers the dashboard’s supplier tile and top debtors from the maintained sums', async () => {
    await sell(kawa, 10).expect(201);
    await as(ctx.http, admin)
      .post(`/api/v1/companies/${zagros}/opening-balance`)
      .send({ amount: 150_00, currency: 'USD', entry_date: today(), note: 'owed at go-live' })
      .expect(201);
    const dashboard = (await as(ctx.http, admin).get('/api/v1/dashboard').expect(200)).body;
    const tile = dashboard.tiles.find((one: { key: string }) => one.key === 'we_owe_companies');
    // Only what we owe, in each currency's own column: $150 and its dinars at the entry's rate.
    expect(tile.count).toBe(1);
    expect(tile.owed.amount_usd_cents).toBe(15_000);
    expect(tile.owed.amount_iqd).toBe(196_500);
    expect(dashboard.debtors.map((row: { name: string }) => row.name)).toEqual(['Kawa Trading']);
  });

  describe('the Orders list', () => {
    it('leaves out the totals when asked (totals=false), and keeps the rows and the count', async () => {
      await sell(kawa, 10).expect(201);
      await sell(kawa, 5, 'cash').expect(201);
      const full = (await as(ctx.http, admin).get('/api/v1/orders?page_size=8').expect(200)).body;
      const light = (await as(ctx.http, admin).get('/api/v1/orders?page_size=8&totals=false').expect(200)).body;
      expect(full.totals).toMatchObject({ orders: 2, balance: { owing: 1 } });
      expect('totals' in light).toBe(false);
      expect(light.total).toBe(2);
      expect(light.items).toEqual(full.items);
    });

    it('derives every status from the maintained remaining, with both currencies in the fixture', async () => {
      const unpaid = (await sell(kawa, 10).expect(201)).body;
      const partial = (await sell(zagros, 10).expect(201)).body;
      await as(ctx.http, admin)
        .post(`/api/v1/orders/${partial.id}/payments`)
        .send({ amount: 1_000, currency: 'USD', entry_date: today() })
        .expect(201);
      const paid = (await sell(kawa, 2, 'cash').expect(201)).body;
      const voided = (await sell(zagros, 1).expect(201)).body;
      await as(ctx.http, admin).post(`/api/v1/orders/${voided.id}/void`).send({ reason: 'typed twice' }).expect(200);

      const ids = async (status: string) =>
        ((await as(ctx.http, admin).get(`/api/v1/orders?status=${status}`).expect(200)).body.items as { id: string }[])
          .map((row) => row.id)
          .sort();
      expect(await ids('unpaid')).toEqual([unpaid.id]);
      expect(await ids('partially_paid')).toEqual([partial.id]);
      expect(await ids('owing')).toEqual([unpaid.id, partial.id].sort());
      expect(await ids('paid')).toEqual([paid.id]);
      expect(await ids('void')).toEqual([voided.id]);

      // What is owed is counted in each account's own currency and summed per currency.
      const owing = (await as(ctx.http, admin).get('/api/v1/orders?status=owing').expect(200)).body;
      expect(owing.total).toBe(2);
      expect(owing.totals.balance.owing).toBe(2);
      const all = (await as(ctx.http, admin).get('/api/v1/orders').expect(200)).body;
      expect(all.totals.balance).toEqual(owing.totals.balance);
      // The unnarrowed figures come from the maintained per-account sums (0035); a date range
      // reads the orders themselves. Both answers must agree, as must the dashboard's tile.
      for (const status of ['', 'owing', 'unpaid', 'partially_paid', 'paid']) {
        const filter = status ? `status=${status}&` : '';
        const kept = (await as(ctx.http, admin).get(`/api/v1/orders?${filter}`).expect(200)).body;
        const dated = (await as(ctx.http, admin).get(`/api/v1/orders?${filter}from=${today()}&to=${today()}`).expect(200))
          .body;
        expect({ status, total: kept.total, totals: kept.totals }).toEqual({ status, total: dated.total, totals: dated.totals });
        // And for one account, which the account's Orders tab asks.
        const mine = (await as(ctx.http, admin).get(`/api/v1/customers/${zagros}/orders?${filter}`).expect(200)).body;
        const mineDated = (
          await as(ctx.http, admin).get(`/api/v1/customers/${zagros}/orders?${filter}from=${today()}&to=${today()}`).expect(200)
        ).body;
        expect({ status, total: mine.total, totals: mine.totals }).toEqual({
          status,
          total: mineDated.total,
          totals: mineDated.totals,
        });
      }
      const tile = (await as(ctx.http, admin).get('/api/v1/dashboard').expect(200)).body.tiles.find(
        (one: { key: string }) => one.key === 'unpaid_orders',
      );
      expect(tile.balance).toEqual({
        count: owing.totals.balance.owing,
        amount_iqd: owing.totals.balance.owed_iqd,
        amount_usd_cents: owing.totals.balance.owed_usd_cents,
      });
      expect(owing.totals.balance.owed_usd_cents).toBeGreaterThan(0);
    });

    it('finds an order by its account, its notes or its number', async () => {
      const order = (
        await as(ctx.http, admin)
          .post('/api/v1/orders')
          .send({
            customer_id: kawa,
            order_date: today(),
            payment_type: 'borrowed',
            notes: 'deliver before Friday',
            lines: [{ item_id: bottles, qty_count: 3 }],
          })
          .expect(201)
      ).body;
      await sell(zagros, 1).expect(201);
      for (const q of ['kawa', 'friday', String(order.number)]) {
        const found = (await as(ctx.http, admin).get(`/api/v1/orders?q=${encodeURIComponent(q)}`).expect(200)).body;
        expect(found.items.map((row: { id: string }) => row.id)).toEqual([order.id]);
        expect(found.total).toBe(1);
      }
    });
  });

  describe('a material’s buys (GET /items/:id/lots)', () => {
    it('sends the buys with stock left, counts the used-up ones, and pages through them on request', async () => {
      await buy(10, 1_400);
      await buy(10, 1_500);
      // Sell the first buy (100) and the second (10) entirely, and 4 of the third.
      await sell(kawa, 114).expect(201);

      const open = (await as(ctx.http, admin).get(`/api/v1/items/${bottles}/lots`).expect(200)).body;
      expect(open.items.map((lot: { unit_cost_iqd: number; remaining: string }) => [lot.unit_cost_iqd, lot.remaining])).toEqual([
        [1_500, '6.000'],
      ]);
      expect(open.used_up_count).toBe(2);
      expect(open.latest).toMatchObject({ unit_cost_iqd: 1_500, remaining: '6.000' });

      const first = (await as(ctx.http, admin).get(`/api/v1/items/${bottles}/lots?used_up=true&page_size=1`).expect(200))
        .body;
      expect(first).toMatchObject({ total: 2, page: 1, page_size: 1, has_more: true });
      // Newest first: the 1,400 buy, then the first one at 1,310.
      expect(first.items.map((lot: { unit_cost_iqd: number }) => lot.unit_cost_iqd)).toEqual([1_400]);
      expect(first.items[0]).toMatchObject({ remaining: '0.000', taken: '10.000' });
      const second = (
        await as(ctx.http, admin).get(`/api/v1/items/${bottles}/lots?used_up=true&page=2&page_size=1`).expect(200)
      ).body;
      expect(second).toMatchObject({ total: 2, has_more: false });
      expect(second.items.map((lot: { unit_cost_iqd: number }) => lot.unit_cost_iqd)).toEqual([1_310]);
      const past = (
        await as(ctx.http, admin).get(`/api/v1/items/${bottles}/lots?used_up=true&page=3&page_size=1`).expect(200)
      ).body;
      expect(past).toMatchObject({ items: [], total: 2, has_more: false });

      // What a buy cost stays behind the bought-price flag in every shape.
      const hidden = (await as(ctx.http, plain).get(`/api/v1/items/${bottles}/lots`).expect(200)).body;
      expect('unit_cost_iqd' in hidden.items[0]).toBe(false);
      expect('line_total_iqd' in hidden.latest).toBe(false);
    });

    it('costs a sale past every buy at the latest buy, even when that buy is used up', async () => {
      await buy(10, 2_000);
      // 110 in stock across two buys; selling 115 takes both and costs 5 more at the latest price.
      const order = (await sell(kawa, 115).expect(201)).body;
      const read = (await as(ctx.http, admin).get(`/api/v1/orders/${order.id}`).expect(200)).body;
      expect(read.lines[0].cost).toMatchObject({ source: 'lots' });
      const summary = (await as(ctx.http, admin).get('/api/v1/accounts/summary').expect(200)).body;
      expect(summary.cost_of_sold.amount_iqd).toBe(100 * 1_310 + 10 * 2_000 + 5 * 2_000);
      const lots = (await as(ctx.http, admin).get(`/api/v1/items/${bottles}/lots`).expect(200)).body;
      expect(lots).toMatchObject({ items: [], used_up_count: 2 });
      expect(lots.latest).toMatchObject({ unit_cost_iqd: 2_000, remaining: '0.000' });
    });
  });

  describe('the reports’ one-pass export (all=true)', () => {
    it('sends every group at once, the same groups and totals as the pages, behind the same flags', async () => {
      const names = ['Aram', 'Bawan', 'Chya'];
      for (const [index, name] of names.entries()) {
        const id = (await as(ctx.http, admin).post('/api/v1/customers').send({ name }).expect(201)).body.id;
        await sell(id, index + 1).expect(201);
      }
      const range = `from=${today()}&to=${today()}`;
      const all = (await as(ctx.http, admin).get(`/api/v1/reports/receivables?${range}&all=true`).expect(200)).body;
      expect(all.groups).toHaveLength(3);
      expect(all).toMatchObject({ group_count: 3, has_more: false, page: 1, page_size: 10_000 });
      const paged = [];
      for (let page = 1; page <= 3; page += 1) {
        const one = (await as(ctx.http, admin).get(`/api/v1/reports/receivables?${range}&page=${page}&page_size=1`).expect(200))
          .body;
        expect(one.totals).toEqual(all.totals);
        paged.push(...one.groups);
      }
      expect(all.groups).toEqual(paged);
      // Largest balance first: Chya bought three.
      expect(all.groups.map((group: { label: string }) => group.label)).toEqual(['Chya', 'Bawan', 'Aram']);

      // The same permission: no balances flag, no Receivables — all=true changes nothing.
      await as(ctx.http, plain).get(`/api/v1/reports/receivables?${range}&all=true`).expect(403);
      // And the same field stripping: the stock report's values leave with the bought-price flag.
      const stock = (await as(ctx.http, plain).get(`/api/v1/reports/stock?${range}&all=true`).expect(200)).body;
      expect(stock.groups).toHaveLength(1);
      expect('cost' in stock.groups[0]).toBe(false);
      expect('cost' in stock.totals).toBe(false);
    });

    it('pages Payables in the database, largest first as a number, with the totals of every company', async () => {
      for (const [id, amount] of [
        [kawa, 900_000],
        [zagros, 10_000_00],
      ] as const) {
        await as(ctx.http, admin)
          .post(`/api/v1/companies/${id}/opening-balance`)
          .send({ amount, currency: id === zagros ? 'USD' : 'IQD', entry_date: today(), note: 'owed at go-live' })
          .expect(201);
      }
      const report = (
        await as(ctx.http, admin).get(`/api/v1/reports/payables?from=${today()}&to=${today()}&all=true`).expect(200)
      ).body;
      // 1,000,000 cents sorts above 900,000 dinars: compared as numbers, not as text ("9" > "1").
      expect(report.groups.map((group: { label: string }) => group.label)).toEqual(['Zagros Metals', 'Kawa Trading']);
      expect(report.totals.companies).toBe(2);
      expect(report.totals.balance.amount_iqd).toBe(
        report.groups.reduce((sum: number, group: { balance: { amount_iqd: number } }) => sum + group.balance.amount_iqd, 0),
      );
      const firstPage = (
        await as(ctx.http, admin).get(`/api/v1/reports/payables?from=${today()}&to=${today()}&page_size=1`).expect(200)
      ).body;
      expect(firstPage).toMatchObject({ group_count: 2, has_more: true });
      expect(firstPage.totals).toEqual(report.totals);
    });
  });
});

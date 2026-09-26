import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_DATABASE_URL,
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
 * Damaged items and returns (FR-801 to FR-807).
 *
 * The cases are the acceptance criteria of iteration 3: the stock effect per attribution, a
 * return to stock, an edit that writes compensating movements, a void that reverses them, a
 * return that credits the supplier and links back to the damage and its purchase, a customer
 * credit that links to the damage and its order, the value snapshot from the damage month's
 * bought price with its fallback flag, the check constraints on the attribution links, and
 * the period lock.
 */
describe('damaged items and returns (FR-801 to FR-807)', () => {
  let ctx: TestApp;
  let admin: Session;
  /** Hemin: the Warehouse preset — records damage, edits it, cannot void it. */
  let warehouse: Session;
  /** Nazdar: the Accountant preset — the credits that a return produces. */
  let accountant: Session;
  /** An employee who may see damage but not what it was worth (FR-807). */
  let noMoney: Session;
  let warehouseUserId: string;
  let copper: string;
  let plates: string;
  let alNoor: string;
  let kawa: string;
  let purchase: string;
  let order: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase();

    const adminUser = await seedUser({
      username: 'admin.damages',
      role: 'admin',
      displayName: 'Dara',
    });
    const warehouseUser = await seedUser({
      username: 'hemin',
      displayName: 'Hemin',
      permissions: [
        'damages.create',
        'damages.edit',
        'damages.mark_returned',
        'purchases.create',
        'companies.view',
        'materials.view',
        'fields.see_bought_price',
      ],
    });
    const accountantUser = await seedUser({
      username: 'nazdar',
      displayName: 'Nazdar',
      permissions: [
        'damages.view',
        'damages.mark_returned',
        'companies.record_credit',
        'companies.view',
        'orders.credit',
        'orders.view',
        'customers.view',
        'customers.view_all',
        'fields.see_company_balances',
        'fields.see_customer_balances',
        'fields.see_bought_price',
      ],
    });
    const plainUser = await seedUser({
      username: 'shilan',
      displayName: 'Shilan',
      permissions: ['damages.view', 'materials.view'],
    });
    warehouseUserId = warehouseUser.id;

    admin = await signIn(ctx.http, adminUser);
    warehouse = await signIn(ctx.http, warehouseUser);
    accountant = await signIn(ctx.http, accountantUser);
    noMoney = await signIn(ctx.http, plainUser);

    await as(ctx.http, admin)
      .post('/api/v1/settings/global-rates')
      .send({ rate_iqd_per_usd: '1300' })
      .expect(201);

    copper = await createMaterial('Copper wire 2 mm', 'per_kg', { sale: 850, bought: 700 });
    plates = await createMaterial('Steel plate 10 mm', 'per_piece', {
      sale: 18_000,
      bought: 15_000,
    });

    // A supplier with its own rate, a purchase that brought the copper in, and a customer
    // order that took some of it away again — the three things damage can be attributed to.
    const company = await as(ctx.http, admin)
      .post('/api/v1/customers')
      .send({ is_customer: false, is_supplier: true, name: 'Al-Noor Steel Co.' })
      .expect(201);
    alNoor = company.body.id;
    await as(ctx.http, admin)
      .post(`/api/v1/customers/${alNoor}/rates`)
      .send({ rate_iqd_per_usd: '1310' })
      .expect(201);

    const bought = await as(ctx.http, warehouse)
      .post('/api/v1/purchases')
      .send({
        company_id: alNoor,
        purchase_date: today(),
        lines: [
          { item_id: copper, qty_kg: '1000.000', unit_price: { amount: 5_900, currency: 'IQD' } },
          { item_id: plates, qty_count: 50, qty_kg: '120.000' },
        ],
      })
      .expect(201);
    purchase = bought.body.id;

    const customer = await as(ctx.http, admin)
      .post('/api/v1/customers')
      .send({ name: 'Kawa Trading' })
      .expect(201);
    kawa = customer.body.id;

    const sold = await as(ctx.http, admin)
      .post('/api/v1/orders')
      .send({
        customer_id: kawa,
        order_date: today(),
        payment_type: 'borrowed',
        lines: [{ item_id: copper, qty_kg: '100.000' }],
      })
      .expect(201);
    order = sold.body.id;
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

  function today(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Baghdad',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  /** Not `async`: the caller chains `.expect(...)` on the supertest request itself. */
  function recordDamage(session: Session, body: Record<string, unknown>) {
    return as(ctx.http, session)
      .post('/api/v1/damages')
      .send({ item_id: copper, qty_kg: '4.000', damage_date: today(), ...body });
  }

  async function stockOf(itemId: string) {
    return withDatabase(async (client) => {
      const { rows } = await client.query<{ movements: string; qty_kg: string; qty_count: string }>(
        `SELECT count(*)::text AS movements,
                coalesce(sum(qty_kg), 0)::text AS qty_kg,
                coalesce(sum(qty_count), 0)::text AS qty_count
           FROM stock_ledger WHERE item_id = $1`,
        [itemId],
      );
      return rows[0] as { movements: string; qty_kg: string; qty_count: string };
    });
  }

  async function movementsOf(itemId: string) {
    return withDatabase(async (client) => {
      const { rows } = await client.query<{
        movement_type: string;
        qty_kg: string | null;
        qty_count: number | null;
        ref_type: string | null;
        ref_id: string | null;
      }>(
        `SELECT movement_type::text AS movement_type, qty_kg::text AS qty_kg, qty_count,
                ref_type::text AS ref_type, ref_id
           FROM stock_ledger WHERE item_id = $1 ORDER BY posting_seq ASC`,
        [itemId],
      );
      return rows;
    });
  }

  async function companyBalance(): Promise<number> {
    const response = await as(ctx.http, accountant).get(`/api/v1/companies/${alNoor}`).expect(200);
    return response.body.balance.amount_iqd as number;
  }

  async function customerBalance(): Promise<number> {
    const response = await as(ctx.http, accountant).get(`/api/v1/customers/${kawa}`).expect(200);
    return response.body.balance.amount_iqd as number;
  }

  // ─────────────────────────── the record and its stock effect (FR-801, FR-804) ───────────────────────────

  describe('recording damage and what it does to stock (FR-801, FR-804, A-30)', () => {
    it('reduces stock and values the loss at the month bought price when it came from a supplier', async () => {
      const before = await stockOf(copper);

      const response = await recordDamage(warehouse, {
        attribution: 'company',
        company_id: alNoor,
        purchase_id: purchase,
        is_returnable: true,
        reason: 'arrived with cracked insulation',
      }).expect(201);

      expect(response.body.number).toBe(1);
      expect(response.body.stock_effect).toBe('reduced');
      expect(response.body.return_status).toBe('pending');
      // 4 kg × 700 د.ع, the month's bought price — not the 5,900 the purchase line paid.
      expect(response.body.cost).toMatchObject({ est_value_iqd: 2_800, est_value_source: 'month' });

      const after = await stockOf(copper);
      expect(Number(after.qty_kg)).toBe(Number(before.qty_kg) - 4);
      expect(Number(after.movements)).toBe(Number(before.movements) + 1);

      const movements = await movementsOf(copper);
      const damageOut = movements.find((movement) => movement.movement_type === 'damage_out');
      expect(damageOut).toMatchObject({
        qty_kg: '-4.000',
        ref_type: 'damage',
        ref_id: response.body.id,
      });
    });

    it('leaves stock alone when the goods had already been sold (customer order)', async () => {
      const before = await stockOf(copper);

      const response = await recordDamage(warehouse, {
        attribution: 'customer_order',
        order_id: order,
        reason: 'came back damaged',
      }).expect(201);

      expect(response.body.stock_effect).toBe('none');
      expect(await stockOf(copper)).toEqual(before);
    });

    it('reduces stock for "us" and for no attribution at all', async () => {
      for (const attribution of ['us', 'none'] as const) {
        const before = await stockOf(plates);
        const response = await recordDamage(warehouse, {
          item_id: plates,
          qty_count: 2,
          qty_kg: null,
          attribution,
        }).expect(201);
        expect(response.body.stock_effect).toBe('reduced');
        const after = await stockOf(plates);
        expect(Number(after.qty_count)).toBe(Number(before.qty_count) - 2);
      }
    });

    it('values a per-piece material by its count and flags a price carried from an earlier month', async () => {
      // September has no price for this material; August does, so the value is flagged.
      const late = await as(ctx.http, admin)
        .post('/api/v1/items')
        .send({ name: 'Brass fitting', pricing_unit: 'per_piece' })
        .expect(201);
      const lastMonth = new Date();
      lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
      await as(ctx.http, admin)
        .put(`/api/v1/items/${late.body.id}/prices/${lastMonth.toISOString().slice(0, 7)}`)
        .send({ bought: { amount: 2_500, currency: 'IQD' } })
        .expect(200);

      const response = await recordDamage(warehouse, {
        item_id: late.body.id,
        qty_count: 3,
        qty_kg: null,
      }).expect(201);

      expect(response.body.cost).toMatchObject({
        est_value_iqd: 7_500,
        est_value_source: 'fallback',
      });
    });

    it('records the value as unknown rather than zero when no month has a bought price', async () => {
      const unpriced = await as(ctx.http, admin)
        .post('/api/v1/items')
        .send({ name: 'Offcuts', pricing_unit: 'per_kg' })
        .expect(201);

      const response = await recordDamage(warehouse, {
        item_id: unpriced.body.id,
        qty_kg: '12.000',
      }).expect(201);
      expect(response.body.cost).toEqual({
        est_value_iqd: null,
        est_value_usd_cents: null,
        est_value_source: 'none',
      });
    });

    it('logs the record in History with its quantity, attribution and stock effect', async () => {
      const response = await recordDamage(warehouse, { attribution: 'us' }).expect(201);
      const rows = await auditRows({ entityId: response.body.id, action: 'create' });
      expect(rows[0]?.entity_label).toBe('Damage #1');
      expect(rows[0]?.changes).toMatchObject({
        attribution: { old: null, new: 'us' },
        stock_effect: { old: null, new: 'reduced' },
        quantity: { old: null, new: { qty_kg: '4.000' } },
      });
    });

    it('refuses a future date', async () => {
      // Tomorrow counted from the **Baghdad** day, not from the process clock: at 01:00
      // Baghdad time "now + 24 h" in UTC is still today here, and the API was right to accept
      // it (the recurring lesson of the I3 review, this time in a test).
      const tomorrow = new Date(`${today()}T00:00:00Z`);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const tomorrowInBaghdad = tomorrow.toISOString().slice(0, 10);
      const future = await recordDamage(warehouse, { damage_date: tomorrowInBaghdad }).expect(422);
      expect(future.body.error.fields[0]).toMatchObject({ code: 'FUTURE_DATE' });
    });
  });

  // ─────────────────────────── the attribution links (FR-802) ───────────────────────────

  describe('attribution and its links (FR-802)', () => {
    it('asks for the document the attribution names', async () => {
      const noOrder = await recordDamage(warehouse, { attribution: 'customer_order' }).expect(422);
      expect(noOrder.body.error.fields[0]).toMatchObject({ path: 'order_id', code: 'REQUIRED' });

      const noCompany = await recordDamage(warehouse, { attribution: 'company' }).expect(422);
      expect(noCompany.body.error.fields[0]).toMatchObject({
        path: 'company_id',
        code: 'REQUIRED',
      });
    });

    it('refuses a purchase that belongs to another company', async () => {
      const other = await as(ctx.http, admin)
        .post('/api/v1/customers')
        .send({ is_customer: false, is_supplier: true, name: 'Zagros Metals' })
        .expect(201);

      const response = await recordDamage(warehouse, {
        attribution: 'company',
        company_id: other.body.id,
        purchase_id: purchase,
      }).expect(422);
      expect(response.body.error.fields[0]).toMatchObject({
        path: 'purchase_id',
        code: 'NOT_FOUND',
      });
    });

    it('keeps the attribution and its links consistent at the database level (2.2.5)', async () => {
      const client = new Client({ connectionString: TEST_DATABASE_URL });
      await client.connect();
      try {
        // A record attributed to "us" that names a company would make the chip lie.
        await expect(
          client.query(
            `INSERT INTO damages (item_id, qty_kg, damage_date, acting_user_id, attribution, company_id,
                                  stock_effect, created_by, updated_by)
             SELECT $1, 1, current_date, id, 'us', $2, 'reduced', id, id FROM users LIMIT 1`,
            [copper, alNoor],
          ),
        ).rejects.toThrow(/damages_attribution_links/);

        // And a customer-order record that claims to have reduced stock.
        await expect(
          client.query(
            `INSERT INTO damages (item_id, qty_kg, damage_date, acting_user_id, attribution, order_id,
                                  stock_effect, created_by, updated_by)
             SELECT $1, 1, current_date, id, 'customer_order', $2, 'reduced', id, id FROM users LIMIT 1`,
            [copper, order],
          ),
        ).rejects.toThrow(/damages_stock_effect/);
      } finally {
        await client.end();
      }
    });
  });

  // ─────────────────────────── editing, voiding, returning to stock (FR-804) ───────────────────────────

  describe('editing and voiding a record (FR-804)', () => {
    it('writes compensating movements when the quantity changes', async () => {
      const created = await recordDamage(warehouse, { attribution: 'us' }).expect(201);
      const before = await stockOf(copper);

      await as(ctx.http, warehouse)
        .patch(`/api/v1/damages/${created.body.id}`)
        .send({ version: created.body.version, qty_kg: '6.000' })
        .expect(200);

      const movements = await movementsOf(copper);
      const damageRows = movements.filter((movement) => movement.ref_id === created.body.id);
      // The old 4 kg out, its reversal, and the new 6 kg out: the ledger tells the whole story.
      expect(damageRows.map((row) => row.movement_type)).toEqual([
        'damage_out',
        'reversal',
        'damage_out',
      ]);
      expect(Number((await stockOf(copper)).qty_kg)).toBe(Number(before.qty_kg) - 2);

      const rows = await auditRows({ entityId: created.body.id, action: 'update' });
      expect(rows[0]?.changes).toMatchObject({
        quantity: { old: { qty_kg: '4.000' }, new: { qty_kg: '6.000' } },
      });
    });

    it('moves the stock effect when the attribution changes', async () => {
      const created = await recordDamage(warehouse, { attribution: 'us' }).expect(201);
      const before = await stockOf(copper);

      const updated = await as(ctx.http, warehouse)
        .patch(`/api/v1/damages/${created.body.id}`)
        .send({ version: created.body.version, attribution: 'customer_order', order_id: order })
        .expect(200);

      expect(updated.body.stock_effect).toBe('none');
      // The goods were never out of stock after all, so the damage_out is reversed and nothing
      // replaces it: stock returns to where it was before the record existed.
      expect(Number((await stockOf(copper)).qty_kg)).toBe(Number(before.qty_kg) + 4);
    });

    it('re-values the record when the date moves to a month with a different price', async () => {
      const created = await recordDamage(warehouse, { attribution: 'us' }).expect(201);
      expect(created.body.cost.est_value_iqd).toBe(2_800);

      const lastMonth = new Date();
      lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
      const month = lastMonth.toISOString().slice(0, 7);
      await as(ctx.http, admin)
        .put(`/api/v1/items/${copper}/prices/${month}`)
        .send({ bought: { amount: 500, currency: 'IQD' } })
        .expect(200);

      const updated = await as(ctx.http, warehouse)
        .patch(`/api/v1/damages/${created.body.id}`)
        .send({ version: created.body.version, damage_date: `${month}-15` })
        .expect(200);
      expect(updated.body.cost).toMatchObject({ est_value_iqd: 2_000, est_value_source: 'month' });
    });

    it('reverses the movements on a void and keeps the reason', async () => {
      const created = await recordDamage(warehouse, { attribution: 'us' }).expect(201);
      const before = await stockOf(copper);

      const voided = await as(ctx.http, admin)
        .post(`/api/v1/damages/${created.body.id}/void`)
        .send({ reason: 'recorded against the wrong material' })
        .expect(200);

      expect(voided.body.doc_status).toBe('void');
      expect(voided.body.void_reason).toBe('recorded against the wrong material');
      expect(Number((await stockOf(copper)).qty_kg)).toBe(Number(before.qty_kg) + 4);

      const rows = await auditRows({ entityId: created.body.id, action: 'void' });
      expect(rows[0]?.note).toBe('recorded against the wrong material');
    });

    it('refuses the void to an employee whose preset does not grant it', async () => {
      const created = await recordDamage(warehouse, { attribution: 'us' }).expect(201);
      await as(ctx.http, warehouse)
        .post(`/api/v1/damages/${created.body.id}/void`)
        .send({ reason: 'not mine to void' })
        .expect(403);
    });

    it('puts usable goods a customer brought back into stock again, once', async () => {
      const created = await recordDamage(warehouse, {
        attribution: 'customer_order',
        order_id: order,
      }).expect(201);
      const before = await stockOf(copper);

      const returned = await as(ctx.http, warehouse)
        .post(`/api/v1/damages/${created.body.id}/return-to-stock`)
        .send({ note: 'cleaned up, back on the rack' })
        .expect(200);

      expect(returned.body.stock_effect).toBe('returned_in');
      expect(Number((await stockOf(copper)).qty_kg)).toBe(Number(before.qty_kg) + 4);
      const movements = await movementsOf(copper);
      expect(movements.some((movement) => movement.movement_type === 'return_in')).toBe(true);

      // Twice would double the stock; the second attempt is refused.
      await as(ctx.http, warehouse)
        .post(`/api/v1/damages/${created.body.id}/return-to-stock`)
        .send({})
        .expect(422);
    });

    it('refuses "return to stock" for goods that were never sold', async () => {
      const created = await recordDamage(warehouse, {
        attribution: 'company',
        company_id: alNoor,
      }).expect(201);
      const response = await as(ctx.http, warehouse)
        .post(`/api/v1/damages/${created.body.id}/return-to-stock`)
        .send({})
        .expect(422);
      expect(response.body.error.fields[0]).toMatchObject({ code: 'NOT_A_CUSTOMER_RETURN' });
    });
  });

  // ─────────────────────────── returns and the credits (FR-803, FR-805, FR-806) ───────────────────────────

  describe('returning goods to a supplier (FR-803, FR-805)', () => {
    it('pre-fills the credit from the purchase line price at the company rate', async () => {
      const created = await recordDamage(warehouse, {
        attribution: 'company',
        company_id: alNoor,
        purchase_id: purchase,
        is_returnable: true,
      }).expect(201);

      const detail = await as(ctx.http, accountant)
        .get(`/api/v1/damages/${created.body.id}`)
        .expect(200);
      // 4 kg × 5,900 د.ع on the purchase line = 23,600 د.ع ≈ 18.02 $ at the company's 1,310.
      expect(detail.body.credit_prefill).toMatchObject({
        amount_iqd: 23_600,
        amount_usd_cents: 1_802,
        source: 'purchase_line',
        rate_iqd_per_usd: '1310.0000',
      });
    });

    it('marks the record returned and credits the company, linked to the damage and the purchase', async () => {
      const created = await recordDamage(warehouse, {
        attribution: 'company',
        company_id: alNoor,
        purchase_id: purchase,
        is_returnable: true,
      }).expect(201);
      const owedBefore = await companyBalance();

      const returned = await as(ctx.http, accountant)
        .post(`/api/v1/damages/${created.body.id}/return`)
        .send({
          status: 'returned',
          note: 'driver took them back',
          credit: { amount: 23_600, currency: 'IQD', note: 'returned 4 kg' },
        })
        .expect(200);

      expect(returned.body.return_status).toBe('returned_credited');
      expect(returned.body.credited).toBe(true);
      expect(await companyBalance()).toBe(owedBefore - 23_600);

      const entry = await withDatabase(async (client) => {
        const { rows } = await client.query(
          `SELECT entry_type::text AS entry_type, amount_iqd::text AS amount_iqd, purchase_id, damage_id
             FROM company_ledger WHERE damage_id = $1`,
          [created.body.id],
        );
        return rows[0] as {
          entry_type: string;
          amount_iqd: string;
          purchase_id: string;
          damage_id: string;
        };
      });
      expect(entry).toMatchObject({
        entry_type: 'credit',
        amount_iqd: '-23600',
        purchase_id: purchase,
      });

      // The record's own page shows the credit that came from it.
      const detail = await as(ctx.http, accountant)
        .get(`/api/v1/damages/${created.body.id}`)
        .expect(200);
      expect(detail.body.credits[0]).toMatchObject({
        side: 'company',
        cost: { amount_iqd: -23_600 },
      });

      const rows = await auditRows({ entityId: created.body.id, action: 'status_change' });
      expect(rows[0]?.changes).toEqual({
        return_status: { old: 'pending', new: 'returned_credited' },
      });
    });

    it('records a plain return, then a credit from the record already returned', async () => {
      const created = await recordDamage(warehouse, {
        attribution: 'company',
        company_id: alNoor,
        is_returnable: true,
      }).expect(201);

      const returned = await as(ctx.http, accountant)
        .post(`/api/v1/damages/${created.body.id}/return`)
        .send({ status: 'returned' })
        .expect(200);
      expect(returned.body.return_status).toBe('returned');
      expect(returned.body.credited).toBe(false);

      const credited = await as(ctx.http, accountant)
        .post(`/api/v1/damages/${created.body.id}/return`)
        .send({ status: 'returned', credit: { amount: 2_800, currency: 'IQD' } })
        .expect(200);
      expect(credited.body.return_status).toBe('returned_credited');
    });

    it('writes a record off, and refuses to return it afterwards', async () => {
      const created = await recordDamage(warehouse, {
        attribution: 'company',
        company_id: alNoor,
        is_returnable: true,
      }).expect(201);

      const written = await as(ctx.http, accountant)
        .post(`/api/v1/damages/${created.body.id}/return`)
        .send({ status: 'written_off', note: 'supplier refused them' })
        .expect(200);
      expect(written.body.return_status).toBe('written_off');

      const again = await as(ctx.http, accountant)
        .post(`/api/v1/damages/${created.body.id}/return`)
        .send({ status: 'returned' })
        .expect(422);
      expect(again.body.error.fields[0]).toMatchObject({ code: 'RETURN_NOT_ALLOWED' });
    });

    it('refuses to return goods the record says cannot go back', async () => {
      const created = await recordDamage(warehouse, {
        attribution: 'company',
        company_id: alNoor,
        is_returnable: false,
      }).expect(201);
      expect(created.body.return_status).toBe('not_returnable');

      await as(ctx.http, accountant)
        .post(`/api/v1/damages/${created.body.id}/return`)
        .send({ status: 'returned' })
        .expect(422);
    });

    it('refuses a credit on a record that names no company', async () => {
      const created = await recordDamage(warehouse, {
        attribution: 'us',
        is_returnable: true,
      }).expect(201);
      const response = await as(ctx.http, accountant)
        .post(`/api/v1/damages/${created.body.id}/return`)
        .send({ status: 'returned', credit: { amount: 1_000, currency: 'IQD' } })
        .expect(422);
      expect(response.body.error.fields[0]).toMatchObject({ code: 'NOT_A_COMPANY_RETURN' });
    });

    it('refuses the credit to someone who may mark returns but not touch money', async () => {
      const created = await recordDamage(warehouse, {
        attribution: 'company',
        company_id: alNoor,
        is_returnable: true,
      }).expect(201);

      // Hemin may mark it returned…
      await as(ctx.http, warehouse)
        .post(`/api/v1/damages/${created.body.id}/return`)
        .send({ status: 'returned' })
        .expect(200);
      // …but not credit the supplier, which is the accountant's key (FR-805).
      const refused = await as(ctx.http, warehouse)
        .post(`/api/v1/damages/${created.body.id}/return`)
        .send({ status: 'returned', credit: { amount: 2_800, currency: 'IQD' } })
        .expect(403);
      expect(refused.body.error.params.required).toBe('companies.record_credit');
    });

    it('does not change stock when goods go back to the supplier (A-31)', async () => {
      const created = await recordDamage(warehouse, {
        attribution: 'company',
        company_id: alNoor,
        purchase_id: purchase,
        is_returnable: true,
      }).expect(201);
      const afterRecording = await stockOf(copper);

      await as(ctx.http, accountant)
        .post(`/api/v1/damages/${created.body.id}/return`)
        .send({ status: 'returned', credit: { amount: 23_600, currency: 'IQD' } })
        .expect(200);

      expect(await stockOf(copper)).toEqual(afterRecording);
    });
  });

  describe('goods a customer brought back (FR-806)', () => {
    it('leaves the customer balance alone until a credit is recorded, then links both', async () => {
      const created = await recordDamage(warehouse, {
        attribution: 'customer_order',
        order_id: order,
      }).expect(201);

      const owedBefore = await customerBalance();
      expect(created.body.credited).toBe(false);

      await as(ctx.http, accountant)
        .post(`/api/v1/customers/${kawa}/credits`)
        .send({
          amount: 2_800,
          currency: 'IQD',
          entry_date: today(),
          note: 'goods came back damaged',
          order_id: order,
          damage_id: created.body.id,
        })
        .expect(201);

      expect(await customerBalance()).toBe(owedBefore - 2_800);
      const detail = await as(ctx.http, accountant)
        .get(`/api/v1/damages/${created.body.id}`)
        .expect(200);
      expect(detail.body.credited).toBe(true);
      expect(detail.body.credits[0]).toMatchObject({
        side: 'customer',
        owner_name: 'Kawa Trading',
      });
    });

    it("refuses a credit that names another customer's damage record", async () => {
      const created = await recordDamage(warehouse, {
        attribution: 'customer_order',
        order_id: order,
      }).expect(201);

      const other = await as(ctx.http, admin)
        .post('/api/v1/customers')
        .send({ name: 'Rebin Metals' })
        .expect(201);

      const response = await as(ctx.http, accountant)
        .post(`/api/v1/customers/${other.body.id}/credits`)
        .send({
          amount: 2_800,
          currency: 'IQD',
          entry_date: today(),
          note: 'wrong account',
          damage_id: created.body.id,
        })
        .expect(422);
      expect(response.body.error.fields[0]).toMatchObject({ path: 'damage_id', code: 'NOT_FOUND' });
    });

    it('refuses a company credit that names a record attributed elsewhere', async () => {
      const created = await recordDamage(warehouse, {
        attribution: 'customer_order',
        order_id: order,
      }).expect(201);

      const response = await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/credits`)
        .send({
          amount: 2_800,
          currency: 'IQD',
          entry_date: today(),
          note: 'not our supplier',
          damage_id: created.body.id,
        })
        .expect(422);
      expect(response.body.error.fields[0]).toMatchObject({ path: 'damage_id', code: 'NOT_FOUND' });
    });
  });

  // ─────────────────────────── the I3 review finding ───────────────────────────

  describe('what the review found', () => {
    it('still opens a record whose material was re-classified after it was written', async () => {
      // 4 kg of a per-kg material…
      const created = await recordDamage(warehouse, {
        attribution: 'company',
        company_id: alNoor,
        purchase_id: purchase,
        is_returnable: true,
      }).expect(201);
      expect(created.body.cost.est_value_iqd).toBe(2_800);

      // …and then somebody decides the material is sold by the piece (`PATCH /items/:id`).
      const material = await as(ctx.http, admin).get(`/api/v1/items/${copper}`).expect(200);
      await as(ctx.http, admin)
        .patch(`/api/v1/items/${copper}`)
        .send({ pricing_unit: 'per_piece', version: material.body.version })
        .expect(200);

      // The record carries kilos, which are no longer the measure it is priced in. It must
      // still read — the review found this answering 500 from the kernel throwing.
      const reread = await as(ctx.http, accountant)
        .get(`/api/v1/damages/${created.body.id}`)
        .expect(200);
      expect(reread.body.qty_kg).toBe('4.000');
      expect(reread.body.credit_prefill).toBeNull();

      const list = await as(ctx.http, accountant).get('/api/v1/damages').expect(200);
      expect(list.body.total).toBe(1);

      // …and an edit that gives the measure the material is now priced in values it again:
      // 3 pieces × 700 د.ع. Nothing had to be voided to recover from the re-classification.
      const edited = await as(ctx.http, warehouse)
        .patch(`/api/v1/damages/${created.body.id}`)
        .send({ version: reread.body.version, qty_count: 3, qty_kg: null })
        .expect(200);
      expect(edited.body.cost).toMatchObject({ est_value_iqd: 2_100, est_value_source: 'month' });
      expect(edited.body.credit_prefill?.amount_iqd).toBe(17_700);
    });
  });

  // ─────────────────────────── the list, its filters and totals (FR-807) ───────────────────────────

  describe('the list, its filters and its period totals (FR-801, FR-807)', () => {
    beforeEach(async () => {
      await recordDamage(warehouse, {
        attribution: 'company',
        company_id: alNoor,
        is_returnable: true,
      }).expect(201);
      await recordDamage(warehouse, { attribution: 'customer_order', order_id: order }).expect(201);
      await recordDamage(admin, {
        item_id: plates,
        qty_count: 2,
        qty_kg: null,
        attribution: 'us',
      }).expect(201);
    });

    it('totals the quantities and the value over the whole filter, not the page', async () => {
      const list = await as(ctx.http, accountant).get('/api/v1/damages?page_size=1').expect(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.total).toBe(3);
      // 4 kg + 4 kg of copper, 2 plates; 2,800 + 2,800 + 30,000 د.ع.
      expect(list.body.totals).toMatchObject({ records: 3, qty_kg: '8.000', qty_count: 2 });
      expect(list.body.totals.cost).toMatchObject({ est_value_iqd: 35_600 });
    });

    it('filters by material, attribution, return status and employee', async () => {
      const byItem = await as(ctx.http, accountant)
        .get(`/api/v1/damages?item_id=${plates}`)
        .expect(200);
      expect(byItem.body.total).toBe(1);

      const byAttribution = await as(ctx.http, accountant)
        .get('/api/v1/damages?attribution=company')
        .expect(200);
      expect(byAttribution.body.total).toBe(1);

      const pending = await as(ctx.http, accountant)
        .get('/api/v1/damages?return_status=pending')
        .expect(200);
      expect(pending.body.total).toBe(1);

      const byEmployee = await as(ctx.http, accountant)
        .get(`/api/v1/damages?done_by=${warehouseUserId}`)
        .expect(200);
      expect(byEmployee.body.total).toBe(2);
    });

    it('lists what a purchase and an order have had damaged, for the links on their pages', async () => {
      const ofOrder = await as(ctx.http, accountant)
        .get(`/api/v1/damages?order_id=${order}`)
        .expect(200);
      expect(ofOrder.body.total).toBe(1);

      const ofCompany = await as(ctx.http, accountant)
        .get(`/api/v1/damages?company_id=${alNoor}`)
        .expect(200);
      expect(ofCompany.body.total).toBe(1);
    });

    it('hides voided records unless they are asked for', async () => {
      const list = await as(ctx.http, accountant).get('/api/v1/damages').expect(200);
      const first = list.body.items[0];
      await as(ctx.http, admin)
        .post(`/api/v1/damages/${first.id}/void`)
        .send({ reason: 'duplicate' })
        .expect(200);

      expect((await as(ctx.http, accountant).get('/api/v1/damages').expect(200)).body.total).toBe(
        2,
      );
      expect(
        (await as(ctx.http, accountant).get('/api/v1/damages?include_void=true').expect(200)).body
          .total,
      ).toBe(3);
    });

    it('keeps quantities and hides values for a user without the bought-price flag (FR-807)', async () => {
      const list = await as(ctx.http, noMoney).get('/api/v1/damages').expect(200);
      expect(list.body.total).toBe(3);
      // The newest record is the per-piece one, so the weight is read off the copper row.
      const copperRow = list.body.items.find((row: { item_id: string }) => row.item_id === copper);
      expect(copperRow.qty_kg).toBe('4.000');
      expect(copperRow.item_name).toBe('Copper wire 2 mm');
      expect('cost' in copperRow).toBe(false);
      expect('cost' in list.body.totals).toBe(false);
      // The quantities of the period survive; only the money is gone.
      expect(list.body.totals.qty_kg).toBe('8.000');
    });
  });
});

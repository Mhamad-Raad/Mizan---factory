import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
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
 * Materials, monthly prices and stock (FR-301 to FR-309, FR-1106).
 *
 * Every figure asserted here is a sum over `stock_ledger` or a stored price pair — never a
 * column somebody could edit — and every write is checked to have left its row in History.
 */
describe('materials, prices and stock (FR-301 to FR-309)', () => {
  let ctx: TestApp;
  let admin: Session;
  /** A warehouse employee: may see and set prices and record opening stock. */
  let warehouse: Session;
  /** A sales employee: may see materials and sale prices, but never a bought price. */
  let sales: Session;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase();
    const adminUser = await seedUser({ username: 'admin.materials', role: 'admin', displayName: 'Dara' });
    const warehouseUser = await seedUser({
      username: 'warehouse',
      displayName: 'Sara',
      permissions: ['materials.create', 'materials.edit', 'materials.set_prices', 'materials.opening_stock'],
    });
    const salesUser = await seedUser({
      username: 'sales.materials',
      displayName: 'Rebaz',
      permissions: ['materials.view'],
    });

    admin = await signIn(ctx.http, adminUser);
    warehouse = await signIn(ctx.http, warehouseUser);
    sales = await signIn(ctx.http, salesUser);

    // Step 1 of the demo script: the global rate, without which no amount can be stored.
    await as(ctx.http, admin).post('/api/v1/settings/global-rates').send({ rate_iqd_per_usd: '1310' }).expect(201);
  });

  async function createMaterial(
    session: Session,
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; version: number }> {
    const response = await as(ctx.http, session)
      .post('/api/v1/items')
      .send({ name: 'Copper wire 2 mm', pricing_unit: 'per_kg', ...body })
      .expect(201);
    return { id: response.body.id, version: response.body.version };
  }

  describe('the material record (FR-301, FR-302)', () => {
    it('creates a material, derives its stock as zero and logs the creation', async () => {
      const response = await as(ctx.http, warehouse)
        .post('/api/v1/items')
        .send({ name: 'Steel sheet 1.2 mm', pricing_unit: 'per_piece', notes: 'galvanised' })
        .expect(201);

      expect(response.body).toMatchObject({
        name: 'Steel sheet 1.2 mm',
        pricing_unit: 'per_piece',
        is_active: true,
        sale: null,
        bought: null,
        first_bought_on: null,
        last_sold_on: null,
      });
      expect(response.body.stock).toMatchObject({
        stock_count: 0,
        priced_measure: 'count',
        priced_quantity: '0',
        priced_complete: true,
      });

      const audit = await auditRows({ action: 'create', entityId: response.body.id });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ entity_type: 'item', entity_label: 'Material: Steel sheet 1.2 mm' });
    });

    it('refuses a name that already exists, whichever keyboard typed it (FR-301, FR-1205)', async () => {
      await createMaterial(warehouse, { name: 'کەرەستەی مس' });

      const clash = await as(ctx.http, warehouse)
        .post('/api/v1/items')
        .send({ name: 'كەرەستەی مس', pricing_unit: 'per_kg' })
        .expect(422);

      expect(clash.body.error.fields[0]).toMatchObject({ path: 'name', code: 'DUPLICATE_NAME' });
    });

    it('lets an admin change the pricing unit of a material that has moved, but not an employee', async () => {
      const material = await createMaterial(warehouse);
      await as(ctx.http, warehouse)
        .post(`/api/v1/items/${material.id}/opening-stock`)
        .send({ entry_date: '2026-09-01', qty_kg: '100.000', note: 'go-live count' })
        .expect(201);

      const current = await as(ctx.http, warehouse).get(`/api/v1/items/${material.id}`).expect(200);

      await as(ctx.http, warehouse)
        .patch(`/api/v1/items/${material.id}`)
        .send({ pricing_unit: 'per_piece', version: current.body.version })
        .expect(403);

      const changed = await as(ctx.http, admin)
        .patch(`/api/v1/items/${material.id}`)
        .send({ pricing_unit: 'per_piece', version: current.body.version })
        .expect(200);
      expect(changed.body.pricing_unit).toBe('per_piece');

      const audit = await auditRows({ action: 'update', entityId: material.id });
      expect(audit.at(-1)?.changes).toMatchObject({ pricing_unit: { old: 'per_kg', new: 'per_piece' } });
    });

    it('refuses a stale version rather than overwriting another edit (spec 2.9.5)', async () => {
      const material = await createMaterial(warehouse);
      await as(ctx.http, warehouse)
        .patch(`/api/v1/items/${material.id}`)
        .send({ notes: 'first', version: material.version })
        .expect(200);

      const conflict = await as(ctx.http, warehouse)
        .patch(`/api/v1/items/${material.id}`)
        .send({ notes: 'second', version: material.version })
        .expect(409);
      expect(conflict.body.error.code).toBe('VERSION_CONFLICT');
    });

    it('deactivates instead of deleting, and hides a deactivated material from the default list', async () => {
      const material = await createMaterial(warehouse);
      await as(ctx.http, warehouse)
        .post(`/api/v1/items/${material.id}/deactivate`)
        .send({ version: material.version })
        .expect(200);

      const list = await as(ctx.http, sales).get('/api/v1/items').expect(200);
      expect(list.body.items).toHaveLength(0);

      const withInactive = await as(ctx.http, sales).get('/api/v1/items?include_inactive=true').expect(200);
      expect(withInactive.body.items[0]).toMatchObject({ id: material.id, is_active: false });
    });

    it('refuses the admin delete once a material has movements (FR-309, A-32)', async () => {
      const material = await createMaterial(warehouse);
      await as(ctx.http, warehouse)
        .post(`/api/v1/items/${material.id}/opening-stock`)
        .send({ entry_date: '2026-09-01', qty_kg: '10.000', note: 'go-live' })
        .expect(201);

      const current = await as(ctx.http, admin).get(`/api/v1/items/${material.id}`).expect(200);
      const refused = await as(ctx.http, admin)
        .delete(`/api/v1/items/${material.id}`)
        .send({ version: current.body.version })
        .expect(422);
      expect(refused.body.error.fields[0].code).toBe('REFERENCED');
    });
  });

  describe('monthly prices (FR-305, FR-306)', () => {
    it('stores the pair the user typed with the rate that filled the other side', async () => {
      const material = await createMaterial(warehouse);

      const saved = await as(ctx.http, warehouse)
        .put(`/api/v1/items/${material.id}/prices/2026-09`)
        .send({
          bought: { amount: 5_200, currency: 'IQD' },
          sale: { amount: 6_500, currency: 'IQD' },
          note: "September's prices",
        })
        .expect(200);

      expect(saved.body.sale).toEqual({
        amount_iqd: 6_500,
        amount_usd_cents: 496,
        entered_currency: 'IQD',
        rate_iqd_per_usd: '1310.0000',
      });
      expect(saved.body.bought.amount_usd_cents).toBe(397);

      const audit = await auditRows({ action: 'price_change', entityId: material.id });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.changes).toMatchObject({
        sale: { old: null, new: { iqd: 6_500, usd_cents: 496 } },
      });
    });

    it('keeps the side that was not sent, instead of erasing it', async () => {
      const material = await createMaterial(warehouse);
      await as(ctx.http, warehouse)
        .put(`/api/v1/items/${material.id}/prices/2026-09`)
        .send({ bought: { amount: 5_200, currency: 'IQD' }, sale: { amount: 6_500, currency: 'IQD' } })
        .expect(200);

      const current = await as(ctx.http, warehouse).get(`/api/v1/items/${material.id}/prices`).expect(200);
      const updated = await as(ctx.http, warehouse)
        .put(`/api/v1/items/${material.id}/prices/2026-09`)
        .send({ sale: { amount: 6_800, currency: 'IQD' }, version: current.body.items[0].version })
        .expect(200);

      expect(updated.body.sale.amount_iqd).toBe(6_800);
      expect(updated.body.bought.amount_iqd).toBe(5_200);
    });

    it('carries an earlier month forward quietly, naming the month it came from (FR-306)', async () => {
      const material = await createMaterial(warehouse);
      await as(ctx.http, warehouse)
        .put(`/api/v1/items/${material.id}/prices/2026-01`)
        .send({ sale: { amount: 6_200, currency: 'IQD' } })
        .expect(200);

      const detail = await as(ctx.http, warehouse).get(`/api/v1/items/${material.id}`).expect(200);
      expect(detail.body.sale).toMatchObject({ amount_iqd: 6_200, from_month: '2026-01-01', source: 'fallback' });
    });

    it('copies one month to another for every material, logging each one', async () => {
      const copper = await createMaterial(warehouse, { name: 'Copper wire 2 mm' });
      const steel = await createMaterial(warehouse, { name: 'Steel sheet', pricing_unit: 'per_piece' });
      await as(ctx.http, warehouse)
        .put(`/api/v1/items/${copper.id}/prices/2026-08`)
        .send({ sale: { amount: 6_200, currency: 'IQD' }, bought: { amount: 5_000, currency: 'IQD' } })
        .expect(200);

      const result = await as(ctx.http, warehouse)
        .post('/api/v1/items/prices/copy-month')
        .send({ source_month: '2026-08', target_month: '2026-09' })
        .expect(201);

      // Copper had August prices, steel had none: one copied, one skipped.
      expect(result.body).toEqual({ copied: 1, skipped: 1 });

      const prices = await as(ctx.http, warehouse).get(`/api/v1/items/${copper.id}/prices`).expect(200);
      expect(prices.body.items.map((row: { month: string }) => row.month)).toEqual(['2026-09-01', '2026-08-01']);
      expect(await auditRows({ action: 'price_change', entityId: steel.id })).toHaveLength(0);
    });

    it('hides bought prices from an employee without the field flag (FR-103, FR-305)', async () => {
      const material = await createMaterial(warehouse);
      await as(ctx.http, warehouse)
        .put(`/api/v1/items/${material.id}/prices/2026-09`)
        .send({ bought: { amount: 5_200, currency: 'IQD' }, sale: { amount: 6_500, currency: 'IQD' } })
        .expect(200);

      const detail = await as(ctx.http, sales).get(`/api/v1/items/${material.id}`).expect(200);
      expect(detail.body.sale.amount_iqd).toBe(6_500);
      expect('bought' in detail.body).toBe(false);

      const prices = await as(ctx.http, sales).get(`/api/v1/items/${material.id}/prices`).expect(200);
      expect('bought' in prices.body.items[0]).toBe(false);

      const list = await as(ctx.http, sales).get('/api/v1/items').expect(200);
      expect('bought' in list.body.items[0]).toBe(false);

      // Setting a price needs the flag through implication, so this employee cannot try.
      await as(ctx.http, sales)
        .put(`/api/v1/items/${material.id}/prices/2026-09`)
        .send({ sale: { amount: 1, currency: 'IQD' } })
        .expect(403);
    });

    it('refuses a price edit for a month the period lock has closed (FR-1109)', async () => {
      const material = await createMaterial(warehouse);
      await as(ctx.http, admin).patch('/api/v1/settings').send({ locked_through: '2026-08-31' }).expect(200);

      const refused = await as(ctx.http, warehouse)
        .put(`/api/v1/items/${material.id}/prices/2026-08`)
        .send({ sale: { amount: 6_200, currency: 'IQD' } })
        .expect(409);
      expect(refused.body.error.code).toBe('PERIOD_LOCKED');

      // September has not ended, so its prices are still open.
      await as(ctx.http, warehouse)
        .put(`/api/v1/items/${material.id}/prices/2026-09`)
        .send({ sale: { amount: 6_500, currency: 'IQD' } })
        .expect(200);
    });
  });

  describe('stock (FR-303, FR-308)', () => {
    it('records opening stock as a movement with its note, and derives the stock from it', async () => {
      const material = await createMaterial(warehouse);

      const after = await as(ctx.http, warehouse)
        .post(`/api/v1/items/${material.id}/opening-stock`)
        .send({
          entry_date: '2026-09-01',
          qty_kg: '240.500',
          unit_cost: { amount: 5_000, currency: 'IQD' },
          note: 'counted at go-live',
        })
        .expect(201);

      expect(after.body.stock).toMatchObject({
        stock_kg: '240.500',
        priced_quantity: '240.500',
        kg_complete: true,
      });
      expect(after.body.first_bought_on).toBe('2026-09-01');

      const movements = await as(ctx.http, warehouse).get(`/api/v1/items/${material.id}/movements`).expect(200);
      expect(movements.body.items[0]).toMatchObject({
        movement_type: 'opening',
        qty_kg: '240.500',
        note: 'counted at go-live',
        performed_by: 'Sara',
        is_live: true,
      });

      const audit = await auditRows({ entityId: material.id });
      expect(audit.at(-1)?.note).toBe('counted at go-live');
    });

    it('corrects stock with an adjustment movement rather than an edit', async () => {
      const material = await createMaterial(warehouse);
      await as(ctx.http, warehouse)
        .post(`/api/v1/items/${material.id}/opening-stock`)
        .send({ entry_date: '2026-09-01', qty_kg: '240.500', note: 'go-live' })
        .expect(201);

      const corrected = await as(ctx.http, warehouse)
        .post(`/api/v1/items/${material.id}/stock-adjustments`)
        .send({ entry_date: '2026-09-18', qty_kg: '-0.500', note: 'spillage' })
        .expect(201);

      expect(corrected.body.stock.stock_kg).toBe('240.000');
      const movements = await as(ctx.http, warehouse).get(`/api/v1/items/${material.id}/movements`).expect(200);
      expect(movements.body.total).toBe(2);
    });

    it('shows the other measure as incomplete once a movement did not carry it (FR-303)', async () => {
      const material = await createMaterial(warehouse, { name: 'Steel sheet', pricing_unit: 'per_piece' });
      await as(ctx.http, warehouse)
        .post(`/api/v1/items/${material.id}/opening-stock`)
        .send({ entry_date: '2026-09-01', qty_count: 40, qty_kg: '96.000', note: 'go-live' })
        .expect(201);
      await as(ctx.http, warehouse)
        .post(`/api/v1/items/${material.id}/stock-adjustments`)
        .send({ entry_date: '2026-09-02', qty_count: -5, note: 'recount' })
        .expect(201);

      const detail = await as(ctx.http, warehouse).get(`/api/v1/items/${material.id}`).expect(200);
      expect(detail.body.stock).toMatchObject({
        stock_count: 35,
        count_complete: true,
        kg_complete: false,
        priced_quantity: '35',
      });
    });

    it('refuses an opening entry in a locked period and one dated in the future', async () => {
      const material = await createMaterial(warehouse);
      await as(ctx.http, admin).patch('/api/v1/settings').send({ locked_through: '2026-09-30' }).expect(200);

      const locked = await as(ctx.http, warehouse)
        .post(`/api/v1/items/${material.id}/opening-stock`)
        .send({ entry_date: '2026-09-01', qty_kg: '1.000', note: 'late' })
        .expect(409);
      expect(locked.body.error.code).toBe('PERIOD_LOCKED');

      const future = await as(ctx.http, warehouse)
        .post(`/api/v1/items/${material.id}/opening-stock`)
        .send({ entry_date: '2099-01-01', qty_kg: '1.000', note: 'later' })
        .expect(422);
      expect(future.body.error.fields[0].code).toBe('FUTURE_DATE');
    });

    it('never lets the application update or delete a stock movement (rule 2)', async () => {
      const material = await createMaterial(warehouse);
      await as(ctx.http, warehouse)
        .post(`/api/v1/items/${material.id}/opening-stock`)
        .send({ entry_date: '2026-09-01', qty_kg: '1.000', note: 'go-live' })
        .expect(201);

      const client = new Client({ connectionString: TEST_DATABASE_URL });
      await client.connect();
      try {
        await expect(client.query('UPDATE stock_ledger SET qty_kg = 999')).rejects.toThrow(
          /permission denied/i,
        );
        await expect(client.query('DELETE FROM stock_ledger')).rejects.toThrow(/permission denied/i);
      } finally {
        await client.end();
      }

      const detail = await as(ctx.http, warehouse).get(`/api/v1/items/${material.id}`).expect(200);
      expect(detail.body.stock.stock_kg).toBe('1.000');
    });
  });

  describe('the global rate (FR-1106)', () => {
    it('keeps a history and marks the current rate', async () => {
      await as(ctx.http, admin)
        .post('/api/v1/settings/global-rates')
        .send({ rate_iqd_per_usd: '1320', note: 'market moved' })
        .expect(201);

      const history = await as(ctx.http, sales).get('/api/v1/settings/global-rates').expect(200);
      expect(history.body.current.rate_iqd_per_usd).toBe('1320.0000');
      expect(history.body.items).toHaveLength(2);
      expect(history.body.items[0]).toMatchObject({ note: 'market moved', created_by_name: 'Dara' });
    });

    it('asks for confirmation before a change beyond the guard, then accepts it', async () => {
      const guarded = await as(ctx.http, admin)
        .post('/api/v1/settings/global-rates')
        .send({ rate_iqd_per_usd: '13100' })
        .expect(422);
      expect(guarded.body.error.code).toBe('RATE_GUARD');
      expect(guarded.body.error.params).toMatchObject({ previous: '1310.0000', next: '13100.0000' });

      await as(ctx.http, admin)
        .post('/api/v1/settings/global-rates')
        .send({ rate_iqd_per_usd: '13100', confirm: true })
        .expect(201);
    });

    it('refuses to store a price before any rate exists, instead of inventing one', async () => {
      await withDatabase((client) => client.query('DELETE FROM global_rates'));
      const material = await createMaterial(warehouse);

      const refused = await as(ctx.http, warehouse)
        .put(`/api/v1/items/${material.id}/prices/2026-09`)
        .send({ sale: { amount: 6_500, currency: 'IQD' } })
        .expect(422);
      expect(refused.body.error.fields[0].code).toBe('NO_GLOBAL_RATE');
    });
  });
});

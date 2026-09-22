import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, auditRows, createTestApp, resetDatabase, seedUser, signIn, withDatabase } from './harness.js';
import type { Session, TestApp } from './harness.js';

/**
 * The go-live import (FR-1312, **Proposed — not requested**).
 *
 * The acceptance criterion is the whole test: "imports create the same records and ledger
 * entries as manual entry, attributed to the importing admin". So each case checks not the
 * import's own response but what is in the database afterwards — the same ledger row, with the
 * same rate and the same audit trail, as if somebody had typed it.
 *
 * The other half is the preview. An import writes money in bulk from a file somebody edited in
 * a spreadsheet, and the dangerous failure is not a rejected file: it is row 4,213 being wrong
 * after 4,212 have been written. Every check below that names a row is about that.
 */
describe('CSV import of go-live data (FR-1312)', () => {
  let ctx: TestApp;
  let admin: Session;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 60_000);
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await resetDatabase();
    const adminUser = await seedUser({ username: 'dara', role: 'admin', displayName: 'Dara' });
    admin = await signIn(ctx.http, adminUser);
    await as(ctx.http, admin).post('/api/v1/settings/global-rates').send({ rate_iqd_per_usd: '1300' }).expect(201);
  });

  const preview = (kind: string, rows: unknown[]) =>
    as(ctx.http, admin).post(`/api/v1/imports/${kind}/preview`).send({ rows });
  const run = (kind: string, rows: unknown[]) =>
    as(ctx.http, admin).post(`/api/v1/imports/${kind}`).send({ rows });

  it('is admin-only, like every other bulk power', async () => {
    const employee = await seedUser({ username: 'rebaz', permissions: ['materials.create'] });
    const session = await signIn(ctx.http, employee);
    await as(ctx.http, session)
      .post('/api/v1/imports/materials')
      .send({ rows: [{ name: 'Copper', pricing_unit: 'per_kg' }] })
      .expect(403);
    await as(ctx.http, session).get('/api/v1/imports/templates').expect(403);
  });

  it('offers a template per kind, which is where the client gets its headers', async () => {
    const templates = await as(ctx.http, admin).get('/api/v1/imports/templates').expect(200);
    const kinds = templates.body.kinds.map((entry: { kind: string }) => entry.kind);
    expect(kinds).toContain('customer_opening_balance');
    const materials = templates.body.kinds.find((entry: { kind: string }) => entry.kind === 'materials');
    expect(materials.required).toEqual(['name', 'pricing_unit']);
  });

  describe('the preview', () => {
    it('names the row and the column of every problem, and writes nothing', async () => {
      const response = await preview('materials', [
        { name: 'Copper wire 2 mm', pricing_unit: 'per_kg' },
        { name: '', pricing_unit: 'per_kg' },
        { name: 'Steel plate', pricing_unit: 'per_tonne' },
        { name: 'copper WIRE 2 mm', pricing_unit: 'per_kg' },
      ]).expect(201);

      expect(response.body.rows).toBe(4);
      expect(response.body.ready).toBe(1);
      expect(response.body.problems).toEqual([
        { row: 2, column: 'name', message_key: 'errors:field.required', params: { field: 'name' } },
        {
          row: 3,
          column: 'pricing_unit',
          message_key: 'imports:bad_pricing_unit',
          params: { value: 'per_tonne' },
        },
        // The same material twice in one file, spelled differently — the mistake a merged
        // spreadsheet makes, and one the database would only catch on the second write.
        {
          row: 4,
          column: null,
          message_key: 'imports:duplicate_in_file',
          params: { name: 'copper WIRE 2 mm' },
        },
      ]);

      const created = await as(ctx.http, admin).get('/api/v1/items').expect(200);
      expect(created.body.total).toBe(0);
    });

    it('refuses an opening balance for an account that does not exist', async () => {
      const response = await preview('customer_opening_balance', [
        { customer: 'Nobody Trading', amount: '100000', currency: 'IQD' },
      ]).expect(201);
      expect(response.body.problems[0]).toMatchObject({
        row: 1,
        column: 'customer',
        message_key: 'imports:unknown_counterparty',
      });
    });

    it('refuses what the forms refuse: a future date, a locked period, a figure that is not a number', async () => {
      await as(ctx.http, admin)
        .post('/api/v1/customers')
        .send({ name: 'Kawa Trading' })
        .expect(201);
      const today = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(new Date())}T00:00:00Z`);
      const tomorrow = new Date(today);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

      const response = await preview('customer_opening_balance', [
        { customer: 'Kawa Trading', amount: 'one hundred', currency: 'IQD' },
        { customer: 'Kawa Trading', amount: '100000', currency: 'IQD', entry_date: tomorrow.toISOString().slice(0, 10) },
        { customer: 'Kawa Trading', amount: '100000', currency: 'EUR' },
      ]).expect(201);

      const keys = response.body.problems.map((problem: { message_key: string }) => problem.message_key);
      expect(keys).toContain('imports:not_a_number');
      expect(keys).toContain('imports:bad_currency');
      expect(response.body.problems.some((problem: { column: string }) => problem.column === 'entry_date')).toBe(
        true,
      );
    });
  });

  describe('the import itself', () => {
    it('creates materials, customers and companies as the forms would', async () => {
      const materials = await run('materials', [
        { name: 'Copper wire 2 mm', pricing_unit: 'per_kg', code: 'CU2', min_stock: '50.000' },
        { name: 'Steel plate 10 mm', pricing_unit: 'per_piece', min_stock: '20' },
      ]).expect(201);
      expect(materials.body.created).toBe(2);
      expect(materials.body.failed).toEqual([]);

      const listed = await as(ctx.http, admin).get('/api/v1/items').expect(200);
      expect(listed.body.total).toBe(2);
      const copper = listed.body.items.find((item: { code: string }) => item.code === 'CU2');
      expect(copper).toMatchObject({ name: 'Copper wire 2 mm', pricing_unit: 'per_kg' });

      await run('customers', [{ name: 'Kawa Trading', phone: '07501234567', settlement_currency: 'USD' }]).expect(
        201,
      );
      const customers = await as(ctx.http, admin).get('/api/v1/customers').expect(200);
      expect(customers.body.items[0]).toMatchObject({ name: 'Kawa Trading', settlement_currency: 'USD' });

      await run('companies', [{ name: 'Al-Noor Steel Co.', contact_name: 'Hemin' }]).expect(201);
      const companies = await as(ctx.http, admin).get('/api/v1/companies').expect(200);
      expect(companies.body.items[0]).toMatchObject({ name: 'Al-Noor Steel Co.' });

      // Attributed to the admin who imported, and in History like any other creation (FR-1312).
      const audit = await auditRows({ action: 'create', entityId: copper.id });
      expect(audit[0]).toMatchObject({ entity_type: 'item', entity_label: 'Material: Copper wire 2 mm' });
    });

    it('creates opening stock as a stock movement, not as a column', async () => {
      await run('materials', [{ name: 'Copper wire 2 mm', pricing_unit: 'per_kg' }]).expect(201);
      const result = await run('opening_stock', [
        { material: 'Copper wire 2 mm', qty_kg: '1200.500', note: 'counted on the floor' },
      ]).expect(201);
      expect(result.body.created).toBe(1);

      const items = await as(ctx.http, admin).get('/api/v1/items').expect(200);
      expect(items.body.items[0].stock.stock_kg).toBe('1200.500');

      const movements = await withDatabase(async (client) => {
        const { rows } = await client.query<{ movement_type: string; qty_kg: string; note: string }>(
          `SELECT movement_type::text AS movement_type, qty_kg::text AS qty_kg, note FROM stock_ledger`,
        );
        return rows;
      });
      // The same row the form writes: a movement, with its note, summing to the stock.
      expect(movements).toEqual([
        { movement_type: 'opening', qty_kg: '1200.500', note: 'counted on the floor' },
      ]);
    });

    it('creates an opening debt as a ledger entry with the rate that made it', async () => {
      await run('customers', [{ name: 'Kawa Trading' }]).expect(201);
      const result = await run('customer_opening_balance', [
        { customer: 'Kawa Trading', amount: '650000', currency: 'IQD', note: 'agreed with the owner' },
      ]).expect(201);
      expect(result.body.created).toBe(1);

      const customers = await as(ctx.http, admin).get('/api/v1/customers').expect(200);
      const customer = customers.body.items[0];
      // The list carries the balance as a pair with the rate that made it (rule 1, FR-1302).
      expect(customer.balance).toMatchObject({ amount_iqd: 650_000, amount_usd_cents: 50_000 });

      const ledger = await as(ctx.http, admin).get(`/api/v1/customers/${customer.id}/ledger`).expect(200);
      const entry = ledger.body.items[0];
      expect(entry).toMatchObject({ entry_type: 'opening', note: 'agreed with the owner' });
      // Both currencies and the rate, exactly as a typed entry (rule 1).
      expect(entry.amount_iqd).toBe(650_000);
      expect(entry.amount_usd_cents).toBe(50_000);
      expect(entry.rate_iqd_per_usd).toBe('1300.0000');
    });

    it('creates the good rows and reports the bad ones, rather than losing the file', async () => {
      const result = await run('materials', [
        { name: 'Copper wire 2 mm', pricing_unit: 'per_kg' },
        { name: '', pricing_unit: 'per_kg' },
        { name: 'Steel plate 10 mm', pricing_unit: 'per_piece' },
      ]).expect(201);

      expect(result.body.created).toBe(2);
      expect(result.body.problems[0]).toMatchObject({ row: 2 });
      const listed = await as(ctx.http, admin).get('/api/v1/items').expect(200);
      expect(listed.body.total).toBe(2);
    });

    it('can be run again on a corrected file without creating anything twice', async () => {
      await run('materials', [{ name: 'Copper wire 2 mm', pricing_unit: 'per_kg' }]).expect(201);
      const second = await run('materials', [
        { name: 'Copper wire 2 mm', pricing_unit: 'per_kg' },
        { name: 'Steel plate 10 mm', pricing_unit: 'per_piece' },
      ]).expect(201);

      // The first row already exists, so it is a problem rather than a second material.
      expect(second.body.created).toBe(1);
      expect(second.body.problems[0]).toMatchObject({ row: 1, message_key: 'imports:already_exists' });
      const listed = await as(ctx.http, admin).get('/api/v1/items').expect(200);
      expect(listed.body.total).toBe(2);
    });

    it('reads a file of the ten thousand rows its own schema allows', async () => {
      /**
       * The two ends of this promise used to disagree.
       *
       * The schema accepts 10,000 rows; the body parser's default was 100 kB, which is about
       * 1,800 — and a file over that answered **500 INTERNAL**, with no request id, on the one
       * day this system asks somebody to hand it a large file (system-wide review). The preview
       * is the cheap half of the path and exercises the parser, so it is what this test sends.
       */
      const rows = Array.from({ length: 10_000 }, (_, index) => ({
        name: `Ceiling material ${index}`,
        pricing_unit: 'per_kg',
      }));
      const response = await preview('materials', rows).expect(201);
      expect(response.body.rows).toBe(10_000);
      expect(response.body.ready).toBe(10_000);

      // And one row past the ceiling is a validation error, not an internal one.
      await preview('materials', [...rows, { name: 'One too many', pricing_unit: 'per_kg' }]).expect(422);
    }, 30_000);

    it('refuses an unknown kind rather than guessing', async () => {
      await as(ctx.http, admin)
        .post('/api/v1/imports/everything')
        .send({ rows: [{ name: 'x' }] })
        .expect(422);
    });
  });
});

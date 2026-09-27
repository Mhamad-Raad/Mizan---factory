import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTestApp, resetDatabase, seedUser, signIn, withDatabase } from './harness.js';
import type { Session, TestApp } from './harness.js';

/**
 * Inputs that used to reach PostgreSQL and come back as "something went wrong on our side"
 * (security review, finding 16): a record id that is not an id, a negative price, a search that
 * was a pattern. Each now gets an answer that says what is wrong.
 */
describe('inputs the API reads before the database does', () => {
  let ctx: TestApp;
  let admin: Session;
  const someId = '00000000-0000-4000-8000-000000000000';

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await resetDatabase();
    admin = await signIn(ctx.http, await seedUser({ username: 'sara', role: 'admin' }));
  });

  it('answers a malformed record id with 404 and says the link is wrong', async () => {
    for (const url of ['/api/v1/orders/abc', '/api/v1/customers/1', '/api/v1/damages/%27']) {
      const response = await as(ctx.http, admin).get(url);
      expect(response.status).toBe(404);
    }
    const response = await as(ctx.http, admin).get('/api/v1/orders/not-an-id').expect(404);
    expect(response.body.error).toMatchObject({ code: 'NOT_FOUND', message_key: 'errors:malformed_id' });
    await as(ctx.http, admin).get(`/api/v1/customers/${someId}/ledger/not-an-entry/voucher`).expect(404);
    // A well-formed id that names nothing is still the ordinary "not found".
    const missing = await as(ctx.http, admin).get(`/api/v1/orders/${someId}`).expect(404);
    expect(missing.body.error.message_key).toBe('errors:NOT_FOUND');
  });

  it('still refuses a caller without access before looking at the id', async () => {
    const clerk = await signIn(ctx.http, await seedUser({ username: 'rebaz', permissions: ['materials.view'] }));
    await as(ctx.http, clerk).get('/api/v1/orders/not-an-id').expect(403);
  });

  it('refuses a negative price or discount with the field named, not with a 500', async () => {
    const line = { item_id: someId, qty_count: 1, unit_price: { amount: -100, currency: 'IQD' } };
    const purchase = await as(ctx.http, admin)
      .post('/api/v1/purchases')
      .send({ company_id: null, purchase_date: '2026-01-01', lines: [line] })
      .expect(422);
    expect(purchase.body.error.fields[0]).toMatchObject({
      path: 'lines.0.unit_price.amount',
      message_key: 'errors:field.number_too_small',
      params: { min: 0 },
    });

    const order = await as(ctx.http, admin)
      .post('/api/v1/orders')
      .send({
        customer_id: someId,
        order_date: '2026-01-01',
        payment_type: 'borrowed',
        discount: { amount: -5, currency: 'IQD' },
        lines: [{ ...line, unit_price: { amount: 100, currency: 'IQD' } }],
      })
      .expect(422);
    expect(order.body.error.fields[0]).toMatchObject({ path: 'discount.amount', message_key: 'errors:field.number_too_small' });
  });

  it('matches % and _ in a search literally', async () => {
    for (const name of ['Kawa Trading', 'Azad Steel']) {
      await as(ctx.http, admin).post('/api/v1/customers').send({ name }).expect(201);
    }
    for (const q of ['%', '_', '\\']) {
      const found = await as(ctx.http, admin).get(`/api/v1/customers?q=${encodeURIComponent(q)}`).expect(200);
      expect(found.body.items ?? found.body.rows ?? found.body).toHaveLength(0);
    }
    const kawa = await as(ctx.http, admin).get('/api/v1/customers?q=kawa').expect(200);
    expect(kawa.body.items ?? kawa.body.rows ?? kawa.body).toHaveLength(1);

    for (const q of ['%', '_']) {
      await as(ctx.http, admin).get(`/api/v1/users?q=${encodeURIComponent(q)}`).expect(200);
    }
    await as(ctx.http, admin).get(`/api/v1/users?q=${'x'.repeat(201)}`).expect(422);
  });

  it('refuses a date that does not exist as a 422 naming the field, never a failed cast (review)', async () => {
    for (const url of ['/api/v1/accounts/summary?from=2026-02-30', '/api/v1/history?to=2025-13-01']) {
      const response = await as(ctx.http, admin).get(url).expect(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    }
    await as(ctx.http, admin)
      .post('/api/v1/expenses')
      .send({ title: 'Rent', amount: { amount: 100_000, currency: 'IQD' }, expense_date: '2025-02-30' })
      .expect(422);
  });

  it('reads a History filter it cannot use as nothing found or a 422, never a 500 (review)', async () => {
    const unknown = await as(ctx.http, admin).get('/api/v1/history?action=no_such_action').expect(200);
    expect(unknown.body.items).toHaveLength(0);
    await as(ctx.http, admin).get('/api/v1/history?cursor=yesterday|1').expect(422);
  });

  it('pages History without skipping the rows one transaction wrote together (review)', async () => {
    // Five records' rows stamped with one transaction's now(): a page may end among them.
    await withDatabase(async (client) => {
      await client.query('BEGIN');
      for (let n = 0; n < 5; n += 1) {
        await client.query(
          `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, entity_label, changes, related, request_id)
           SELECT id, 'update', 'cursor_test', $1, 'Settings', '{}'::jsonb, '{}'::jsonb, gen_random_uuid()
             FROM users WHERE username = 'sara'`,
          [`record-${n}`],
        );
      }
      await client.query('COMMIT');
    });

    const everything = await as(ctx.http, admin).get('/api/v1/history?entity_type=cursor_test&limit=100').expect(200);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { body: { items: { id: string }[]; next_cursor: string | null } } = await as(ctx.http, admin)
        .get(`/api/v1/history?entity_type=cursor_test&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
        .expect(200);
      seen.push(...page.body.items.map((item) => item.id));
      cursor = page.body.next_cursor;
    } while (cursor);
    expect(seen).toEqual(everything.body.items.map((item: { id: string }) => item.id));
    expect(seen).toHaveLength(5);
  });
});


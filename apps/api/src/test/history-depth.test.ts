import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createTestApp, resetDatabase, seedUser, signIn } from './harness.js';
import type { Session, TestApp } from './harness.js';

/**
 * The History page in full (FR-902, FR-903, spec 2.4.5).
 *
 * Iteration 0 delivered the list with "done by" and the date presets; this is what iteration 4
 * adds, and what the acceptance criteria ask for: the "assigned to" filter — a different
 * question from "done by", and the two return different sets over the same records — the
 * entity filters, and the grouping of an edit storm into one expandable entry.
 */
describe('history depth (FR-902, FR-903)', () => {
  let ctx: TestApp;
  let admin: Session;
  let rebaz: Session;
  let sara: Session;
  let rebazId: string;
  let saraId: string;
  let copper: string;
  let kawa: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase();

    const adminUser = await seedUser({ username: 'admin.history', role: 'admin', displayName: 'Dara' });
    const rebazUser = await seedUser({
      username: 'rebaz',
      displayName: 'Rebaz',
      permissions: ['orders.create', 'orders.edit', 'history.view', 'history.view_all'],
    });
    // Sara serves everyone's customers but is assigned none of them, which is what makes
    // "done by" and "assigned to" different questions about the same order (spec 2.9.4).
    const saraUser = await seedUser({
      username: 'sara',
      displayName: 'Sara',
      permissions: ['orders.create', 'orders.edit', 'history.view', 'customers.view_all'],
    });
    rebazId = rebazUser.id;
    saraId = saraUser.id;

    admin = await signIn(ctx.http, adminUser);
    rebaz = await signIn(ctx.http, rebazUser);
    sara = await signIn(ctx.http, saraUser);

    await as(ctx.http, admin).post('/api/v1/settings/global-rates').send({ rate_iqd_per_usd: '1300' }).expect(201);

    const item = await as(ctx.http, admin)
      .post('/api/v1/items')
      .send({ name: 'Copper wire 2 mm', pricing_unit: 'per_kg' })
      .expect(201);
    copper = item.body.id;
    await as(ctx.http, admin)
      .put(`/api/v1/items/${copper}/prices/${today().slice(0, 7)}`)
      .send({ sale: { amount: 850, currency: 'IQD' }, bought: { amount: 700, currency: 'IQD' } })
      .expect(200);

    // Kawa is Rebaz's customer; Sara is the one who serves her today.
    const customer = await as(ctx.http, admin)
      .post('/api/v1/customers')
      .send({ name: 'Kawa Trading', assigned_user_id: rebazId })
      .expect(201);
    kawa = customer.body.id;
  });

  function today(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Baghdad',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  async function orderFor(session: Session) {
    return as(ctx.http, session)
      .post('/api/v1/orders')
      .send({
        customer_id: kawa,
        order_date: today(),
        payment_type: 'borrowed',
        lines: [{ item_id: copper, qty_kg: '10.000' }],
      })
      .expect(201);
  }

  it('answers two different questions with "done by" and "assigned to"', async () => {
    // Sara records an order for a customer assigned to Rebaz, which is the case that makes the
    // two filters mean different things (spec 2.9.4).
    const order = await orderFor(sara);

    const byDoer = await as(ctx.http, admin).get(`/api/v1/history?done_by=${saraId}&entity_type=order`).expect(200);
    expect(byDoer.body.items.map((row: { entity_id: string }) => row.entity_id)).toContain(order.body.id);

    const byAssignee = await as(ctx.http, admin)
      .get(`/api/v1/history?assigned_to=${rebazId}&entity_type=order`)
      .expect(200);
    expect(byAssignee.body.items.map((row: { entity_id: string }) => row.entity_id)).toContain(order.body.id);

    // The two sets are not the same question: Rebaz did nothing, and Sara is assigned nothing.
    const rebazDid = await as(ctx.http, admin).get(`/api/v1/history?done_by=${rebazId}&entity_type=order`).expect(200);
    expect(rebazDid.body.items).toHaveLength(0);
    const assignedToSara = await as(ctx.http, admin)
      .get(`/api/v1/history?assigned_to=${saraId}&entity_type=order`)
      .expect(200);
    expect(assignedToSara.body.items).toHaveLength(0);
  });

  it('collapses an edit storm into one entry that expands to the whole story (2.4.5)', async () => {
    const order = await orderFor(rebaz);

    let version = order.body.version as number;
    for (const quantity of ['12.000', '14.000', '16.000']) {
      const edited = await as(ctx.http, rebaz)
        .put(`/api/v1/orders/${order.body.id}`)
        .send({
          customer_id: kawa,
          order_date: today(),
          payment_type: 'borrowed',
          version,
          lines: [{ item_id: copper, qty_kg: quantity }],
        })
        .expect(200);
      version = edited.body.version;
    }

    const page = await as(ctx.http, rebaz).get(`/api/v1/history?entity_type=order`).expect(200);
    const entry = page.body.items[0];
    // Three edits, one entry, newest first — and the rows behind it are all there.
    expect(entry.group_size).toBe(3);
    expect(entry.rows).toHaveLength(3);
    expect(entry.action).toBe('update');
    expect(entry.changes.lines.new[0].qty_kg).toBe('16.000');
    expect(entry.rows[2].changes.lines.new[0].qty_kg).toBe('12.000');

    // The create is its own entry: only updates collapse.
    const create = page.body.items[1];
    expect(create.action).toBe('create');
    expect(create.group_size).toBe(1);
  });

  it('does not collapse edits by two different people, or of two different records', async () => {
    const first = await orderFor(rebaz);
    const second = await orderFor(rebaz);

    await as(ctx.http, rebaz)
      .put(`/api/v1/orders/${first.body.id}`)
      .send({
        customer_id: kawa,
        order_date: today(),
        payment_type: 'borrowed',
        version: first.body.version,
        lines: [{ item_id: copper, qty_kg: '11.000' }],
      })
      .expect(200);
    await as(ctx.http, admin)
      .put(`/api/v1/orders/${second.body.id}`)
      .send({
        customer_id: kawa,
        order_date: today(),
        payment_type: 'borrowed',
        version: second.body.version,
        lines: [{ item_id: copper, qty_kg: '13.000' }],
      })
      .expect(200);

    const page = await as(ctx.http, admin).get(`/api/v1/history?entity_type=order&action=update`).expect(200);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.items.every((entry: { group_size: number }) => entry.group_size === 1)).toBe(true);
  });

  it("keeps a record's own History tab ungrouped, because there the story is the point", async () => {
    const order = await orderFor(rebaz);
    await as(ctx.http, rebaz)
      .put(`/api/v1/orders/${order.body.id}`)
      .send({
        customer_id: kawa,
        order_date: today(),
        payment_type: 'borrowed',
        version: order.body.version,
        lines: [{ item_id: copper, qty_kg: '12.000' }],
      })
      .expect(200);

    const tab = await as(ctx.http, rebaz).get(`/api/v1/orders/${order.body.id}/history`).expect(200);
    const actions = tab.body.items.map((row: { action: string }) => row.action);
    expect(actions).toEqual(['update', 'create']);
  });

  it('still shows an employee without history.view_all only their own actions', async () => {
    await orderFor(rebaz);
    const own = await orderFor(sara);

    const page = await as(ctx.http, sara).get('/api/v1/history?entity_type=order').expect(200);
    expect(page.body.items.map((row: { entity_id: string }) => row.entity_id)).toEqual([own.body.id]);
  });

  it('filters to one record, which is what every History tab asks for (FR-903)', async () => {
    const order = await orderFor(rebaz);
    await orderFor(rebaz);

    const page = await as(ctx.http, rebaz)
      .get(`/api/v1/history?entity_type=order&entity_id=${order.body.id}`)
      .expect(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.items[0].entity_id).toBe(order.body.id);
  });
});

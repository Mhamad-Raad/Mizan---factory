import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, auditRows, createTestApp, resetDatabase, seedUser, signIn } from './harness.js';
import type { Session, TestApp } from './harness.js';

/**
 * Drivers (D-105): the record itself, the driver an order is sent with, and the lists that narrow
 * to one driver — the driver's own page and Buying & selling.
 */
describe('drivers (D-105)', () => {
  let ctx: TestApp;
  let admin: Session;
  let seller: Session;
  let reader: Session;
  let kawa: string;
  let bolts: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase();
    admin = await signIn(ctx.http, await seedUser({ username: 'admin.drivers', role: 'admin' }));
    // Writing orders brings reading the drivers with it, and nothing more.
    seller = await signIn(
      ctx.http,
      await seedUser({ username: 'seller', permissions: ['orders.create', 'orders.edit'] }),
    );
    reader = await signIn(
      ctx.http,
      await seedUser({ username: 'reader', permissions: ['orders.view'] }),
    );

    await as(ctx.http, admin)
      .post('/api/v1/settings/global-rates')
      .send({ rate_iqd_per_usd: '1300' })
      .expect(201);
    kawa = (
      await as(ctx.http, admin).post('/api/v1/customers').send({ name: 'Kawa Trading' }).expect(201)
    ).body.id;
    bolts = (
      await as(ctx.http, admin)
        .post('/api/v1/items')
        .send({ name: 'Bolts M8', pricing_unit: 'per_piece' })
        .expect(201)
    ).body.id;
    const month = new Date().toISOString().slice(0, 7);
    await as(ctx.http, admin)
      .put(`/api/v1/items/${bolts}/prices/${month}`)
      .send({
        sale: { amount: 2_000, currency: 'IQD' },
        bought: { amount: 1_500, currency: 'IQD' },
      })
      .expect(200);
    // Stock arrives by buying it (D-062).
    await as(ctx.http, admin)
      .post('/api/v1/purchases')
      .send({
        company_id: kawa,
        purchase_date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(
          new Date(),
        ),
        lines: [
          { item_id: bolts, qty_count: 1_000, unit_price: { amount: 1_500, currency: 'IQD' } },
        ],
      })
      .expect(201);
  });

  const newDriver = (body: Record<string, unknown>, session = admin) =>
    as(ctx.http, session).post('/api/v1/drivers').send(body);

  const sell = (body: Record<string, unknown> = {}, session = admin) =>
    as(ctx.http, session)
      .post('/api/v1/orders')
      .send({
        customer_id: kawa,
        order_date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad' }).format(
          new Date(),
        ),
        payment_type: 'borrowed',
        lines: [{ item_id: bolts, qty_count: 2 }],
        ...body,
      });

  it('adds, edits and deactivates a driver, each in History', async () => {
    const created = await newDriver({
      name: ' Azad Omar ',
      phone: '0750 123 4567',
      car_number: '12 A 3456 Erbil',
    }).expect(201);
    expect(created.body).toMatchObject({
      name: 'Azad Omar',
      phone: '0750 123 4567',
      car_number: '12 A 3456 Erbil',
      is_active: true,
    });
    const id = created.body.id as string;

    const edited = await as(ctx.http, admin)
      .patch(`/api/v1/drivers/${id}`)
      .send({ car_number: '99 B 1111 Erbil', version: created.body.version })
      .expect(200);
    expect(edited.body.car_number).toBe('99 B 1111 Erbil');

    // An old version is refused rather than written over.
    await as(ctx.http, admin)
      .patch(`/api/v1/drivers/${id}`)
      .send({ name: 'Late', version: created.body.version })
      .expect(409);

    const off = await as(ctx.http, admin)
      .post(`/api/v1/drivers/${id}/deactivate`)
      .send({ version: edited.body.version })
      .expect(200);
    expect(off.body.is_active).toBe(false);

    // Deactivated drivers leave the default list and are what the Deactivated filter shows.
    expect((await as(ctx.http, admin).get('/api/v1/drivers').expect(200)).body.total).toBe(0);
    expect(
      (await as(ctx.http, admin).get('/api/v1/drivers?status=inactive').expect(200)).body.items[0]
        .id,
    ).toBe(id);

    const rows = await auditRows({ entityId: id });
    expect(rows.map((row) => row.action)).toEqual(['create', 'update', 'status_change']);
    expect(rows[1].changes).toEqual({
      car_number: { old: '12 A 3456 Erbil', new: '99 B 1111 Erbil' },
    });
    const history = await as(ctx.http, admin).get(`/api/v1/drivers/${id}/history`).expect(200);
    expect(history.body.items).toHaveLength(3);
  });

  it('warns about a phone another driver has, and saves it once the warning was seen', async () => {
    await newDriver({ name: 'Azad', phone: '0750 123 4567' }).expect(201);
    const refused = await newDriver({ name: 'Karwan', phone: '+964 750 123 4567' }).expect(422);
    expect(refused.body.error.fields[0]).toMatchObject({ path: 'phone', code: 'DUPLICATE_PHONE' });
    expect(refused.body.error.fields[0].params.drivers[0].name).toBe('Azad');
    await newDriver({
      name: 'Karwan',
      phone: '+964 750 123 4567',
      confirm_duplicate_phone: true,
    }).expect(201);
  });

  it('finds a driver by name, phone or car number', async () => {
    await newDriver({ name: 'Azad Omar', phone: '0750 111 2222', car_number: '12 A 3456' }).expect(
      201,
    );
    await newDriver({ name: 'Hemin', phone: '0770 999 8888', car_number: '77 C 1212' }).expect(201);
    const names = async (q: string) =>
      (
        await as(ctx.http, admin)
          .get(`/api/v1/drivers?q=${encodeURIComponent(q)}`)
          .expect(200)
      ).body.items.map((row: { name: string }) => row.name);
    expect(await names('azad')).toEqual(['Azad Omar']);
    expect(await names('0770999')).toEqual(['Hemin']);
    expect(await names('77 C')).toEqual(['Hemin']);
  });

  it('sends an order with a driver, keeps them through an edit that does not mention them, and records changes', async () => {
    const azad = (await newDriver({ name: 'Azad' }).expect(201)).body;
    const hemin = (await newDriver({ name: 'Hemin' }).expect(201)).body;

    const order = (await sell({ driver_id: azad.id }, seller).expect(201)).body;
    expect(order).toMatchObject({ driver_id: azad.id, driver_name: 'Azad' });

    // An edit from a form that knows nothing about drivers keeps the driver.
    const kept = await as(ctx.http, seller)
      .put(`/api/v1/orders/${order.id}`)
      .send({
        customer_id: kawa,
        order_date: order.order_date,
        payment_type: 'borrowed',
        lines: [{ item_id: bolts, qty_count: 3 }],
        version: order.version,
      })
      .expect(200);
    expect(kept.body.driver_name).toBe('Azad');

    const moved = await as(ctx.http, seller)
      .put(`/api/v1/orders/${order.id}`)
      .send({
        customer_id: kawa,
        order_date: order.order_date,
        payment_type: 'borrowed',
        lines: [{ item_id: bolts, qty_count: 3 }],
        driver_id: hemin.id,
        version: kept.body.version,
      })
      .expect(200);
    expect(moved.body.driver_name).toBe('Hemin');

    const cleared = await as(ctx.http, seller)
      .put(`/api/v1/orders/${order.id}`)
      .send({
        customer_id: kawa,
        order_date: order.order_date,
        payment_type: 'borrowed',
        lines: [{ item_id: bolts, qty_count: 3 }],
        driver_id: null,
        version: moved.body.version,
      })
      .expect(200);
    expect(cleared.body.driver_id).toBeNull();

    const rows = await auditRows({ entityId: order.id });
    expect(rows[0].changes.driver).toEqual({ old: null, new: 'Azad' });
    expect(rows[1].changes.driver).toBeUndefined();
    expect(rows[2].changes.driver).toEqual({ old: 'Azad', new: 'Hemin' });
    expect(rows[3].changes.driver).toEqual({ old: 'Hemin', new: null });

    const receipt = await as(ctx.http, reader)
      .get(`/api/v1/orders/${order.id}/receipt`)
      .expect(200);
    expect(receipt.body.driver).toBeNull();
  });

  it('refuses a deactivated driver for a new choice, but lets an order keep the one it has', async () => {
    const azad = (await newDriver({ name: 'Azad', car_number: '12 A' }).expect(201)).body;
    const order = (await sell({ driver_id: azad.id }).expect(201)).body;
    await as(ctx.http, admin)
      .post(`/api/v1/drivers/${azad.id}/deactivate`)
      .send({ version: azad.version })
      .expect(200);

    const refused = await sell({ driver_id: azad.id }).expect(422);
    expect(refused.body.error.fields[0]).toMatchObject({ path: 'driver_id', code: 'INACTIVE' });
    await sell({ driver_id: '00000000-0000-4000-8000-000000000000' }).expect(422);

    await as(ctx.http, admin)
      .put(`/api/v1/orders/${order.id}`)
      .send({
        customer_id: kawa,
        order_date: order.order_date,
        payment_type: 'borrowed',
        lines: [{ item_id: bolts, qty_count: 5 }],
        driver_id: azad.id,
        version: order.version,
      })
      .expect(200);

    const receipt = await as(ctx.http, admin).get(`/api/v1/orders/${order.id}/receipt`).expect(200);
    expect(receipt.body.driver).toEqual({ name: 'Azad', phone: null, car_number: '12 A' });
  });

  it('narrows the orders and Buying & selling to one driver, with that driver’s figures', async () => {
    const azad = (await newDriver({ name: 'Azad' }).expect(201)).body;
    const hemin = (await newDriver({ name: 'Hemin' }).expect(201)).body;
    const first = (await sell({ driver_id: azad.id }).expect(201)).body;
    const second = (
      await sell({ driver_id: azad.id, lines: [{ item_id: bolts, qty_count: 5 }] }).expect(201)
    ).body;
    await sell({ driver_id: hemin.id }).expect(201);
    await sell().expect(201);

    const orders = await as(ctx.http, reader)
      .get(`/api/v1/orders?driver_id=${azad.id}`)
      .expect(200);
    expect(orders.body.items.map((row: { id: string }) => row.id)).toEqual([second.id, first.id]);
    expect(orders.body.totals).toMatchObject({ orders: 2, total_iqd: 14_000 });

    // A driver is a sale's question: the purchases leave Buying & selling.
    const trade = await as(ctx.http, admin).get(`/api/v1/trade?driver_id=${azad.id}`).expect(200);
    expect(trade.body.total).toBe(2);
    expect(
      trade.body.items.every(
        (row: { kind: string; driver_name: string }) =>
          row.kind === 'sale' && row.driver_name === 'Azad',
      ),
    ).toBe(true);
    expect(trade.body.totals.purchases).toBeUndefined();

    const list = await as(ctx.http, admin).get('/api/v1/drivers').expect(200);
    expect(list.body.items.find((row: { id: string }) => row.id === azad.id).last_order_date).toBe(
      first.order_date,
    );
  });

  it('keeps the drivers to whoever may read them, and changing them to whoever may change them', async () => {
    const azad = (await newDriver({ name: 'Azad' }).expect(201)).body;
    // Writing orders reads the drivers (the order form picks one) but adds or edits none.
    await as(ctx.http, seller).get('/api/v1/drivers').expect(200);
    await newDriver({ name: 'Karwan' }, seller).expect(403);
    await as(ctx.http, seller)
      .patch(`/api/v1/drivers/${azad.id}`)
      .send({ name: 'X', version: azad.version })
      .expect(403);
    // Reading orders alone does not open the drivers' page.
    await as(ctx.http, reader).get('/api/v1/drivers').expect(403);
    // …but the order still says who took it.
    const order = (await sell({ driver_id: azad.id }).expect(201)).body;
    expect(
      (await as(ctx.http, reader).get(`/api/v1/orders/${order.id}`).expect(200)).body.driver_name,
    ).toBe('Azad');
  });
});

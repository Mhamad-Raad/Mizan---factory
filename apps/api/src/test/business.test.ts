import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, auditRows, createTestApp, resetDatabase, seedUser, signIn } from './harness.js';
import type { Session, TestApp } from './harness.js';

/** The smallest PNG there is: one transparent pixel. */
const PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * The business on its receipts (D-108): a name, phone and address an admin sets, and a logo kept
 * in the database; everyone signed in reads them to print, only an admin changes them.
 */
describe('the business on its receipts (D-108)', () => {
  let ctx: TestApp;
  let admin: Session;
  let clerk: Session;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase();
    admin = await signIn(ctx.http, await seedUser({ username: 'admin.business', role: 'admin' }));
    clerk = await signIn(
      ctx.http,
      await seedUser({ username: 'clerk', permissions: ['orders.view'] }),
    );
  });

  it('starts empty, so receipts keep the product’s name', async () => {
    const business = await as(ctx.http, clerk).get('/api/v1/settings/business').expect(200);
    expect(business.body).toEqual({ name: null, phone: null, address: null, logo: null });
  });

  it('takes the name, phone and address from an admin, in History, and clears one with null', async () => {
    await as(ctx.http, admin)
      .patch('/api/v1/settings')
      .send({
        business_name: 'Jiyan Steel',
        business_phone: '0750 111 2222',
        business_address: 'Erbil, 100m Road',
      })
      .expect(200);
    expect(
      (await as(ctx.http, clerk).get('/api/v1/settings/business').expect(200)).body,
    ).toMatchObject({
      name: 'Jiyan Steel',
      phone: '0750 111 2222',
      address: 'Erbil, 100m Road',
    });

    await as(ctx.http, admin)
      .patch('/api/v1/settings')
      .send({ business_address: null })
      .expect(200);
    expect(
      (await as(ctx.http, clerk).get('/api/v1/settings/business').expect(200)).body.address,
    ).toBeNull();

    const rows = await auditRows({ action: 'settings_change' });
    expect(rows[0].changes).toMatchObject({ business_name: { old: null, new: 'Jiyan Steel' } });
    expect(rows[1].changes).toEqual({ business_address: { old: 'Erbil, 100m Road', new: null } });
  });

  it('keeps a logo, hands it back as a picture, and removes it — all in History', async () => {
    await as(ctx.http, admin)
      .put('/api/v1/settings/business/logo')
      .send({ data_url: PIXEL_PNG })
      .expect(204);
    expect((await as(ctx.http, clerk).get('/api/v1/settings/business').expect(200)).body.logo).toBe(
      PIXEL_PNG,
    );

    await as(ctx.http, admin).delete('/api/v1/settings/business/logo').send({}).expect(204);
    expect(
      (await as(ctx.http, clerk).get('/api/v1/settings/business').expect(200)).body.logo,
    ).toBeNull();

    const rows = await auditRows({ action: 'settings_change' });
    expect(rows.map((row) => row.changes)).toEqual([
      { business_logo: { old: false, new: true } },
      { business_logo: { old: true, new: false } },
    ]);
  });

  it('refuses what is not a picture, a picture that lies about its kind, and one too large', async () => {
    const send = (dataUrl: string) =>
      as(ctx.http, admin).put('/api/v1/settings/business/logo').send({ data_url: dataUrl });
    const refused = await send('data:image/png;base64,PHN2Zz48L3N2Zz4=').expect(422);
    expect(refused.body.error.fields[0]).toMatchObject({ path: 'data_url', code: 'NOT_A_PICTURE' });
    // A PNG labelled as a JPEG.
    await send(PIXEL_PNG.replace('image/png', 'image/jpeg')).expect(422);
    await send('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=').expect(422);
    const big = `data:image/png;base64,${Buffer.alloc(260_000, 1).toString('base64')}`;
    await send(big).expect(422);
  });

  it('lets only an admin change any of it', async () => {
    await as(ctx.http, clerk).patch('/api/v1/settings').send({ business_name: 'Mine' }).expect(403);
    await as(ctx.http, clerk)
      .put('/api/v1/settings/business/logo')
      .send({ data_url: PIXEL_PNG })
      .expect(403);
    await as(ctx.http, clerk).delete('/api/v1/settings/business/logo').send({}).expect(403);
  });
});

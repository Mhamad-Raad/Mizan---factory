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
 * Companies, purchases and the company ledger (FR-401 to FR-408, FR-701 to FR-712).
 *
 * The cases are the acceptance criteria of iteration 2: a purchase with a company writes stock
 * movements *and* one ledger entry copying its totals, a purchase without one writes movements
 * only, a USD-settled company's purchase is valued at the company's rate even when the month
 * price was typed in dinars, payments convert at that rate (or at an override, stored as
 * `manual`), settle-in-full lands on zero, an adjustment writes exactly the delta with its note
 * and before/after, a reversal negates exactly, the oldest-first allocation reconciles with the
 * balance without anything being linked, a settlement-currency change needs a re-basing rate,
 * the ±20 % rate guard asks before it accepts, and a rate change never touches a stored entry.
 */
describe('companies, purchases and the company ledger (FR-401 to FR-408, FR-701 to FR-712)', () => {
  let ctx: TestApp;
  let admin: Session;
  /** Nazdar: the Accountant preset — companies, money, balances. */
  let accountant: Session;
  /** Hemin: the Warehouse preset — purchases and bought prices, no company money. */
  let warehouse: Session;
  /** An employee who may see companies but not their money (FR-704). */
  let noMoney: Session;
  let accountantUserId: string;
  let steel: string;
  let plates: string;
  let alNoor: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase();

    const adminUser = await seedUser({ username: 'admin.buying', role: 'admin', displayName: 'Dara' });
    const accountantUser = await seedUser({
      username: 'nazdar',
      displayName: 'Nazdar',
      permissions: [
        'companies.create',
        'companies.edit',
        'companies.assign',
        'companies.set_rate',
        'companies.record_payment',
        'companies.adjust_owed',
        'companies.record_credit',
        'companies.opening_balance',
        'purchases.view',
        'fields.see_company_balances',
        'fields.see_bought_price',
      ],
    });
    const warehouseUser = await seedUser({
      username: 'hemin',
      displayName: 'Hemin',
      permissions: ['purchases.create', 'purchases.edit', 'purchases.void', 'companies.view'],
    });
    const plainUser = await seedUser({
      username: 'shilan',
      displayName: 'Shilan',
      permissions: ['companies.view', 'purchases.view'],
    });
    accountantUserId = accountantUser.id;

    admin = await signIn(ctx.http, adminUser);
    accountant = await signIn(ctx.http, accountantUser);
    warehouse = await signIn(ctx.http, warehouseUser);
    noMoney = await signIn(ctx.http, plainUser);

    // The global rate of the demo script; the company's own rate is set apart from it.
    await as(ctx.http, admin).post('/api/v1/settings/global-rates').send({ rate_iqd_per_usd: '1300' }).expect(201);

    steel = await createMaterial('Steel sheet 1.2 mm', 'per_kg', { sale: 850, bought: 700 });
    plates = await createMaterial('Steel plate 10 mm', 'per_piece', { sale: 18_000, bought: 15_000 });

    alNoor = await createCompany({ name: 'Al-Noor Steel Co.' });
  });

  async function createMaterial(
    name: string,
    pricingUnit: 'per_kg' | 'per_piece',
    prices: { sale: number; bought: number },
  ): Promise<string> {
    const created = await as(ctx.http, admin).post('/api/v1/items').send({ name, pricing_unit: pricingUnit }).expect(201);
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

  async function createCompany(
    body: Record<string, unknown>,
    session: Session = accountant,
  ): Promise<string> {
    const created = await as(ctx.http, session).post('/api/v1/companies').send(body).expect(201);
    return created.body.id as string;
  }

  function today(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Baghdad',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  /** The same whole-month arithmetic the API uses for a statement's default range (D-025). */
  function monthsAgo(months: number): string {
    const [year, month, day] = today().split('-').map(Number) as [number, number, number];
    return new Date(Date.UTC(year, month - 1 - months, day)).toISOString().slice(0, 10);
  }

  /** Not `async`: the caller chains `.expect(...)` on the supertest request itself. */
  function createPurchase(session: Session, body: Record<string, unknown>) {
    return as(ctx.http, session)
      .post('/api/v1/purchases')
      .send({ company_id: alNoor, purchase_date: today(), ...body });
  }

  async function companyLedger(companyId: string) {
    return withDatabase(async (client) => {
      const { rows } = await client.query(
        `SELECT entry_type::text AS entry_type, amount_iqd::text AS amount_iqd,
                amount_usd_cents::text AS amount_usd_cents, entered_currency::text AS entered_currency,
                rate_iqd_per_usd::text AS rate_iqd_per_usd, rate_source::text AS rate_source,
                purchase_id, reverses_entry_id, note, posting_seq
           FROM company_ledger WHERE company_id = $1 ORDER BY posting_seq ASC`,
        [companyId],
      );
      return rows as {
        entry_type: string;
        amount_iqd: string;
        amount_usd_cents: string;
        entered_currency: string | null;
        rate_iqd_per_usd: string;
        rate_source: string;
        purchase_id: string | null;
        reverses_entry_id: string | null;
        note: string | null;
        posting_seq: string;
      }[];
    });
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

  async function balanceOf(companyId: string, session: Session = accountant): Promise<number> {
    const response = await as(ctx.http, session).get(`/api/v1/companies/${companyId}`).expect(200);
    const balance = response.body.balance as { amount_iqd: number; amount_usd_cents: number } | null;
    if (!balance) throw new Error('balance was stripped from the response');
    return response.body.settlement_currency === 'IQD' ? balance.amount_iqd : balance.amount_usd_cents;
  }

  // ─────────────────────────── companies and their rate (FR-701 to FR-703, FR-711) ───────────────────────────

  describe('company profiles and rates (FR-701, FR-703, FR-711)', () => {
    it('creates a company with its settlement currency and logs it', async () => {
      const response = await as(ctx.http, accountant).get(`/api/v1/companies/${alNoor}`).expect(200);
      expect(response.body).toMatchObject({
        name: 'Al-Noor Steel Co.',
        settlement_currency: 'IQD',
        is_active: true,
      });
      // No company rate yet: the global one applies and the interface says so (2.3.3).
      expect(response.body.rate).toMatchObject({ rate_iqd_per_usd: '1300.0000', is_company_rate: false });

      const rows = await auditRows({ entityId: alNoor, action: 'create' });
      expect(rows[0]?.entity_label).toBe('Company: Al-Noor Steel Co.');
      expect(rows[0]?.changes).toMatchObject({ settlement_currency: { old: null, new: 'IQD' } });
    });

    it('refuses a second company with the same name, because one supplier is one account', async () => {
      const response = await as(ctx.http, accountant)
        .post('/api/v1/companies')
        .send({ name: 'al-noor steel co.' })
        .expect(422);
      expect(response.body.error.fields[0]).toMatchObject({ path: 'name', code: 'DUPLICATE_NAME' });
    });

    it('shows every company to every user with companies.view, assigned or not (FR-711)', async () => {
      await createCompany({ name: 'Zagros Metals', assigned_user_id: accountantUserId });
      const mine = await as(ctx.http, accountant).get('/api/v1/companies').expect(200);
      const theirs = await as(ctx.http, warehouse).get('/api/v1/companies').expect(200);
      expect(mine.body.total).toBe(2);
      // The one place the supplier side deliberately has no scope rule (2.6.4).
      expect(theirs.body.items.map((row: { name: string }) => row.name).sort()).toEqual([
        'Al-Noor Steel Co.',
        'Zagros Metals',
      ]);
    });

    it('sets the company rate, keeps its history and applies it to new documents (FR-703)', async () => {
      await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/rates`)
        .send({ rate_iqd_per_usd: '1310', note: 'agreed with Al-Noor' })
        .expect(201);

      const detail = await as(ctx.http, accountant).get(`/api/v1/companies/${alNoor}`).expect(200);
      expect(detail.body.rate).toMatchObject({ rate_iqd_per_usd: '1310.0000', is_company_rate: true });

      const history = await as(ctx.http, accountant).get(`/api/v1/companies/${alNoor}/rates`).expect(200);
      expect(history.body.items[0]).toMatchObject({ rate_iqd_per_usd: '1310.0000', note: 'agreed with Al-Noor' });

      const rows = await auditRows({ entityId: alNoor, action: 'rate_change' });
      expect(rows[0]?.changes).toEqual({ rate_iqd_per_usd: { old: null, new: '1310.0000' } });
    });

    it('asks before accepting a rate more than ±20 % away, and accepts it when confirmed', async () => {
      await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/rates`)
        .send({ rate_iqd_per_usd: '1310' })
        .expect(201);

      const guarded = await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/rates`)
        .send({ rate_iqd_per_usd: '13100' })
        .expect(422);
      expect(guarded.body.error.code).toBe('RATE_GUARD');
      expect(guarded.body.error.params).toMatchObject({ previous: '1310.0000', next: '13100.0000' });

      await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/rates`)
        .send({ rate_iqd_per_usd: '13100', confirm: true })
        .expect(201);
    });
  });

  // ─────────────────────────── purchases (FR-401 to FR-408) ───────────────────────────

  describe('a purchase writes stock and what we owe (FR-402, FR-403, FR-404)', () => {
    it('prices the lines from the month bought price and writes one movement per line', async () => {
      const response = await createPurchase(warehouse, {
        lines: [
          { item_id: steel, qty_kg: '5000.000' },
          { item_id: plates, qty_count: 40, qty_kg: '96.000' },
        ],
      }).expect(201);

      const purchase = await as(ctx.http, accountant).get(`/api/v1/purchases/${response.body.id}`).expect(200);
      expect(purchase.body.lines[0].cost).toMatchObject({ unit_price_iqd: 700, price_source: 'month' });
      // 700 × 5,000 = 3,500,000 IQD; 15,000 × 40 = 600,000 IQD; each currency summed on its own.
      expect(purchase.body.lines.map((line: { cost: { line_total_iqd: number } }) => line.cost.line_total_iqd)).toEqual([
        3_500_000, 600_000,
      ]);
      expect(purchase.body.cost.total_iqd).toBe(4_100_000);

      const steelStock = await stockOf(steel);
      expect(steelStock).toMatchObject({ movements: '1', qty_kg: '5000.000' });
      const plateStock = await stockOf(plates);
      expect(plateStock).toMatchObject({ movements: '1', qty_kg: '96.000', qty_count: '40' });

      const material = await as(ctx.http, admin).get(`/api/v1/items/${steel}`).expect(200);
      expect(material.body.first_bought_on).toBe(today());
    });

    it('writes exactly one company entry copying the purchase totals, never a conversion', async () => {
      const response = await createPurchase(warehouse, {
        lines: [{ item_id: steel, qty_kg: '5000.000' }],
      }).expect(201);

      const entries = await companyLedger(alNoor);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        entry_type: 'purchase',
        amount_iqd: '3500000',
        purchase_id: response.body.id,
        // The stored pair and the rate that made it (rule 1); `entered_currency` is null because
        // a purchase total is a sum of lines, not an amount somebody typed.
        entered_currency: null,
        rate_source: 'global',
      });
      expect(entries[0]?.amount_usd_cents).toBe(String(response.body.cost.total_usd_cents));
      expect(await balanceOf(alNoor)).toBe(3_500_000);
    });

    it('moves stock and owes nobody when the purchase names no company (FR-407)', async () => {
      const response = await as(ctx.http, warehouse)
        .post('/api/v1/purchases')
        .send({
          company_id: null,
          purchase_date: today(),
          lines: [{ item_id: steel, qty_kg: '120.000' }],
        })
        .expect(201);

      expect(response.body.company_id).toBeNull();
      expect(await stockOf(steel)).toMatchObject({ movements: '1', qty_kg: '120.000' });
      expect(await companyLedger(alNoor)).toHaveLength(0);

      const balance = await as(ctx.http, accountant)
        .get(`/api/v1/purchases/${response.body.id}/balance`)
        .expect(200);
      expect(balance.body.cost).toEqual({ total: null, linked: null, allocated: null, remaining: null });

      // And it is findable as "stock only" rather than lost among the company purchases.
      const list = await as(ctx.http, accountant).get('/api/v1/purchases?company=stock_only').expect(200);
      expect(list.body.total).toBe(1);
    });

    it("values a USD-settled company's purchase at the company rate, though the price is in dinars", async () => {
      const usdCompany = await createCompany({ name: 'Gulf Steel FZE', settlement_currency: 'USD' });
      await as(ctx.http, accountant)
        .post(`/api/v1/companies/${usdCompany}/rates`)
        .send({ rate_iqd_per_usd: '1310' })
        .expect(201);

      const response = await as(ctx.http, warehouse)
        .post('/api/v1/purchases')
        .send({
          company_id: usdCompany,
          purchase_date: today(),
          lines: [{ item_id: steel, qty_kg: '1000.000' }],
        })
        .expect(201);

      const purchase = await as(ctx.http, accountant).get(`/api/v1/purchases/${response.body.id}`).expect(200);
      expect(purchase.body.rate_iqd_per_usd).toBe('1310.0000');
      expect(purchase.body.rate_source).toBe('company');
      // 700,000 IQD ÷ 1,310 = $534.35, not the $538.46 the global 1,300 would have given.
      expect(purchase.body.cost.total_iqd).toBe(700_000);
      expect(purchase.body.cost.total_usd_cents).toBe(53_435);

      const entries = await companyLedger(usdCompany);
      expect(entries[0]).toMatchObject({ amount_usd_cents: '53435', rate_iqd_per_usd: '1310.0000' });
      expect(await balanceOf(usdCompany)).toBe(53_435);
    });

    it('marks an overridden price and applies a rate typed for this purchase', async () => {
      const response = await createPurchase(warehouse, {
        rate_iqd_per_usd: '1250',
        lines: [
          { item_id: steel, qty_kg: '10.000' },
          { item_id: steel, qty_kg: '10.000', unit_price: { amount: 720, currency: 'IQD' } },
        ],
      }).expect(201);

      const purchase = await as(ctx.http, accountant).get(`/api/v1/purchases/${response.body.id}`).expect(200);
      expect(purchase.body.rate_source).toBe('manual');
      expect(purchase.body.lines[0].cost).toMatchObject({ price_source: 'month', unit_price_iqd: 700 });
      expect(purchase.body.lines[1].cost).toMatchObject({ price_source: 'override', unit_price_iqd: 720 });
      // 14,200 IQD ÷ 1,250 = $11.36, the rate of this purchase and not the global one.
      expect(purchase.body.cost.total_iqd).toBe(14_200);
      expect(purchase.body.cost.total_usd_cents).toBe(1_136);
      // The same material twice is legitimate — two price tiers — and only warned about.
      expect(response.body.duplicate_item_warning).toEqual([{ item_id: steel, item_name: 'Steel sheet 1.2 mm' }]);
    });
  });

  describe('editing, voiding and undoing a purchase (FR-405)', () => {
    it('reverses the old movements and the old entry, then writes the new version', async () => {
      const created = await createPurchase(warehouse, {
        lines: [{ item_id: steel, qty_kg: '100.000' }],
      }).expect(201);
      const id = created.body.id as string;

      await as(ctx.http, warehouse)
        .put(`/api/v1/purchases/${id}`)
        .send({
          company_id: alNoor,
          purchase_date: today(),
          version: created.body.version,
          lines: [{ item_id: steel, qty_kg: '150.000' }],
        })
        .expect(200);

      // Two movements out (100 in, 100 back) and the new 150: the ledger tells the whole story.
      expect(await stockOf(steel)).toMatchObject({ movements: '3', qty_kg: '150.000' });

      const entries = await companyLedger(alNoor);
      expect(entries.map((entry) => entry.entry_type)).toEqual(['purchase', 'reversal', 'purchase']);
      expect(await balanceOf(alNoor)).toBe(105_000);

      const rows = await auditRows({ entityId: id, action: 'update' });
      expect(rows[0]?.changes).toMatchObject({
        purchase_total: { old: { iqd: 70_000 }, new: { iqd: 105_000 } },
      });
    });

    it('refuses to move a purchase to another company: that is a void and a new purchase', async () => {
      const other = await createCompany({ name: 'Zagros Metals' });
      const created = await createPurchase(warehouse, { lines: [{ item_id: steel, qty_kg: '10.000' }] }).expect(201);

      const response = await as(ctx.http, warehouse)
        .put(`/api/v1/purchases/${created.body.id}`)
        .send({
          company_id: other,
          purchase_date: today(),
          version: created.body.version,
          lines: [{ item_id: steel, qty_kg: '10.000' }],
        })
        .expect(422);
      expect(response.body.error.fields[0]).toMatchObject({ path: 'company_id', code: 'IMMUTABLE' });
    });

    it('refuses an edit once a payment names the purchase, unless the admin allowed it', async () => {
      const created = await createPurchase(warehouse, { lines: [{ item_id: steel, qty_kg: '100.000' }] }).expect(201);
      const id = created.body.id as string;

      await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/payments`)
        .send({ amount: 20_000, currency: 'IQD', entry_date: today(), purchase_id: id, note: 'part payment' })
        .expect(201);

      const refused = await as(ctx.http, warehouse)
        .put(`/api/v1/purchases/${id}`)
        .send({
          company_id: alNoor,
          purchase_date: today(),
          version: created.body.version,
          lines: [{ item_id: steel, qty_kg: '120.000' }],
        })
        .expect(409);
      expect(refused.body.error.code).toBe('EDIT_WINDOW_CLOSED');

      await as(ctx.http, admin).patch('/api/v1/settings').send({ allow_edit_after_payment: true }).expect(200);
      await as(ctx.http, warehouse)
        .put(`/api/v1/purchases/${id}`)
        .send({
          company_id: alNoor,
          purchase_date: today(),
          version: created.body.version,
          lines: [{ item_id: steel, qty_kg: '120.000' }],
        })
        .expect(200);
    });

    it('restores stock and what we owe on a void, and keeps the payment standing', async () => {
      const created = await createPurchase(warehouse, { lines: [{ item_id: steel, qty_kg: '100.000' }] }).expect(201);
      const id = created.body.id as string;
      await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/payments`)
        .send({ amount: 20_000, currency: 'IQD', entry_date: today(), purchase_id: id, note: 'part payment' })
        .expect(201);

      const voided = await as(ctx.http, warehouse)
        .post(`/api/v1/purchases/${id}/void`)
        .send({ reason: 'wrong material recorded' })
        .expect(200);
      expect(voided.body.doc_status).toBe('void');
      expect(voided.body.void_reason).toBe('wrong material recorded');

      expect(await stockOf(steel)).toMatchObject({ movements: '2', qty_kg: '0.000' });
      const entries = await companyLedger(alNoor);
      // purchase, payment, reversal-of-purchase: the money that left the till stays recorded.
      expect(entries.map((entry) => entry.entry_type)).toEqual(['purchase', 'payment', 'reversal']);
      expect(await balanceOf(alNoor)).toBe(-20_000);

      const rows = await auditRows({ entityId: id, action: 'void' });
      expect(rows[0]?.note).toBe('wrong material recorded');
    });

    it('lets the creator undo a purchase they just saved, and hides it from the list', async () => {
      const created = await createPurchase(warehouse, { lines: [{ item_id: steel, qty_kg: '10.000' }] }).expect(201);
      await as(ctx.http, warehouse).post(`/api/v1/purchases/${created.body.id}/undo`).expect(200);

      const list = await as(ctx.http, accountant).get('/api/v1/purchases').expect(200);
      expect(list.body.total).toBe(0);
      const withUndone = await as(ctx.http, accountant).get('/api/v1/purchases?include_undone=true').expect(200);
      expect(withUndone.body.total).toBe(1);
      expect(await stockOf(steel)).toMatchObject({ qty_kg: '0.000' });
    });
  });

  // ─────────────────────────── the money (FR-705 to FR-708, FR-712) ───────────────────────────

  describe('payments, credits, adjustments and openings (FR-705 to FR-708)', () => {
    beforeEach(async () => {
      await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/rates`)
        .send({ rate_iqd_per_usd: '1310' })
        .expect(201);
    });

    it('converts a payment at the company rate and stores both currencies with the rate', async () => {
      await createPurchase(warehouse, { lines: [{ item_id: steel, qty_kg: '5000.000' }] }).expect(201);

      const payment = await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/payments`)
        .send({ amount: 1_000_000, currency: 'IQD', entry_date: today(), method: 'cash', note: 'first instalment' })
        .expect(201);

      expect(payment.body[0]).toMatchObject({
        entry_type: 'payment',
        amount_iqd: -1_000_000,
        // 1,000,000 ÷ 1,310 = $763.36, at the company's rate and not the global 1,300.
        amount_usd_cents: -76_336,
        balance_before: 3_500_000,
        balance_after: 2_500_000,
      });
      expect(payment.body[0].voucher_number).toBe(1);

      const entries = await companyLedger(alNoor);
      expect(entries[1]).toMatchObject({
        entry_type: 'payment',
        entered_currency: 'IQD',
        rate_iqd_per_usd: '1310.0000',
        rate_source: 'company',
      });
    });

    it('stores an overridden other-currency amount as the implied manual rate', async () => {
      await createPurchase(warehouse, { lines: [{ item_id: steel, qty_kg: '5000.000' }] }).expect(201);

      await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/payments`)
        .send({
          // Minor units throughout (rule 1): 50,000 cents is the $500 handed over.
          amount: 50_000,
          currency: 'USD',
          // The accountant typed both sides: $500 handed over, 650,000 dinars agreed.
          other_amount: 650_000,
          entry_date: today(),
          note: 'second instalment',
        })
        .expect(201);

      const entries = await companyLedger(alNoor);
      expect(entries[1]).toMatchObject({
        amount_usd_cents: '-50000',
        amount_iqd: '-650000',
        entered_currency: 'USD',
        rate_source: 'manual',
      });
      // 650,000 ÷ 500 = 1,300 exactly: the rate the two of them actually used.
      expect(entries[1]?.rate_iqd_per_usd).toBe('1300.0000');
    });

    it('settles in full and leaves the account on exactly zero', async () => {
      await createPurchase(warehouse, { lines: [{ item_id: steel, qty_kg: '5000.000' }] }).expect(201);

      // The supplier is handed $2,672 for a 3,500,000 IQD debt: inside tolerance at 1,310.
      await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/payments`)
        .send({
          amount: 267_176,
          currency: 'USD',
          entry_date: today(),
          settle_in_full: true,
          note: 'settled',
        })
        .expect(201);

      expect(await balanceOf(alNoor)).toBe(0);
    });

    it('records a credit for goods returned and an opening balance at go-live', async () => {
      await createPurchase(warehouse, { lines: [{ item_id: steel, qty_kg: '100.000' }] }).expect(201);

      await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/credits`)
        .send({ amount: 7_000, currency: 'IQD', entry_date: today(), note: 'ten kilos returned' })
        .expect(201);
      expect(await balanceOf(alNoor)).toBe(63_000);

      const fresh = await createCompany({ name: 'Zagros Metals' });
      await as(ctx.http, accountant)
        .post(`/api/v1/companies/${fresh}/opening-balance`)
        .send({ amount: 2_000_000, currency: 'IQD', entry_date: today(), note: 'owed at go-live' })
        .expect(201);
      expect(await balanceOf(fresh)).toBe(2_000_000);
    });

    it('writes exactly the delta for an adjustment, with the note and before/after in History', async () => {
      await createPurchase(warehouse, { lines: [{ item_id: steel, qty_kg: '5000.000' }] }).expect(201);

      // FR-706 lets the accountant type the *new balance*; the entry is the difference.
      const adjustment = await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/adjustments`)
        .send({
          new_balance: 3_023_600,
          currency: 'IQD',
          entry_date: today(),
          note: 'agreed discount on the invoice',
        })
        .expect(201);

      expect(adjustment.body).toMatchObject({
        entry_type: 'adjustment',
        amount_iqd: -476_400,
        balance_before: 3_500_000,
        balance_after: 3_023_600,
      });
      expect(await balanceOf(alNoor)).toBe(3_023_600);

      const rows = await auditRows({ entityId: alNoor, action: 'ledger_entry' });
      const logged = rows.find(
        (row) => (row.changes as { entry?: { type?: string } }).entry?.type === 'adjustment',
      );
      expect(logged?.note).toBe('agreed discount on the invoice');
      // Rule 3: a balance change carries the figure before and the figure after.
      expect(logged?.changes).toMatchObject({
        balance: {
          before: { amount: 3_500_000, currency: 'IQD' },
          after: { amount: 3_023_600, currency: 'IQD' },
        },
        entry: { type: 'adjustment', amount_iqd: -476_400 },
      });
    });

    it('refuses an adjustment without a real note, and one that says two things at once', async () => {
      const noNote = await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/adjustments`)
        .send({ delta: -1_000, currency: 'IQD', entry_date: today(), note: 'x' })
        .expect(422);
      expect(noNote.body.error.code).toBe('VALIDATION_FAILED');

      const both = await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/adjustments`)
        .send({ new_balance: 10, delta: -10, currency: 'IQD', entry_date: today(), note: 'contradiction' })
        .expect(422);
      expect(both.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('reverses a money row by exact negation, and refuses to reverse it twice', async () => {
      await createPurchase(warehouse, { lines: [{ item_id: steel, qty_kg: '5000.000' }] }).expect(201);
      const payment = await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/payments`)
        .send({ amount: 1_000_000, currency: 'IQD', entry_date: today(), note: 'paid twice by mistake' })
        .expect(201);
      const entryId = payment.body[0].entry_id as string;

      const reversal = await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/ledger/${entryId}/reverse`)
        .send({ note: 'entered twice' })
        .expect(201);
      expect(reversal.body).toMatchObject({ entry_type: 'reversal', amount_iqd: 1_000_000 });
      expect(await balanceOf(alNoor)).toBe(3_500_000);

      await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/ledger/${entryId}/reverse`)
        .send({ note: 'again' })
        .expect(409);
    });

    it('refuses to update or delete a company ledger row at the database level (rule 2)', async () => {
      await createPurchase(warehouse, { lines: [{ item_id: steel, qty_kg: '10.000' }] }).expect(201);

      // As the *application* role, which is where the guarantee has to hold (rule 2).
      const client = new Client({ connectionString: TEST_DATABASE_URL });
      await client.connect();
      try {
        await expect(client.query("UPDATE company_ledger SET note = 'tampered'")).rejects.toThrow(
          /permission denied/i,
        );
        await expect(client.query('DELETE FROM company_ledger')).rejects.toThrow(/permission denied/i);
        await expect(client.query('DELETE FROM company_rates')).rejects.toThrow(/permission denied/i);
        await expect(client.query('DELETE FROM purchases')).rejects.toThrow(/permission denied/i);
      } finally {
        await client.end();
      }

      // …and the row is still there.
      expect(await companyLedger(alNoor)).toHaveLength(1);
    });
  });

  // ─────────────────────────── what we owe per purchase (FR-712) ───────────────────────────

  describe('per-purchase remaining with oldest-first allocation (FR-712)', () => {
    it('spreads an unlinked payment over the oldest purchases and reconciles with the balance', async () => {
      const first = await createPurchase(warehouse, {
        purchase_date: '2026-09-01',
        lines: [{ item_id: steel, qty_kg: '100.000' }],
      }).expect(201);
      const second = await createPurchase(warehouse, {
        purchase_date: '2026-09-10',
        lines: [{ item_id: steel, qty_kg: '200.000' }],
      }).expect(201);

      // 70,000 + 140,000 owed; 100,000 paid with nothing linked to anything.
      await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/payments`)
        .send({ amount: 100_000, currency: 'IQD', entry_date: today(), note: 'on account' })
        .expect(201);

      const breakdown = await as(ctx.http, accountant)
        .get(`/api/v1/companies/${alNoor}/purchase-breakdown`)
        .expect(200);

      const byId = new Map<string, { remaining: number }>(
        breakdown.body.allocation.purchases.map((row: { purchase_id: string; remaining: number }) => [
          row.purchase_id,
          row,
        ]),
      );
      // The oldest purchase was absorbed by the payment, so it is counted rather than sent.
      expect(byId.has(first.body.id)).toBe(false);
      expect(breakdown.body.settled_count).toBe(1);
      expect(byId.get(second.body.id)?.remaining).toBe(110_000);
      expect(breakdown.body.allocation.general).toBe(0);
      // The identity the kernel's property test pins: Σ remaining + general = balance.
      expect(breakdown.body.allocation.balance).toBe(110_000);
      expect(await balanceOf(alNoor)).toBe(110_000);

      // And one purchase's own page reads the same figure as the company's breakdown — the
      // share of an unlinked payment, not the total it happens to have been invoiced for.
      const firstBalance = await as(ctx.http, accountant)
        .get(`/api/v1/purchases/${first.body.id}/balance`)
        .expect(200);
      expect(firstBalance.body.cost).toMatchObject({ total: 70_000, linked: 0, allocated: -70_000, remaining: 0 });
      const secondBalance = await as(ctx.http, accountant)
        .get(`/api/v1/purchases/${second.body.id}/balance`)
        .expect(200);
      expect(secondBalance.body.cost).toMatchObject({ allocated: -30_000, remaining: 110_000 });
    });

    it('honours an explicit link before the oldest-first spread, and reports it per purchase', async () => {
      const first = await createPurchase(warehouse, {
        purchase_date: '2026-09-01',
        lines: [{ item_id: steel, qty_kg: '100.000' }],
      }).expect(201);
      const second = await createPurchase(warehouse, {
        purchase_date: '2026-09-10',
        lines: [{ item_id: steel, qty_kg: '200.000' }],
      }).expect(201);

      await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/payments`)
        .send({
          amount: 140_000,
          currency: 'IQD',
          entry_date: today(),
          purchase_id: second.body.id,
          note: 'for the second load',
        })
        .expect(201);

      const balance = await as(ctx.http, accountant)
        .get(`/api/v1/purchases/${second.body.id}/balance`)
        .expect(200);
      expect(balance.body.cost).toMatchObject({ total: 140_000, linked: -140_000, allocated: 0, remaining: 0 });

      // The older purchase keeps its whole total: the payment named the newer one, and an
      // explicit link always wins over the oldest-first spread (FR-712).
      const firstBalance = await as(ctx.http, accountant)
        .get(`/api/v1/purchases/${first.body.id}/balance`)
        .expect(200);
      expect(firstBalance.body.cost.remaining).toBe(70_000);
      expect(await balanceOf(alNoor)).toBe(70_000);
    });
  });

  // ─────────────────────────── the settlement currency (FR-702, 2.3.5) ───────────────────────────

  describe('changing the settlement currency (FR-702, spec 2.3.5)', () => {
    it('refuses a change with money on the account unless a re-basing rate is given', async () => {
      await createPurchase(warehouse, { lines: [{ item_id: steel, qty_kg: '5000.000' }] }).expect(201);

      const refused = await as(ctx.http, admin)
        .put(`/api/v1/companies/${alNoor}/settlement-currency`)
        .send({ currency: 'USD', note: 'they invoice in dollars now' })
        .expect(422);
      expect(refused.body.error.code).toBe('REBASE_RATE_REQUIRED');
    });

    it('lands on exactly the agreed balance through one re-basing entry', async () => {
      await createPurchase(warehouse, { lines: [{ item_id: steel, qty_kg: '5000.000' }] }).expect(201);
      const before = await companyLedger(alNoor);
      const storedUsd = Number(before[0]?.amount_usd_cents);

      const changed = await as(ctx.http, admin)
        .put(`/api/v1/companies/${alNoor}/settlement-currency`)
        .send({ currency: 'USD', note: 'they invoice in dollars now', rebase_rate: '1310' })
        .expect(200);

      expect(changed.body.settlement_currency).toBe('USD');
      // 3,500,000 ÷ 1,310 = $2,671.76 — the balance the two of them agreed, to the cent.
      expect(await balanceOf(alNoor)).toBe(267_176);

      const after = await companyLedger(alNoor);
      expect(after).toHaveLength(2);
      expect(after[1]).toMatchObject({ entry_type: 'settlement_change', rate_iqd_per_usd: '1310.0000' });
      // The re-basing row carries only the difference between the agreed figure and the sum of
      // the dollar column, so no historical amount is touched (2.3.5).
      expect(Number(after[1]?.amount_usd_cents)).toBe(267_176 - storedUsd);
      expect(Number(after[1]?.amount_iqd)).toBe(0);
    });

    it('never alters a stored entry when the rate changes afterwards (FR-703)', async () => {
      await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/rates`)
        .send({ rate_iqd_per_usd: '1310' })
        .expect(201);
      const purchase = await createPurchase(warehouse, { lines: [{ item_id: steel, qty_kg: '5000.000' }] }).expect(
        201,
      );
      const before = await companyLedger(alNoor);

      await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/rates`)
        .send({ rate_iqd_per_usd: '1400' })
        .expect(201);

      const after = await companyLedger(alNoor);
      expect(after).toEqual(before);
      const reread = await as(ctx.http, accountant).get(`/api/v1/purchases/${purchase.body.id}`).expect(200);
      expect(reread.body.rate_iqd_per_usd).toBe('1310.0000');
      expect(reread.body.cost.total_usd_cents).toBe(Number(before[0]?.amount_usd_cents));
    });
  });

  // ─────────────────────────── the I2 review findings (docs/REVIEW-I2.md) ───────────────────────────

  describe('what the review measured and fixed', () => {
    beforeEach(async () => {
      await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/rates`)
        .send({ rate_iqd_per_usd: '1310' })
        .expect(201);
    });

    it('filters the accounting tab by type, date and who did it, and bounds what it returns', async () => {
      await createPurchase(warehouse, {
        purchase_date: '2026-09-01',
        lines: [{ item_id: steel, qty_kg: '100.000' }],
      }).expect(201);
      for (const amount of [10_000, 20_000, 30_000]) {
        await as(ctx.http, accountant)
          .post(`/api/v1/companies/${alNoor}/payments`)
          .send({ amount, currency: 'IQD', entry_date: today(), note: `instalment ${amount}` })
          .expect(201);
      }

      const all = await as(ctx.http, accountant).get(`/api/v1/companies/${alNoor}/ledger`).expect(200);
      expect(all.body.total).toBe(4);
      expect(all.body.has_more).toBe(false);

      // The filters of 2.9.3, which the first draft of this route ignored.
      const payments = await as(ctx.http, accountant)
        .get(`/api/v1/companies/${alNoor}/ledger?type=payment`)
        .expect(200);
      expect(payments.body.total).toBe(3);
      expect(payments.body.items.every((row: { entry_type: string }) => row.entry_type === 'payment')).toBe(true);

      const september = await as(ctx.http, accountant)
        .get(`/api/v1/companies/${alNoor}/ledger?from=2026-09-01&to=2026-09-01`)
        .expect(200);
      expect(september.body.total).toBe(1);
      expect(september.body.items[0].entry_type).toBe('purchase');

      const mine = await as(ctx.http, accountant)
        .get(`/api/v1/companies/${alNoor}/ledger?done_by=${accountantUserId}`)
        .expect(200);
      expect(mine.body.total).toBe(3);

      // The bound, and the running balance still computed over the whole ledger: the newest
      // row's balance is the account balance, not a sum of the page.
      const bounded = await as(ctx.http, accountant)
        .get(`/api/v1/companies/${alNoor}/ledger?limit=2`)
        .expect(200);
      expect(bounded.body.items).toHaveLength(2);
      expect(bounded.body.total).toBe(4);
      expect(bounded.body.has_more).toBe(true);
      expect(bounded.body.items[0].balance_after).toBe(bounded.body.balance);
    });

    it('sends only the purchases that still owe something in the breakdown', async () => {
      const settled = await createPurchase(warehouse, {
        purchase_date: '2026-09-01',
        lines: [{ item_id: steel, qty_kg: '100.000' }],
      }).expect(201);
      const owing = await createPurchase(warehouse, {
        purchase_date: '2026-09-10',
        lines: [{ item_id: steel, qty_kg: '100.000' }],
      }).expect(201);

      // 70,000 owed on each; 70,000 paid, so the oldest is settled and the newer is not.
      await as(ctx.http, accountant)
        .post(`/api/v1/companies/${alNoor}/payments`)
        .send({ amount: 70_000, currency: 'IQD', entry_date: today(), note: 'on account' })
        .expect(201);

      const breakdown = await as(ctx.http, accountant)
        .get(`/api/v1/companies/${alNoor}/purchase-breakdown`)
        .expect(200);

      expect(breakdown.body.allocation.purchases.map((row: { purchase_id: string }) => row.purchase_id)).toEqual([
        owing.body.id,
      ]);
      expect(breakdown.body.settled_count).toBe(1);
      expect(breakdown.body.owing_count).toBe(1);
      expect(breakdown.body.owing_total).toBe(70_000);
      expect(breakdown.body.purchases.map((row: { id: string }) => row.id)).toEqual([owing.body.id]);
      // The identity stays checkable from the response when the rows are cut to a page.
      expect(breakdown.body.owing_total + breakdown.body.allocation.general).toBe(
        breakdown.body.allocation.balance,
      );
      // The identity survives the trimming, because a settled purchase contributes zero.
      const sum = breakdown.body.allocation.purchases.reduce(
        (total: number, row: { remaining: number }) => total + row.remaining,
        0,
      );
      expect(sum + breakdown.body.allocation.general).toBe(breakdown.body.allocation.balance);
      expect(await balanceOf(alNoor)).toBe(70_000);
      void settled;
    });

    it('covers the last three months when a statement is asked for without a period', async () => {
      const statement = await as(ctx.http, accountant).get(`/api/v1/companies/${alNoor}/statement`).expect(200);
      expect(statement.body.from).toBe(monthsAgo(3));
      expect(statement.body.to).toBeNull();

      const asked = await as(ctx.http, accountant)
        .get(`/api/v1/companies/${alNoor}/statement?from=2026-09-01&to=2026-09-30`)
        .expect(200);
      expect(asked.body.from).toBe('2026-09-01');
    });

    it('bounds the customer ledger the same way, which the review found unbounded too', async () => {
      const customer = await as(ctx.http, admin)
        .post('/api/v1/customers')
        .send({ name: 'Kawa Trading' })
        .expect(201);
      for (const amount of [1_000, 2_000, 3_000]) {
        await as(ctx.http, admin)
          .post(`/api/v1/customers/${customer.body.id}/opening-balance`)
          .send({ amount, currency: 'IQD', entry_date: today(), note: 'go-live' })
          .expect(201);
      }

      const bounded = await as(ctx.http, admin)
        .get(`/api/v1/customers/${customer.body.id}/ledger?limit=2`)
        .expect(200);
      expect(bounded.body.items).toHaveLength(2);
      expect(bounded.body.total).toBe(3);
      expect(bounded.body.has_more).toBe(true);
      expect(bounded.body.items[0].balance_after).toBe(6_000);
    });
  });

  // ─────────────────────────── the field-level flags (FR-704, 2.6.2) ───────────────────────────

  describe('field-level permissions (FR-704, spec 2.6.2)', () => {
    it('strips company money from every response for a user without the balances flag', async () => {
      await createPurchase(warehouse, { lines: [{ item_id: steel, qty_kg: '100.000' }] }).expect(201);

      const detail = await as(ctx.http, noMoney).get(`/api/v1/companies/${alNoor}`).expect(200);
      expect(detail.body.name).toBe('Al-Noor Steel Co.');
      expect('balance' in detail.body).toBe(false);

      const list = await as(ctx.http, noMoney).get('/api/v1/companies').expect(200);
      expect('balance' in list.body.items[0]).toBe(false);

      // The accounting tab, the statement and the per-purchase breakdown are the balance
      // itself: those routes ask for the flag rather than answering with holes (spec 2.9.3).
      await as(ctx.http, noMoney).get(`/api/v1/companies/${alNoor}/ledger`).expect(403);
      await as(ctx.http, noMoney).get(`/api/v1/companies/${alNoor}/purchase-breakdown`).expect(403);
      await as(ctx.http, noMoney).get(`/api/v1/companies/${alNoor}/statement`).expect(403);
    });

    it('keeps quantities and hides prices for a user without the bought-price flag', async () => {
      const created = await createPurchase(warehouse, { lines: [{ item_id: steel, qty_kg: '100.000' }] }).expect(201);

      const detail = await as(ctx.http, noMoney).get(`/api/v1/purchases/${created.body.id}`).expect(200);
      expect(detail.body.purchase_date).toBe(today());
      expect(detail.body.lines[0].qty_kg).toBe('100.000');
      expect('cost' in detail.body).toBe(false);
      expect('cost' in detail.body.lines[0]).toBe(false);

      const list = await as(ctx.http, noMoney).get('/api/v1/purchases').expect(200);
      // The pagination count survives; only the money is gone.
      expect(list.body.total).toBe(1);
      expect('cost' in list.body.items[0]).toBe(false);

      const history = await as(ctx.http, noMoney).get(`/api/v1/purchases/${created.body.id}/history`).expect(200);
      const create = history.body.items.find((row: { action: string }) => row.action === 'create');
      expect('purchase_total' in create.changes).toBe(false);
      expect('unit_price' in create.changes.lines.new[0]).toBe(false);
    });
  });
});

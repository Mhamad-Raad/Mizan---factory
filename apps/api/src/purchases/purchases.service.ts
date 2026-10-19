import { DriversService } from '../drivers/drivers.service.js';
import { Injectable } from '@nestjs/common';
import {
  Decimal,
  completePair,
  computeLineTotals,
  defaultLinePrice,
  documentTotals,
  firstOfMonth,
  formatRate,
  selectMonthPrice,
} from '@mizan/money';
import type { Currency, Measure, Rate, RateSource } from '@mizan/money';
import { liveEntries } from '@mizan/ledger';
import { mayReversePayment } from '../ledger/reversible.js';
import { AuditService } from '../audit/audit.service.js';
import { resolveActingUser } from '../common/acting-user.js';
import { ApiError } from '../common/errors.js';
import { can } from '../common/request-context.js';
import type { RequestContext } from '../common/request-context.js';
import { CompaniesRepository } from '../companies/companies.repository.js';
import { CompaniesService } from '../companies/companies.service.js';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';
import { HistoryRepository } from '../history/history.repository.js';
import { ItemsRepository } from '../items/items.repository.js';
import { CompanyLedgerService, PURCHASE_DOCUMENT_TYPES } from '../ledger/company-ledger.service.js';
import type { LedgerAccount } from '../ledger/account-ledger.service.js';
import { RatesService } from '../rates/rates.service.js';
import { PeriodService } from '../settings/period.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { StockService } from '../stock/stock.service.js';
import { LotsService } from '../lots/lots.service.js';
import { PurchasesRepository } from './purchases.repository.js';
import type {
  NewPurchaseLine,
  PurchaseFilters,
  PurchaseLineRow,
  PurchaseListRow,
} from './purchases.repository.js';

/** How long the creator may undo a purchase from the save toast (FR-405). */
const UNDO_WINDOW_MS = 8_000;

/** How many companies' accounts a list allocates at once for its rows' payment states. */
const PAYMENT_CONCURRENCY = 4;

export interface PurchaseLineInput {
  item_id: string;
  qty_count?: number | null;
  qty_kg?: string | null;
  /** Omitted: the month's bought price applies. Given: an override, logged (FR-408). */
  unit_price?: { amount: number; currency: Currency; other_amount?: number | null } | null;
  /** The line's total entered directly. Authoritative when present; the unit price is derived
      from it for the record. This is the simplified "how much did you add, total" path. */
  total?: { amount: number; currency: Currency; other_amount?: number | null } | null;
  note?: string | null;
}

export interface CreatePurchaseInput {
  /** Null = "No company (stock only)": stock moves and nobody is owed (FR-407). */
  company_id?: string | null;
  purchase_date: string;
  notes?: string | null;
  /** Who brought it in (D-106). Null names nobody; on an edit, left out keeps the purchase's driver. */
  driver_id?: string | null;
  /** "Rate for this purchase" (2.3.3); the company's rate, or the global one, when absent. */
  rate_iqd_per_usd?: string | null;
  /** Proposed — not requested (FR-616). */
  discount?: { amount: number; currency: Currency; other_amount?: number | null } | null;
  lines: PurchaseLineInput[];
  acting_user_id?: string | null;
  /**
   * What was paid to the company at the moment of buying (D-085): all of it, or a part typed in
   * either currency. Written in the buy's own transaction as a payment that names the buy, so a
   * buy paid on the spot never shows as owed, not even for a moment.
   */
  paid?: PaidNowInput | null;
}

export type PaidNowInput =
  /** All of it, in the currency the money went out in (the account's own when not said). */
  | { in_full: true; currency?: Currency | null }
  | { in_full?: false; amount: number; currency: Currency; other_amount?: number | null };

/**
 * The note on a "paid now" payment (D-085). With being written in the purchase's own transaction,
 * it is what tells that payment apart from one made later, so a void or an undo takes back the
 * money paid *with* the purchase — as an order's void takes back its cash settlement — and leaves
 * every later payment standing. Stored in English and translated where it is read.
 */
export function paidNowNote(purchaseNumber: number | string): string {
  return `Paid with purchase #${purchaseNumber}`;
}

/**
 * A line as it leaves the API. Every price and total lives under one `cost` key, so the
 * interceptor strips the whole group for a caller without `fields.see_bought_price` while the
 * material, the quantities and the date stay readable (FR-460 of 1.5.4, spec 2.6.2) — the same
 * shape the order line uses for its cost snapshot.
 */
export interface PurchaseLineDto {
  id: string;
  line_no: number;
  item_id: string;
  item_name: string;
  qty_count: number | null;
  qty_kg: string | null;
  priced_measure: Measure;
  rate_iqd_per_usd: Rate;
  rate_source: RateSource;
  note: string | null;
  cost: {
    unit_price_iqd: number;
    unit_price_usd_cents: number;
    price_entered_currency: Currency;
    price_source: 'month' | 'override';
    price_from_month: string | null;
    line_total_iqd: number;
    line_total_usd_cents: number;
  };
}

export interface PurchaseDto {
  id: string;
  number: number;
  company_id: string | null;
  company_name: string | null;
  settlement_currency: Currency | null;
  purchase_date: string;
  acting_user_id: string;
  acting_user_name: string | null;
  notes: string | null;
  /** Who brought it in (D-106). */
  driver_id: string | null;
  driver_name: string | null;
  /** On the purchase's own page only: the driver as the receipt shows them. */
  driver?: { name: string; phone: string | null; car_number: string | null } | null;
  rate_iqd_per_usd: Rate;
  rate_source: RateSource;
  doc_status: 'active' | 'void';
  void_reason: string | null;
  voided_by_name: string | null;
  voided_at: string | null;
  line_count: number;
  /** The materials bought, by name (D-062). */
  item_names: string | null;
  cost: {
    discount_iqd: number;
    discount_usd_cents: number;
    total_iqd: number;
    total_usd_cents: number;
  };
  lines: PurchaseLineDto[];
  version: number;
  created_at: string;
  /** Proposed — not requested: the same material on two lines is a warning, not a block. */
  duplicate_item_warning?: { item_id: string; item_name: string }[];
  /** The payment written with the buy (D-085), so its receipt can be printed straight away. */
  paid_entry_id?: string | null;
  /**
   * On a list, for a reader who may see what we owe companies: what is still owed on it, in the
   * company's currency, and whether it is paid (D-085). Absent for a void purchase, one from no
   * company, and any other reader.
   */
  payment?: { remaining: number; status: 'paid' | 'partially_paid' | 'unpaid' };
}

interface PreparedLine extends NewPurchaseLine {
  item_name: string;
  price_from_month: string | null;
}

/**
 * Purchases — the page the client calls "add material" (FR-401 to FR-408).
 *
 * The mirror of orders: one transaction writes the purchase, its lines, one `purchase_in`
 * movement per line and — when a company is named — the company-ledger entry carrying the
 * purchase totals exactly as stored. Two differences from the selling side: the document rate
 * comes from the *company* (2.3.3), and a purchase without a company owes nobody (FR-407).
 */
@Injectable()
export class PurchasesService {
  constructor(
    private readonly database: Database,
    private readonly purchases: PurchasesRepository,
    private readonly items: ItemsRepository,
    private readonly companies: CompaniesRepository,
    private readonly companiesService: CompaniesService,
    private readonly ledger: CompanyLedgerService,
    private readonly stock: StockService,
    private readonly rates: RatesService,
    private readonly period: PeriodService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly history: HistoryRepository,
    private readonly lots: LotsService,
    private readonly drivers: DriversService,
  ) {}

  /**
   * The Buys list (D-085) with its figures over the whole filter: how many buys and what they came
   * to (under `cost`, the bought-price flag's), and what we still owe the companies altogether
   * (under `owed_by_us`, the company-balances flag's) — the same for every filter, because it is
   * a fact about the accounts, not about the buys on the page.
   */
  async list(
    filters: PurchaseFilters,
    /** Whether the reader may see what we owe companies: only then is each row's payment read. */
    seesOwed = false,
  ): Promise<{
    items: PurchaseDto[];
    total: number;
    totals?: {
      buys: number;
      cost: { total_iqd: number; total_usd_cents: number };
      /** What we owe the dinar-account companies in dinars and the dollar-account ones in dollars. */
      owed_by_us?: { companies: number; owed_iqd: number; owed_usd_cents: number };
    };
  }> {
    // What we owe the companies altogether is the Purchases page's figure: a company's own
    // Purchases tab, and a printout's later pages, never show it, so they never pay for it.
    const wantsOwed = filters.totals !== false && !filters.company_id;
    const [{ rows, total, totals }, owed] = await Promise.all([
      this.purchases.list(filters),
      wantsOwed ? this.purchases.owedToCompanies() : Promise.resolve(null),
    ]);
    const items = rows.map((row) => toPurchaseDto(row, []));
    if (seesOwed) await this.withPayment(items);
    if (filters.totals === false) return { items, total };
    return {
      items,
      total,
      totals: {
        buys: totals.buys,
        cost: { total_iqd: totals.total_iqd, total_usd_cents: totals.total_usd_cents },
        ...(owed ? { owed_by_us: owed } : {}),
      },
    };
  }

  /**
   * Each listed purchase's payment state (D-085): what is still owed on it and whether it is
   * paid, partly paid or unpaid — the oldest-first figure its own page shows (FR-712), so the
   * list and the page never disagree. The allocation is per company, so it is made once for each
   * company on the page (a page is 25 rows, rarely more than a handful of companies) and in
   * parallel; a voided purchase, or one from no company, has no payment state.
   */
  private async withPayment(items: PurchaseDto[]): Promise<void> {
    const companies = new Map<string, Currency>();
    for (const item of items) {
      if (item.doc_status === 'active' && item.company_id && item.settlement_currency) {
        companies.set(item.company_id, item.settlement_currency);
      }
    }
    // A few companies at a time, not one query pair per company at once: a page of twenty-five
    // purchases from twenty-five suppliers must not take the whole connection pool (review).
    const pending = [...companies];
    const byPurchase = new Map<string, { remaining: number; total: number }>();
    const worker = async () => {
      for (let next = pending.shift(); next; next = pending.shift()) {
        const [companyId, settlement] = next;
        const { allocation } = await this.companiesService.allocationOf(this.database, companyId, settlement);
        for (const row of allocation.purchases) byPurchase.set(row.purchase_id, row);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PAYMENT_CONCURRENCY, pending.length) }, worker));
    for (const item of items) {
      const mine = item.doc_status === 'active' ? byPurchase.get(item.id) : undefined;
      if (!mine) continue;
      item.payment = {
        remaining: mine.remaining,
        status: mine.remaining <= 0 ? 'paid' : mine.remaining < mine.total ? 'partially_paid' : 'unpaid',
      };
    }
  }

  /**
   * Purchases by id, as the Purchases list sends them — with their payment state for a reader
   * who may see what we owe — in the order asked for (D-089).
   */
  async listItemsByIds(ids: readonly string[], seesOwed: boolean): Promise<PurchaseDto[]> {
    const byId = new Map((await this.purchases.rowsByIds(ids)).map((row) => [row.id, toPurchaseDto(row, [])]));
    const items = ids.map((id) => byId.get(id)).filter((dto): dto is PurchaseDto => dto !== undefined);
    if (seesOwed) await this.withPayment(items);
    return items;
  }

  async get(id: string): Promise<PurchaseDto> {
    const row = await this.requirePurchase(id);
    const lines = await this.purchases.linesOf(id);
    // On the purchase's own page and receipt: the driver's car and phone, beside the name (D-106).
    const driver = row.driver_id ? await this.drivers.get(row.driver_id) : null;
    return {
      ...toPurchaseDto(row, lines),
      driver: driver ? { name: driver.name, phone: driver.phone, car_number: driver.car_number } : null,
    };
  }

  private async requirePurchase(id: string): Promise<PurchaseListRow> {
    const row = await this.purchases.findById(id);
    if (!row) throw ApiError.notFound();
    return row;
  }

  async create(context: RequestContext, input: CreatePurchaseInput): Promise<PurchaseDto> {
    this.period.assertNotFuture(input.purchase_date, 'purchase_date');
    if (input.lines.length === 0) {
      throw ApiError.validation([
        {
          path: 'lines',
          code: 'REQUIRED',
          message_key: 'errors:field.required',
          params: { field: 'lines' },
        },
      ]);
    }

    const company = input.company_id ? await this.companies.findById(input.company_id) : null;
    if (input.company_id && !company) throw ApiError.notFound();
    this.assertMayPayNow(context, input);
    if (company) this.assertCompanyActive(company);

    const { rate, rateSource } = await this.rateFor(
      input.company_id ?? null,
      input.rate_iqd_per_usd,
    );
    const actingUserId = await this.actingUser(context, input.acting_user_id);

    const created = await this.database.transaction((tx) =>
      this.writePurchase(tx, context, input, company, rate, rateSource, actingUserId),
    );

    const dto = await this.get(created.id);
    return { ...dto, duplicate_item_warning: created.duplicates, paid_entry_id: created.paidEntryId };
  }

  /** A hidden company is not bought from (FR-701): show it again first. */
  private assertCompanyActive(company: { is_active: boolean }): void {
    if (company.is_active) return;
    throw ApiError.validation([
      { path: 'company_id', code: 'INACTIVE', message_key: 'errors:company_inactive', params: {} },
    ]);
  }

  /**
   * "Paid now" is a payment to the company, so it asks for what a payment asks for, and it needs a
   * company to have been paid (D-085). Checked before the transaction opens.
   */
  private assertMayPayNow(context: RequestContext, input: CreatePurchaseInput): void {
    if (!input.paid) return;
    if (!input.company_id) {
      throw ApiError.validation([
        { path: 'paid', code: 'NO_COMPANY', message_key: 'errors:paid_needs_company', params: {} },
      ]);
    }
    if (!can(context, 'companies.record_payment')) throw ApiError.permissionDenied('companies.record_payment');
  }

  /**
   * A buy of one material inside a transaction somebody else opened — creating a material *is*
   * buying it (D-062), so the material and its first buy are one decision: both are written or
   * neither is.
   */
  async createWithin(
    tx: Db,
    context: RequestContext,
    input: CreatePurchaseInput,
  ): Promise<{ id: string; paid_entry_id: string | null }> {
    this.period.assertNotFuture(input.purchase_date, 'purchase_date');
    // The first buy of a new material may name the company it came from (D-085).
    const company = input.company_id ? await this.companies.findById(input.company_id, tx) : null;
    if (input.company_id && !company) throw ApiError.notFound();
    if (company) this.assertCompanyActive(company);
    this.assertMayPayNow(context, input);
    const { rate, rateSource } = await this.rateFor(company?.id ?? null, input.rate_iqd_per_usd);
    const actingUserId = await this.actingUser(context, input.acting_user_id);
    const written = await this.writePurchase(tx, context, input, company, rate, rateSource, actingUserId);
    return { id: written.id, paid_entry_id: written.paidEntryId };
  }

  private async writePurchase(
    tx: Db,
    context: RequestContext,
    input: CreatePurchaseInput,
    company: NonNullable<Awaited<ReturnType<CompaniesRepository['findById']>>> | null,
    rate: Rate,
    rateSource: RateSource,
    actingUserId: string,
  ): Promise<{ id: string; duplicates: ReturnType<typeof duplicateItems>; paidEntryId: string | null }> {
    // A company is locked before its balance is touched (2.9.5); a stock-only purchase has
    // no counterparty to lock.
    const account = company ? await this.ledger.lockOwner(tx, company.id) : null;
    if (company && !account) throw ApiError.notFound();
    // The driver after the account and before the materials, as on an order (D-105, D-106).
    const driver = await this.drivers.requireForDocument(tx, input.driver_id ?? null);

    const lines = await this.prepareLines(tx, input.lines, input.purchase_date, rate, rateSource);
    const discount = this.discountPair(input.discount, rate, rateSource, lines);
    const totals = documentTotals(lines, {
      discount_iqd: discount.amount_iqd,
      discount_usd_cents: discount.amount_usd_cents,
    });

    const purchase = await this.purchases.createPurchase(
      {
        company_id: company?.id ?? null,
        purchase_date: input.purchase_date,
        acting_user_id: actingUserId,
        notes: input.notes?.trim() || null,
        driver_id: driver?.id ?? null,
        rate_iqd_per_usd: rate,
        rate_source: rateSource,
        discount_iqd: discount.amount_iqd,
        discount_usd_cents: discount.amount_usd_cents,
        created_by: context.userId,
      },
      tx,
    );
    await this.purchases.updatePurchase(
      purchase.id,
      purchase.version,
      { total_iqd: totals.total_iqd, total_usd_cents: totals.total_usd_cents },
      context.userId,
      tx,
    );

    const insertedLines = await this.purchases.insertLines(
      purchase.id,
      lines,
      context.userId,
      tx,
    );
    await this.writeStockIn(tx, context, input.purchase_date, insertedLines, lines);

    let paidEntryId: string | null = null;
    if (account) {
      await this.writeCompanyEntry(context, tx, account, {
        purchaseId: purchase.id,
        purchaseDate: input.purchase_date,
        totals,
        rate,
        rateSource,
      });
      if (input.paid) {
        paidEntryId = await this.writePaidNow(context, tx, account, {
          purchaseId: purchase.id,
          purchaseDate: input.purchase_date,
          totals,
          rate,
          rateSource,
          paid: input.paid,
          performedBy: actingUserId,
          note: paidNowNote(purchase.number),
        });
      }
    }

    await this.audit.record(
      context,
      {
        action: 'create',
        entity_type: 'purchase',
        entity_id: purchase.id,
        entity_label: `Purchase #${purchase.number}`,
        changes: {
          company_id: { old: null, new: company?.id ?? null },
          purchase_date: { old: null, new: input.purchase_date },
          ...(driver ? { driver: { old: null, new: driver.name } } : {}),
          rate_iqd_per_usd: { old: null, new: rate },
          lines: { old: null, new: lines.map(lineSummary) },
          purchase_total: {
            old: null,
            new: { iqd: totals.total_iqd, usd_cents: totals.total_usd_cents },
          },
        },
        note: input.notes?.trim() || null,
        related: {
          purchase_id: purchase.id,
          company_id: company?.id ?? null,
          ...(driver ? { driver_id: driver.id } : {}),
        },
      },
      tx,
    );

    return { id: purchase.id, duplicates: duplicateItems(lines), paidEntryId };
  }

  /**
   * A full replace within the rules of FR-405 and 2.5.3: reverse every live movement and the
   * company entry, write the new version, log a field-by-field diff.
   */
  async replace(
    context: RequestContext,
    id: string,
    input: CreatePurchaseInput & { version: number },
  ): Promise<PurchaseDto> {
    this.period.assertNotFuture(input.purchase_date, 'purchase_date');

    const existing = await this.requirePurchase(id);
    if (existing.status === 'void') throw new ApiError('DOCUMENT_VOID', { purchase_id: id });
    await this.assertMayEdit(context, existing);

    if ((input.company_id ?? null) !== existing.company_id) {
      // Moving a purchase to another company would move a debt between two balances: that is a
      // void and a new purchase, not an edit (the same rule as orders, REVIEW-I1 finding 11).
      throw ApiError.validation([
        {
          path: 'company_id',
          code: 'IMMUTABLE',
          message_key: 'errors:purchase_company_immutable',
          params: {},
        },
      ]);
    }

    // As an order edit: the buy keeps the rate it was made at unless a new one is typed (review).
    const { rate, rateSource } = input.rate_iqd_per_usd
      ? await this.rateFor(existing.company_id, input.rate_iqd_per_usd)
      : { rate: formatRate(existing.rate_iqd_per_usd), rateSource: existing.rate_source };
    const actingUserId = await this.actingUser(
      context,
      input.acting_user_id,
      existing.acting_user_id,
    );

    await this.database.transaction(async (tx) => {
      const purchase = await this.purchases.lock(id, tx);
      if (!purchase) throw ApiError.notFound();
      if (purchase.version !== input.version) throw await this.versionConflict(id);

      const account = purchase.company_id
        ? await this.ledger.lockOwner(tx, purchase.company_id)
        : null;
      if (purchase.company_id && !account) throw ApiError.notFound();
      const driverId = input.driver_id === undefined ? purchase.driver_id : input.driver_id;
      const driver = await this.drivers.requireForDocument(tx, driverId, purchase.driver_id);
      const driverBefore =
        purchase.driver_id === driver?.id ? (driver?.name ?? null) : await this.drivers.nameOf(purchase.driver_id, tx);

      const oldLines = await this.purchases.linesOf(id, tx);
      // The materials' locks, as a sale takes them, so no sale can be taking from this buy
      // while it is checked and rewritten (review: a sale costed from a voided buy).
      await this.lots.lockItems(tx, [...oldLines.map((line) => line.item_id), ...input.lines.map((line) => line.item_id)]);
      // A buy is the cost of every sale that took from it (D-062): once any of its stock has
      // gone out, rewriting it would change what those sales cost.
      if (await this.lots.anyTaken(tx, oldLines.map((line) => line.id))) {
        throw new ApiError('BUY_IN_USE', { purchase_id: id });
      }

      await this.stock.reverseLiveForRef(
        tx,
        { ref_type: 'purchase_line', ref_ids: oldLines.map((line) => line.id) },
        { created_by: context.userId, note: 'purchase edited', entry_date: input.purchase_date },
      );
      if (account) {
        await this.ledger.reverseLiveForDocument(context, tx, account, id, {
          note: 'purchase edited',
          entry_date: input.purchase_date,
          types: PURCHASE_DOCUMENT_TYPES,
          related: { purchase_id: id, company_id: account.id },
        });
      }

      const lines = await this.prepareLines(tx, input.lines, input.purchase_date, rate, rateSource, new Set(oldLines.map((line) => line.item_id)));
      const discount = this.discountPair(input.discount, rate, rateSource, lines);
      const totals = documentTotals(lines, {
        discount_iqd: discount.amount_iqd,
        discount_usd_cents: discount.amount_usd_cents,
      });

      await this.purchases.softDeleteLines(id, tx);
      const insertedLines = await this.purchases.insertLines(id, lines, context.userId, tx);
      await this.writeStockIn(tx, context, input.purchase_date, insertedLines, lines);

      const updated = await this.purchases.updatePurchase(
        id,
        input.version,
        {
          purchase_date: input.purchase_date,
          notes: input.notes?.trim() || null,
          driver_id: driver?.id ?? null,
          rate_iqd_per_usd: rate,
          rate_source: rateSource,
          discount_iqd: discount.amount_iqd,
          discount_usd_cents: discount.amount_usd_cents,
          total_iqd: totals.total_iqd,
          total_usd_cents: totals.total_usd_cents,
          acting_user_id: actingUserId,
        },
        context.userId,
        tx,
      );
      if (!updated) throw await this.versionConflict(id);

      if (account) {
        await this.writeCompanyEntry(context, tx, account, {
          purchaseId: id,
          purchaseDate: input.purchase_date,
          totals,
          rate,
          rateSource,
        });
        await this.assertNotBelowPaid(tx, account, id, totals, {
          total_iqd: Number(purchase.total_iqd),
          total_usd_cents: Number(purchase.total_usd_cents),
        });
      }

      await this.audit.record(
        context,
        {
          action: 'update',
          entity_type: 'purchase',
          entity_id: id,
          entity_label: `Purchase #${purchase.number}`,
          changes: {
            purchase_date: { old: purchase.purchase_date, new: input.purchase_date },
            ...(purchase.driver_id !== (driver?.id ?? null)
              ? { driver: { old: driverBefore, new: driver?.name ?? null } }
              : {}),
            rate_iqd_per_usd: { old: purchase.rate_iqd_per_usd, new: rate },
            lines: { old: oldLines.map(storedLineSummary), new: lines.map(lineSummary) },
            purchase_total: {
              old: { iqd: Number(purchase.total_iqd), usd_cents: Number(purchase.total_usd_cents) },
              new: { iqd: totals.total_iqd, usd_cents: totals.total_usd_cents },
            },
          },
          note: input.notes?.trim() || null,
          related: { purchase_id: id, company_id: purchase.company_id, ...(driver ? { driver_id: driver.id } : {}) },
        },
        tx,
      );
    });

    return this.get(id);
  }

  /**
   * Who brought it in, changed on its own (D-106): a purchase has no edit form, and a driver is no
   * reason to rewrite its lines, stock and account. The same people may do it as may edit it.
   */
  async setDriver(
    context: RequestContext,
    id: string,
    input: { driver_id: string | null; version: number },
  ): Promise<PurchaseDto> {
    const existing = await this.requirePurchase(id);
    if (existing.status === 'void') throw new ApiError('DOCUMENT_VOID', { purchase_id: id });
    await this.assertMayEdit(context, existing);

    await this.database.transaction(async (tx) => {
      const purchase = await this.purchases.lock(id, tx);
      if (!purchase) throw ApiError.notFound();
      if (purchase.version !== input.version) throw await this.versionConflict(id);
      if (purchase.driver_id === input.driver_id) return;

      const driver = await this.drivers.requireForDocument(tx, input.driver_id, purchase.driver_id);
      const before = await this.drivers.nameOf(purchase.driver_id, tx);
      const updated = await this.purchases.updatePurchase(id, input.version, { driver_id: driver?.id ?? null }, context.userId, tx);
      if (!updated) throw await this.versionConflict(id);
      await this.audit.record(
        context,
        {
          action: 'update',
          entity_type: 'purchase',
          entity_id: id,
          entity_label: `Purchase #${purchase.number}`,
          changes: { driver: { old: before, new: driver?.name ?? null } },
          related: { purchase_id: id, company_id: purchase.company_id, ...(driver ? { driver_id: driver.id } : {}) },
        },
        tx,
      );
    });
    return this.get(id);
  }

  /**
   * Void (FR-405): the company entry and every live movement are reversed, and so is the payment
   * written with the purchase as "paid now" (D-085) — a purchase typed twice was not paid twice.
   * The purchase is marked void with its reason; payments made to it afterwards stay on the
   * account, because that money did leave the till.
   */
  async void(
    context: RequestContext,
    id: string,
    input: { reason: string; version?: number; undo?: boolean },
  ): Promise<PurchaseDto> {
    const existing = await this.requirePurchase(id);
    if (existing.status === 'void') throw new ApiError('DOCUMENT_VOID', { purchase_id: id });

    if (input.undo) {
      const age = Date.now() - existing.created_at.getTime();
      if (existing.created_by !== context.userId || age > UNDO_WINDOW_MS) {
        throw ApiError.permissionDenied('purchases.void');
      }
    } else if (!can(context, 'purchases.void')) {
      throw ApiError.permissionDenied('purchases.void');
    }

    await this.database.transaction(async (tx) => {
      const purchase = await this.purchases.lock(id, tx);
      if (!purchase) throw ApiError.notFound();
      if (purchase.status === 'void') throw new ApiError('DOCUMENT_VOID', { purchase_id: id });

      const account = purchase.company_id
        ? await this.ledger.lockOwner(tx, purchase.company_id)
        : null;
      const lines = await this.purchases.linesOf(id, tx);
      // As on an edit: no sale may be taking from this buy while it is voided (review).
      await this.lots.lockItems(tx, lines.map((line) => line.item_id));
      if (await this.lots.anyTaken(tx, lines.map((line) => line.id))) {
        throw new ApiError('BUY_IN_USE', { purchase_id: id });
      }

      await this.stock.reverseLiveForRef(
        tx,
        { ref_type: 'purchase_line', ref_ids: lines.map((line) => line.id) },
        { created_by: context.userId, note: input.reason, entry_date: purchase.purchase_date },
      );
      if (account) {
        await this.ledger.reverseLiveForDocument(context, tx, account, id, {
          note: input.reason,
          entry_date: purchase.purchase_date,
          types: PURCHASE_DOCUMENT_TYPES,
          related: { purchase_id: id, company_id: account.id },
        });
        // The money paid with it goes back too; later payments stay (D-085).
        for (const entry of await this.paidNowEntries(tx, account, id)) {
          // Taking money back is the ledger's rule, not the void's: an administrator, or the one
          // who recorded it on the day — the undo, or a same-day mistake (second review).
          // Anyone else is told who may, rather than reversing a payment they could not.
          if (!mayReversePayment(entry, context, this.period.today())) {
            throw new ApiError('PAID_WITH_PURCHASE', { purchase_id: id });
          }
          await this.ledger.reverse(context, tx, account, entry.id, {
            note: input.reason,
            entry_date: purchase.purchase_date,
            related: { purchase_id: id, company_id: account.id },
          });
        }
      }

      const updated = await this.purchases.updatePurchase(
        id,
        input.version ?? purchase.version,
        {
          status: 'void',
          void_reason: input.reason,
          voided_by: context.userId,
          voided_at: new Date(),
        },
        context.userId,
        tx,
      );
      if (!updated) throw await this.versionConflict(id);

      await this.audit.record(
        context,
        {
          action: 'void',
          entity_type: 'purchase',
          entity_id: id,
          entity_label: `Purchase #${purchase.number}`,
          changes: { status: { old: 'active', new: 'void' } },
          note: input.reason,
          related: { purchase_id: id, company_id: purchase.company_id },
        },
        tx,
      );
    });

    return this.get(id);
  }

  async historyOf(id: string, options: { cursor?: string; limit?: number }) {
    const purchase = await this.requirePurchase(id);
    const [audit, entries] = await Promise.all([
      this.history.list({ entity_type: 'purchase', entity_id: id, ...options }),
      purchase.company_id
        ? this.ledger.entriesOfDocument(this.database, purchase.company_id, id)
        : Promise.resolve([]),
    ]);

    return {
      ...audit,
      ledger_entries: entries.map((entry) => ({
        id: entry.id,
        entry_type: entry.entry_type,
        entry_date: entry.entry_date,
        entered_currency: entry.entered_currency,
        rate_iqd_per_usd: entry.rate_iqd_per_usd,
        note: entry.note,
        voucher_number: entry.voucher_number ?? null,
        reverses_entry_id: entry.reverses_entry_id,
        // The amounts a purchase put on the account are purchase amounts: they travel under
        // `cost` so the same flag hides them here as on the document (spec 2.4.4, 2.6.2).
        cost: {
          amount_iqd: entry.amount_iqd,
          amount_usd_cents: entry.amount_usd_cents,
        },
      })),
    };
  }

  /**
   * "We owe for this purchase" (FR-712): the total, what is linked to it, its share of the
   * payments and credits that named no purchase, and what is left — all in the company's
   * settlement currency and all under `cost`, so one flag hides them together.
   *
   * The share is the reason this is not a single-row read: FR-712 defines remaining as the
   * total less the linked entries **less its oldest-first share of everything unlinked**, and
   * that depends on the company's other purchases. A stock-only purchase owes nobody, so every
   * figure is null (FR-407).
   */
  async balanceOf(id: string): Promise<{
    purchase_id: string;
    settlement_currency: Currency | null;
    cost: {
      total: number | null;
      linked: number | null;
      allocated: number | null;
      remaining: number | null;
    };
    /** What we owe the company altogether now, in its currency (D-111): the purchase receipt's red figure. */
    account_owed: number | null;
  }> {
    const purchase = await this.requirePurchase(id);
    if (!purchase.company_id || !purchase.settlement_currency) {
      return {
        purchase_id: id,
        settlement_currency: null,
        cost: { total: null, linked: null, allocated: null, remaining: null },
        account_owed: null,
      };
    }

    const settlement = purchase.settlement_currency;
    const [{ allocation }, accountOwed] = await Promise.all([
      this.companiesService.allocationOf(this.database, purchase.company_id, settlement),
      this.companies.balanceOf(purchase.company_id),
    ]);

    const mine = allocation.purchases.find((row) => row.purchase_id === id);
    return {
      purchase_id: id,
      settlement_currency: settlement,
      cost: {
        // A voided purchase is never allocated against, so it reports nothing owing (A-29).
        total: mine?.total ?? 0,
        linked: mine?.linked ?? 0,
        allocated: mine?.allocated ?? 0,
        remaining: mine?.remaining ?? 0,
      },
      account_owed: accountOwed,
    };
  }

  // ───────────────────────────── the pieces the writes share ─────────────────────────────

  /**
   * The rate for this purchase (2.3.3): the one typed for the deal, else the company's own
   * rate, else the global rate for a purchase that names no company.
   */
  private async rateFor(
    companyId: string | null,
    typed?: string | null,
  ): Promise<{ rate: Rate; rateSource: RateSource }> {
    if (typed) {
      const rate = formatRate(typed);
      if (Number(rate) <= 0) {
        throw ApiError.validation([
          {
            path: 'rate_iqd_per_usd',
            code: 'INVALID',
            message_key: 'errors:field.required',
            params: {},
          },
        ]);
      }
      return { rate, rateSource: 'manual' };
    }
    if (companyId) {
      const { rate, source } = await this.companiesService.rateFor(companyId);
      return { rate, rateSource: source };
    }
    return { rate: await this.rates.requireCurrent(), rateSource: 'global' };
  }

  /** Only an admin may record a purchase as done by somebody else (spec 2.7). */
  private actingUser(context: RequestContext, requested?: string | null, current?: string | null): Promise<string> {
    return resolveActingUser(this.database, context, requested, 'acting_user_id', current);
  }

  /** Creator, admin, or `purchases.edit` (FR-405). */
  private async assertMayEdit(context: RequestContext, purchase: PurchaseListRow): Promise<void> {
    const mayEdit =
      context.role === 'admin' ||
      purchase.created_by === context.userId ||
      can(context, 'purchases.edit');
    if (!mayEdit) throw ApiError.permissionDenied('purchases.edit');
  }

  /**
   * Every line: the priced measure, the price (defaulted from the month's **bought** price or
   * typed), and the totals by the entered-currency rule at the purchase's own rate (FR-402,
   * FR-408). A purchase line keeps no cost snapshot — it *is* the cost (D-021).
   */
  private async prepareLines(
    tx: Db,
    inputs: readonly PurchaseLineInput[],
    purchaseDate: string,
    rate: Rate,
    rateSource: RateSource,
    /** On an edit, the materials the document already had: deactivating one since must not lock
     * the document against every correction (review). A new line of it is still refused. */
    keptItemIds: ReadonlySet<string> = new Set(),
  ): Promise<PreparedLine[]> {
    const month = firstOfMonth(purchaseDate);
    const prepared: PreparedLine[] = [];

    for (const [index, input] of inputs.entries()) {
      const item = await this.items.findById(input.item_id, tx);
      if (!item) {
        throw ApiError.validation([
          {
            path: `lines.${index}.item_id`,
            code: 'NOT_FOUND',
            message_key: 'errors:field.required',
            params: {},
          },
        ]);
      }
      if (!item.is_active && !keptItemIds.has(item.id)) {
        throw ApiError.validation([
          {
            path: `lines.${index}.item_id`,
            code: 'INACTIVE',
            message_key: 'errors:material_inactive',
            params: { item: item.name },
          },
        ]);
      }

      const pricedMeasure: Measure = item.pricing_unit === 'per_piece' ? 'count' : 'kg';
      const qtyCount = input.qty_count ?? null;
      const qtyKg = input.qty_kg ?? null;
      const pricedQuantity = pricedMeasure === 'count' ? qtyCount : qtyKg;
      if (pricedQuantity === null || Number(pricedQuantity) <= 0) {
        throw ApiError.validation([
          {
            path: `lines.${index}.${pricedMeasure === 'count' ? 'qty_count' : 'qty_kg'}`,
            code: 'REQUIRED',
            message_key: 'errors:field.required',
            params: { field: pricedMeasure },
          },
        ]);
      }

      const prices = await this.items.pricesUpTo(item.id, month, tx);
      const boughtSelection = selectMonthPrice(prices, 'bought', purchaseDate);

      let unitPriceIqd: number;
      let unitPriceUsdCents: number;
      let enteredCurrency: Currency;
      let priceSource: 'month' | 'override';
      let monthPriceId: string | null;
      let priceFromMonth: string | null;
      let lineTotalIqd: number;
      let lineTotalUsdCents: number;
      let lineRate: Rate = rate;
      let lineRateSource: RateSource = rateSource;

      if (input.total) {
        // The simplest purchase (spec: "how much did you add, total"): the user gives the total
        // and it is stored as typed. The entered side is exact and the other is converted at the
        // rate; the unit price is derived from the total for the record and is never multiplied
        // back (2.3.4).
        const pair = completePair({
          amount: input.total.amount,
          currency: input.total.currency,
          rate,
          rate_source: rateSource,
          other_amount: input.total.other_amount ?? undefined,
        });
        lineTotalIqd = pair.amount_iqd;
        lineTotalUsdCents = pair.amount_usd_cents;
        const quantity = Number(pricedQuantity);
        unitPriceIqd = Math.round(lineTotalIqd / quantity);
        unitPriceUsdCents = Math.round(lineTotalUsdCents / quantity);
        enteredCurrency = input.total.currency;
        priceSource = 'override';
        monthPriceId = boughtSelection.row?.id ?? null;
        priceFromMonth = null;
        if (input.total.other_amount !== undefined && input.total.other_amount !== null) {
          lineRateSource = 'manual';
        }
      } else {
        let bothTyped = false;
        if (input.unit_price) {
          const pair = completePair({
            amount: input.unit_price.amount,
            currency: input.unit_price.currency,
            rate,
            rate_source: rateSource,
            other_amount: input.unit_price.other_amount ?? undefined,
          });
          unitPriceIqd = pair.amount_iqd;
          unitPriceUsdCents = pair.amount_usd_cents;
          enteredCurrency = input.unit_price.currency;
          priceSource = 'override';
          monthPriceId = boughtSelection.row?.id ?? null;
          priceFromMonth = null;
          bothTyped =
            input.unit_price.other_amount !== undefined && input.unit_price.other_amount !== null;
        } else {
          // The month price is taken in the currency it was typed in, and the *other* side is
          // calculated at the purchase's rate — which is what values a USD-settled company's
          // purchase at that company's rate even when the price was typed in dinars (2.3.3).
          const defaulted = defaultLinePrice(boughtSelection, rate);
          if (!defaulted) {
            throw ApiError.validation([
              {
                path: `lines.${index}.unit_price`,
                code: 'PRICE_REQUIRED',
                message_key: 'errors:price_required',
                params: { item: item.name },
              },
            ]);
          }
          unitPriceIqd = defaulted.unit_price_iqd;
          unitPriceUsdCents = defaulted.unit_price_usd_cents;
          enteredCurrency = defaulted.price_entered_currency;
          priceSource = 'month';
          monthPriceId = defaulted.month_price_id;
          priceFromMonth = defaulted.carried_forward ? defaulted.from_month : null;
        }

        const totals = computeLineTotals({
          priced_measure: pricedMeasure,
          qty_count: qtyCount,
          qty_kg: qtyKg,
          unit_price_iqd: unitPriceIqd,
          unit_price_usd_cents: unitPriceUsdCents,
          price_entered_currency: enteredCurrency,
          both_prices_typed: bothTyped,
          document_rate: rate,
          document_rate_source: rateSource,
        });
        lineTotalIqd = totals.line_total_iqd;
        lineTotalUsdCents = totals.line_total_usd_cents;
        lineRate = totals.rate_iqd_per_usd;
        lineRateSource = totals.rate_source;
      }

      prepared.push({
        line_no: index + 1,
        item_id: item.id,
        item_name: item.name,
        qty_count: qtyCount,
        qty_kg: qtyKg,
        priced_measure: pricedMeasure,
        unit_price_iqd: unitPriceIqd,
        unit_price_usd_cents: unitPriceUsdCents,
        price_entered_currency: enteredCurrency,
        price_source: priceSource,
        month_price_id: monthPriceId,
        rate_iqd_per_usd: lineRate,
        rate_source: lineRateSource,
        line_total_iqd: lineTotalIqd,
        line_total_usd_cents: lineTotalUsdCents,
        note: input.note?.trim() || null,
        price_from_month: priceFromMonth,
      });
    }

    return prepared;
  }

  /** Proposed — not requested (FR-616): a pair at the document rate, never above the lines. */
  private discountPair(
    input: CreatePurchaseInput['discount'],
    rate: Rate,
    rateSource: RateSource,
    lines: readonly NewPurchaseLine[],
  ) {
    if (!input || input.amount === 0) {
      return {
        amount_iqd: 0,
        amount_usd_cents: 0,
        entered_currency: null,
        rate_iqd_per_usd: rate,
        rate_source: rateSource,
      };
    }
    const pair = completePair({
      amount: Math.abs(input.amount),
      currency: input.currency,
      rate,
      rate_source: rateSource,
      other_amount:
        input.other_amount === undefined || input.other_amount === null
          ? undefined
          : Math.abs(input.other_amount),
    });

    const gross = documentTotals(lines);
    if (pair.amount_iqd > gross.total_iqd || pair.amount_usd_cents > gross.total_usd_cents) {
      throw ApiError.validation([
        {
          path: 'discount',
          code: 'DISCOUNT_TOO_LARGE',
          message_key: 'errors:discount_too_large',
          params: { total_iqd: gross.total_iqd, total_usd_cents: gross.total_usd_cents },
        },
      ]);
    }
    return pair;
  }

  /** One `purchase_in` movement per line, referencing the line it came from (FR-403). */
  private async writeStockIn(
    tx: Db,
    context: RequestContext,
    entryDate: string,
    inserted: readonly PurchaseLineRow[],
    prepared: readonly PreparedLine[],
  ): Promise<void> {
    for (const [index, line] of inserted.entries()) {
      const source = prepared[index] as PreparedLine;
      await this.stock.append(tx, {
        item_id: source.item_id,
        movement_type: 'purchase_in',
        // A measure the line did not carry stays null: "not recorded", never zero (2.2.3).
        qty_count: source.qty_count,
        qty_kg: source.qty_kg === null ? null : new Decimal(source.qty_kg).toFixed(3),
        entry_date: entryDate,
        ref_type: 'purchase_line',
        ref_id: line.id,
        note: null,
        created_by: context.userId,
      });
    }
  }

  /**
   * The company-ledger entry of a purchase (FR-404): it copies the purchase's two totals
   * exactly as stored — never a conversion of one of them — with the purchase's rate snapshot,
   * so a later rate change cannot move it.
   */
  private async writeCompanyEntry(
    context: RequestContext,
    tx: Db,
    account: LedgerAccount,
    input: {
      purchaseId: string;
      purchaseDate: string;
      totals: { total_iqd: number; total_usd_cents: number };
      rate: Rate;
      rateSource: RateSource;
    },
  ): Promise<void> {
    await this.ledger.write(
      context,
      tx,
      account,
      {
        entry_type: 'purchase',
        money: {
          amount_iqd: input.totals.total_iqd,
          amount_usd_cents: input.totals.total_usd_cents,
          entered_currency: null,
          rate_iqd_per_usd: input.rate,
          rate_source: input.rateSource,
        },
        entry_date: input.purchaseDate,
        performed_by_user_id: context.userId,
        refs: { purchase_id: input.purchaseId },
      },
      { related: { purchase_id: input.purchaseId, company_id: account.id } },
    );
  }

  /**
   * The payment of "paid now" (D-085): a `payment` row on the company's account naming this buy,
   * with a voucher number, dated the day of the buy and valued at the buy's own rate.
   *
   * "All of it" is the exact negation of the buy's two totals, so the buy lands on zero in both
   * currencies whatever the rate. A part is typed in either currency and filled at the buy's rate;
   * it may not come to more than the buy, because a buy cannot be paid twice over by mistake —
   * money paid ahead is a payment on the company's page, where it is a decision of its own.
   */
  private async writePaidNow(
    context: RequestContext,
    tx: Db,
    account: LedgerAccount,
    input: {
      purchaseId: string;
      purchaseDate: string;
      totals: { total_iqd: number; total_usd_cents: number };
      rate: Rate;
      rateSource: RateSource;
      paid: PaidNowInput;
      performedBy: string;
      note: string;
    },
  ): Promise<string> {
    const settlement = account.settlement_currency;
    const owed = settlement === 'IQD' ? input.totals.total_iqd : input.totals.total_usd_cents;
    if (owed <= 0) {
      throw ApiError.validation([
        { path: 'paid', code: 'NOTHING_OWED', message_key: 'errors:nothing_owed', params: {} },
      ]);
    }

    const money = input.paid.in_full
      ? {
          amount_iqd: -input.totals.total_iqd,
          amount_usd_cents: -input.totals.total_usd_cents,
          entered_currency: input.paid.currency ?? settlement,
          rate_iqd_per_usd: input.rate,
          rate_source: input.rateSource,
        }
      : completePair({
          amount: -Math.abs(input.paid.amount),
          currency: input.paid.currency,
          rate: input.rate,
          rate_source: input.rateSource,
          other_amount:
            input.paid.other_amount === undefined || input.paid.other_amount === null
              ? undefined
              : -Math.abs(input.paid.other_amount),
        });

    const paidInSettlement = -(settlement === 'IQD' ? money.amount_iqd : money.amount_usd_cents);
    if (paidInSettlement <= 0) {
      throw ApiError.validation([
        { path: 'paid.amount', code: 'REQUIRED', message_key: 'errors:field.required', params: { field: 'paid' } },
      ]);
    }
    if (paidInSettlement > owed) {
      throw ApiError.validation([
        {
          path: 'paid.amount',
          code: 'EXCEEDS_TOTAL',
          message_key: 'errors:paid_exceeds_buy',
          params: { total: owed, currency: settlement },
        },
      ]);
    }

    const result = await this.ledger.write(
      context,
      tx,
      account,
      {
        entry_type: 'payment',
        money,
        entry_date: input.purchaseDate,
        note: input.note,
        performed_by_user_id: input.performedBy,
        refs: { purchase_id: input.purchaseId },
        method: 'cash',
        assign_voucher_number: true,
      },
      { related: { purchase_id: input.purchaseId, company_id: account.id } },
    );
    return result.entry.id;
  }

  /**
   * The live "paid now" payment of a purchase: the payment that names it and was written in the
   * same transaction as its first company entry — one transaction, one `created_at` — which no
   * payment made afterwards can share. The note (`paidNowNote`) is for the reader, not the match,
   * so a change to its wording can never orphan an older row (second review).
   */
  private async paidNowEntries(tx: Db, account: LedgerAccount, purchaseId: string) {
    const entries = await this.ledger.entriesOfDocument(tx, account.id, purchaseId);
    const first = entries
      .filter((entry) => entry.entry_type === 'purchase' && entry.reverses_entry_id === null)
      .sort((a, b) => a.posting_seq - b.posting_seq)[0];
    if (!first) return [];
    return liveEntries(entries).filter(
      (entry) => entry.entry_type === 'payment' && entry.created_at.getTime() === first.created_at.getTime(),
    );
  }

  /**
   * An edit may not lower a purchase below what has been paid against it (D-085): the
   * "never more than the purchase" rule of paying now would otherwise be undone by editing the
   * purchase down afterwards. A payment made in error is reversed on the company's page first.
   */
  private async assertNotBelowPaid(
    tx: Db,
    account: LedgerAccount,
    purchaseId: string,
    totals: { total_iqd: number; total_usd_cents: number },
    before: { total_iqd: number; total_usd_cents: number },
  ): Promise<void> {
    // The live rows that name the purchase other than its own charge: payments, credits and
    // adjustments still standing. Not `purchase_linked_totals`, which also counts the reversal
    // of the purchase's previous version and so read every edit as an overpayment.
    const entries = await this.ledger.entriesOfDocument(tx, account.id, purchaseId);
    const settled = (entry: { amount_iqd: number; amount_usd_cents: number }) =>
      account.settlement_currency === 'IQD' ? entry.amount_iqd : entry.amount_usd_cents;
    const paid = -liveEntries(entries)
      .filter((entry) => entry.entry_type !== 'purchase')
      .reduce((sum, entry) => sum + settled(entry), 0);
    const inSettlement = (pair: { total_iqd: number; total_usd_cents: number }) =>
      account.settlement_currency === 'IQD' ? pair.total_iqd : pair.total_usd_cents;
    const total = inSettlement(totals);
    // Only an edit that *lowers* the purchase below what was paid is refused: one already paid
    // ahead (a later payment named it) can still have its date, notes or lines put right, and
    // may be raised (second review).
    if (paid > total && total < inSettlement(before)) {
      throw ApiError.validation([
        { path: 'lines', code: 'BELOW_PAID', message_key: 'errors:purchase_below_paid', params: {} },
      ]);
    }
  }

  private async versionConflict(id: string): Promise<ApiError> {
    const current = await this.purchases.findById(id);
    return new ApiError('VERSION_CONFLICT', {
      entity: 'purchase',
      version: current?.version ?? null,
    });
  }
}

/** The same material on two lines is legitimate (two price tiers) and warned about (FR-402). */
function duplicateItems(lines: readonly PreparedLine[]): { item_id: string; item_name: string }[] {
  const seen = new Map<string, string>();
  const duplicates = new Map<string, string>();
  for (const line of lines) {
    if (seen.has(line.item_id)) duplicates.set(line.item_id, line.item_name);
    else seen.set(line.item_id, line.item_name);
  }
  return [...duplicates].map(([item_id, item_name]) => ({ item_id, item_name }));
}

function lineSummary(line: PreparedLine) {
  return {
    item_id: line.item_id,
    item: line.item_name,
    qty_count: line.qty_count,
    qty_kg: line.qty_kg,
    unit_price: { iqd: line.unit_price_iqd, usd_cents: line.unit_price_usd_cents },
    line_total: { iqd: line.line_total_iqd, usd_cents: line.line_total_usd_cents },
    price_source: line.price_source,
  };
}

function storedLineSummary(line: PurchaseLineRow) {
  return {
    item_id: line.item_id,
    item: line.item_name ?? null,
    qty_count: line.qty_count,
    qty_kg: line.qty_kg,
    unit_price: { iqd: Number(line.unit_price_iqd), usd_cents: Number(line.unit_price_usd_cents) },
    line_total: { iqd: Number(line.line_total_iqd), usd_cents: Number(line.line_total_usd_cents) },
    price_source: line.price_source,
  };
}

function toPurchaseLineDto(line: PurchaseLineRow, purchaseMonth: string): PurchaseLineDto {
  return {
    id: line.id,
    line_no: line.line_no,
    item_id: line.item_id,
    item_name: line.item_name ?? '',
    qty_count: line.qty_count,
    qty_kg: line.qty_kg,
    priced_measure: line.priced_measure,
    rate_iqd_per_usd: line.rate_iqd_per_usd,
    rate_source: line.rate_source,
    note: line.note,
    cost: {
      unit_price_iqd: Number(line.unit_price_iqd),
      unit_price_usd_cents: Number(line.unit_price_usd_cents),
      price_entered_currency: line.price_entered_currency,
      price_source: line.price_source,
      // Set only when the price was carried forward from an earlier month (FR-306).
      price_from_month:
        line.price_source === 'month' && line.price_month && line.price_month !== purchaseMonth
          ? line.price_month
          : null,
      line_total_iqd: Number(line.line_total_iqd),
      line_total_usd_cents: Number(line.line_total_usd_cents),
    },
  };
}

function toPurchaseDto(row: PurchaseListRow, lines: readonly PurchaseLineRow[]): PurchaseDto {
  return {
    id: row.id,
    number: Number(row.number),
    company_id: row.company_id,
    company_name: row.company_name,
    settlement_currency: row.settlement_currency,
    purchase_date: row.purchase_date,
    acting_user_id: row.acting_user_id,
    acting_user_name: row.acting_user_name,
    notes: row.notes,
    driver_id: row.driver_id,
    driver_name: row.driver_name,
    rate_iqd_per_usd: row.rate_iqd_per_usd,
    rate_source: row.rate_source,
    doc_status: row.status,
    void_reason: row.void_reason,
    voided_by_name: row.voided_by_name,
    voided_at: row.voided_at?.toISOString() ?? null,
    line_count: Number(row.line_count ?? 0),
    item_names: row.item_names ?? null,
    cost: {
      discount_iqd: Number(row.discount_iqd),
      discount_usd_cents: Number(row.discount_usd_cents),
      total_iqd: Number(row.total_iqd),
      total_usd_cents: Number(row.total_usd_cents),
    },
    lines: lines.map((line) => toPurchaseLineDto(line, firstOfMonth(row.purchase_date))),
    version: row.version,
    created_at: row.created_at.toISOString(),
  };
}

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
import { allocateOldestFirst } from '@mizan/ledger';
import { AuditService } from '../audit/audit.service.js';
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
import { PurchasesRepository } from './purchases.repository.js';
import type {
  NewPurchaseLine,
  PurchaseFilters,
  PurchaseLineRow,
  PurchaseListRow,
} from './purchases.repository.js';

/** How long the creator may undo a purchase from the save toast (FR-405). */
const UNDO_WINDOW_MS = 8_000;

export interface PurchaseLineInput {
  item_id: string;
  qty_count?: number | null;
  qty_kg?: string | null;
  /** Omitted: the month's bought price applies. Given: an override, logged (FR-408). */
  unit_price?: { amount: number; currency: Currency; other_amount?: number | null } | null;
  note?: string | null;
}

export interface CreatePurchaseInput {
  /** Null = "No company (stock only)": stock moves and nobody is owed (FR-407). */
  company_id?: string | null;
  purchase_date: string;
  notes?: string | null;
  /** "Rate for this purchase" (2.3.3); the company's rate, or the global one, when absent. */
  rate_iqd_per_usd?: string | null;
  /** Proposed — not requested (FR-616). */
  discount?: { amount: number; currency: Currency; other_amount?: number | null } | null;
  lines: PurchaseLineInput[];
  acting_user_id?: string | null;
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
  rate_iqd_per_usd: Rate;
  rate_source: RateSource;
  doc_status: 'active' | 'void';
  void_reason: string | null;
  voided_by_name: string | null;
  voided_at: string | null;
  line_count: number;
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
  ) {}

  async list(filters: PurchaseFilters): Promise<{ items: PurchaseDto[]; total: number }> {
    const { rows, total } = await this.purchases.list(filters);
    return { items: rows.map((row) => toPurchaseDto(row, [])), total };
  }

  async get(id: string): Promise<PurchaseDto> {
    const row = await this.requirePurchase(id);
    const lines = await this.purchases.linesOf(id);
    return toPurchaseDto(row, lines);
  }

  private async requirePurchase(id: string): Promise<PurchaseListRow> {
    const row = await this.purchases.findById(id);
    if (!row) throw ApiError.notFound();
    return row;
  }

  async create(context: RequestContext, input: CreatePurchaseInput): Promise<PurchaseDto> {
    this.period.assertNotFuture(input.purchase_date, 'purchase_date');
    await this.period.assertNotLocked(input.purchase_date);
    if (input.lines.length === 0) {
      throw ApiError.validation([
        { path: 'lines', code: 'REQUIRED', message_key: 'errors:field.required', params: { field: 'lines' } },
      ]);
    }

    const company = input.company_id ? await this.companies.findById(input.company_id) : null;
    if (input.company_id && !company) throw ApiError.notFound();
    if (company && !company.is_active) {
      throw ApiError.validation([
        { path: 'company_id', code: 'INACTIVE', message_key: 'errors:company_inactive', params: {} },
      ]);
    }

    const { rate, rateSource } = await this.rateFor(input.company_id ?? null, input.rate_iqd_per_usd);
    const actingUserId = await this.actingUser(context, input.acting_user_id);

    const created = await this.database.transaction(async (tx) => {
      // A company is locked before its balance is touched (2.9.5); a stock-only purchase has
      // no counterparty to lock.
      const account = company ? await this.ledger.lockOwner(tx, company.id) : null;
      if (company && !account) throw ApiError.notFound();

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

      const insertedLines = await this.purchases.insertLines(purchase.id, lines, context.userId, tx);
      await this.writeStockIn(tx, context, input.purchase_date, insertedLines, lines);

      if (account) {
        await this.writeCompanyEntry(context, tx, account, {
          purchaseId: purchase.id,
          purchaseDate: input.purchase_date,
          totals,
          rate,
          rateSource,
        });
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
            rate_iqd_per_usd: { old: null, new: rate },
            lines: { old: null, new: lines.map(lineSummary) },
            purchase_total: { old: null, new: { iqd: totals.total_iqd, usd_cents: totals.total_usd_cents } },
          },
          note: input.notes?.trim() || null,
          related: {
            purchase_id: purchase.id,
            company_id: company?.id ?? null,
            assigned_user_id: company?.assigned_user_id ?? null,
          },
        },
        tx,
      );

      return { id: purchase.id, duplicates: duplicateItems(lines) };
    });

    const dto = await this.get(created.id);
    return { ...dto, duplicate_item_warning: created.duplicates };
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
    await this.period.assertNotLocked(input.purchase_date);

    const existing = await this.requirePurchase(id);
    if (existing.status === 'void') throw new ApiError('DOCUMENT_VOID', { purchase_id: id });
    await this.period.assertNotLocked(existing.purchase_date);
    await this.assertMayEdit(context, existing);

    if ((input.company_id ?? null) !== existing.company_id) {
      // Moving a purchase to another company would move a debt between two balances: that is a
      // void and a new purchase, not an edit (the same rule as orders, REVIEW-I1 finding 11).
      throw ApiError.validation([
        { path: 'company_id', code: 'IMMUTABLE', message_key: 'errors:purchase_company_immutable', params: {} },
      ]);
    }

    const { rate, rateSource } = await this.rateFor(existing.company_id, input.rate_iqd_per_usd);
    const actingUserId = await this.actingUser(context, input.acting_user_id ?? existing.acting_user_id);

    await this.database.transaction(async (tx) => {
      const purchase = await this.purchases.lock(id, tx);
      if (!purchase) throw ApiError.notFound();
      if (purchase.version !== input.version) throw await this.versionConflict(id);

      const account = purchase.company_id ? await this.ledger.lockOwner(tx, purchase.company_id) : null;
      if (purchase.company_id && !account) throw ApiError.notFound();

      if (await this.purchases.hasLinkedMoney(id, tx)) {
        const allowed = await this.settings.get('allow_edit_after_payment');
        if (!allowed) throw new ApiError('EDIT_WINDOW_CLOSED', { reason: 'payment_linked' });
      }

      const oldLines = await this.purchases.linesOf(id, tx);

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

      const lines = await this.prepareLines(tx, input.lines, input.purchase_date, rate, rateSource);
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
            rate_iqd_per_usd: { old: purchase.rate_iqd_per_usd, new: rate },
            lines: { old: oldLines.map(storedLineSummary), new: lines.map(lineSummary) },
            purchase_total: {
              old: { iqd: Number(purchase.total_iqd), usd_cents: Number(purchase.total_usd_cents) },
              new: { iqd: totals.total_iqd, usd_cents: totals.total_usd_cents },
            },
          },
          note: input.notes?.trim() || null,
          related: { purchase_id: id, company_id: purchase.company_id },
        },
        tx,
      );
    });

    return this.get(id);
  }

  /**
   * Void (FR-405): the company entry and every live movement are reversed, the purchase is
   * marked void with its reason, and payments already made stay on the account — the money did
   * leave the till.
   */
  async void(
    context: RequestContext,
    id: string,
    input: { reason: string; version?: number; undo?: boolean },
  ): Promise<PurchaseDto> {
    const existing = await this.requirePurchase(id);
    if (existing.status === 'void') throw new ApiError('DOCUMENT_VOID', { purchase_id: id });
    await this.period.assertNotLocked(existing.purchase_date);

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

      const account = purchase.company_id ? await this.ledger.lockOwner(tx, purchase.company_id) : null;
      const lines = await this.purchases.linesOf(id, tx);

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
      }

      const updated = await this.purchases.updatePurchase(
        id,
        input.version ?? purchase.version,
        { status: 'void', void_reason: input.reason, voided_by: context.userId, voided_at: new Date() },
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
      purchase.company_id ? this.ledger.entriesFor(this.database, purchase.company_id) : Promise.resolve([]),
    ]);

    return {
      ...audit,
      ledger_entries: entries
        .filter((entry) => entry.refs.purchase_id === id)
        .map((entry) => ({
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
    cost: { total: number | null; linked: number | null; allocated: number | null; remaining: number | null };
  }> {
    const purchase = await this.requirePurchase(id);
    if (!purchase.company_id || !purchase.settlement_currency) {
      return {
        purchase_id: id,
        settlement_currency: null,
        cost: { total: null, linked: null, allocated: null, remaining: null },
      };
    }

    const [entries, siblings] = await Promise.all([
      this.ledger.entriesFor(this.database, purchase.company_id),
      this.companies.purchasesForAllocation(purchase.company_id),
    ]);
    const settlement = purchase.settlement_currency;
    const allocation = allocateOldestFirst(
      entries,
      siblings.map((row) => ({
        id: row.id,
        total: settlement === 'IQD' ? Number(row.total_iqd) : Number(row.total_usd_cents),
        purchase_date: row.purchase_date,
        voided: row.status === 'void',
        number: Number(row.number),
      })),
      settlement,
    );

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
          { path: 'rate_iqd_per_usd', code: 'INVALID', message_key: 'errors:field.required', params: {} },
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
  private async actingUser(context: RequestContext, requested?: string | null): Promise<string> {
    if (!requested || requested === context.userId) return context.userId;
    if (context.role !== 'admin') throw ApiError.permissionDenied('admin');
    const { rowCount } = await this.database.query(
      'SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL AND is_active = true',
      [requested],
    );
    if (!rowCount) {
      throw ApiError.validation([
        { path: 'acting_user_id', code: 'NOT_FOUND', message_key: 'errors:field.required', params: {} },
      ]);
    }
    return requested;
  }

  /** Creator, admin, or `purchases.edit`; and only inside the window (FR-405). */
  private async assertMayEdit(context: RequestContext, purchase: PurchaseListRow): Promise<void> {
    const mayEdit =
      context.role === 'admin' || purchase.created_by === context.userId || can(context, 'purchases.edit');
    if (!mayEdit) throw ApiError.permissionDenied('purchases.edit');

    const windowDays = await this.settings.get('purchase_edit_window_days');
    if (windowDays !== null) {
      const days = daysBetween(purchase.purchase_date, this.period.today());
      if (days > windowDays) {
        throw new ApiError('EDIT_WINDOW_CLOSED', {
          window_days: windowDays,
          purchase_date: purchase.purchase_date,
        });
      }
    }
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
  ): Promise<PreparedLine[]> {
    const month = firstOfMonth(purchaseDate);
    const prepared: PreparedLine[] = [];

    for (const [index, input] of inputs.entries()) {
      const item = await this.items.findById(input.item_id, tx);
      if (!item) {
        throw ApiError.validation([
          { path: `lines.${index}.item_id`, code: 'NOT_FOUND', message_key: 'errors:field.required', params: {} },
        ]);
      }
      if (!item.is_active) {
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
        bothTyped = input.unit_price.other_amount !== undefined && input.unit_price.other_amount !== null;
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
        rate_iqd_per_usd: totals.rate_iqd_per_usd,
        rate_source: totals.rate_source,
        line_total_iqd: totals.line_total_iqd,
        line_total_usd_cents: totals.line_total_usd_cents,
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
        input.other_amount === undefined || input.other_amount === null ? undefined : Math.abs(input.other_amount),
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

  private async versionConflict(id: string): Promise<ApiError> {
    const current = await this.purchases.findById(id);
    return new ApiError('VERSION_CONFLICT', { entity: 'purchase', version: current?.version ?? null });
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

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
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
    rate_iqd_per_usd: row.rate_iqd_per_usd,
    rate_source: row.rate_source,
    doc_status: row.status,
    void_reason: row.void_reason,
    voided_by_name: row.voided_by_name,
    voided_at: row.voided_at?.toISOString() ?? null,
    line_count: Number(row.line_count ?? 0),
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

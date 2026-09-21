import { Injectable } from '@nestjs/common';
import { Decimal, firstOfMonth, selectMonthPrice } from '@mizan/money';
import type { Currency, Measure, PriceSource } from '@mizan/money';
import {
  ReturnNotAllowedError,
  damageCreditPrice,
  damageCreditValue,
  damageValue,
  initialReturnStatus,
  nextReturnStatus,
  stockEffectOf,
} from '@mizan/ledger';
import type { DamageAttribution, ReturnStatus, StockEffect } from '@mizan/ledger';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/errors.js';
import { can } from '../common/request-context.js';
import type { RequestContext } from '../common/request-context.js';
import { CompaniesService } from '../companies/companies.service.js';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';
import { HistoryRepository } from '../history/history.repository.js';
import { ItemsRepository } from '../items/items.repository.js';
import { PeriodService } from '../settings/period.service.js';
import { StockService } from '../stock/stock.service.js';
import { DamagesRepository } from './damages.repository.js';
import type { DamageFilters, DamageListRow, DamageTotals } from './damages.repository.js';

export interface DamageQuantityInput {
  qty_count?: number | null;
  qty_kg?: string | null;
}

export interface CreateDamageInput extends DamageQuantityInput {
  item_id: string;
  damage_date: string;
  reason?: string | null;
  attribution?: DamageAttribution;
  order_id?: string | null;
  company_id?: string | null;
  purchase_id?: string | null;
  is_returnable?: boolean;
  notes?: string | null;
  acting_user_id?: string | null;
}

export interface UpdateDamageInput extends DamageQuantityInput {
  version: number;
  damage_date?: string;
  reason?: string | null;
  attribution?: DamageAttribution;
  order_id?: string | null;
  company_id?: string | null;
  purchase_id?: string | null;
  is_returnable?: boolean;
  notes?: string | null;
  acting_user_id?: string | null;
}

export interface ReturnDamageInput {
  status: 'returned' | 'written_off';
  returned_at?: string | null;
  note?: string | null;
  /** Present when the return also credits the supplier (FR-805); omitted, it is a plain return. */
  credit?: {
    amount: number;
    currency: Currency;
    other_amount?: number | null;
    note?: string | null;
  } | null;
}

export interface DamageDto {
  id: string;
  number: number;
  item_id: string;
  item_name: string;
  priced_measure: Measure;
  qty_count: number | null;
  qty_kg: string | null;
  damage_date: string;
  acting_user_id: string;
  acting_user_name: string | null;
  reason: string | null;
  attribution: DamageAttribution;
  order_id: string | null;
  order_number: number | null;
  company_id: string | null;
  company_name: string | null;
  purchase_id: string | null;
  purchase_number: number | null;
  is_returnable: boolean;
  return_status: ReturnStatus;
  returned_at: string | null;
  returned_by_name: string | null;
  stock_effect: StockEffect;
  /** True once any credit names this record, on either side (FR-805, FR-806). */
  credited: boolean;
  notes: string | null;
  doc_status: 'active' | 'void';
  void_reason: string | null;
  voided_by_name: string | null;
  version: number;
  created_at: string;
  /** Stripped for a caller without `fields.see_bought_price` (FR-807, D-022). */
  cost: {
    est_value_iqd: number | null;
    est_value_usd_cents: number | null;
    est_value_source: PriceSource;
  };
}

export interface DamageDetailDto extends DamageDto {
  /** What the credit sheet opens with (A-39); null when nothing prices this material. */
  credit_prefill: {
    amount_iqd: number;
    amount_usd_cents: number;
    entered_currency: Currency;
    rate_iqd_per_usd: string;
    rate_source: string;
    source: 'purchase_line' | 'month' | 'fallback';
    from_month: string | null;
  } | null;
  credits: {
    side: 'company' | 'customer';
    owner_id: string;
    owner_name: string;
    entry_id: string;
    entry_date: string;
    settlement_currency: Currency;
    note: string | null;
    cost: { amount_iqd: number; amount_usd_cents: number };
  }[];
}

/**
 * Damaged items and returns (FR-801 to FR-807).
 *
 * A damage record is a document like an order or a purchase, and it follows the same three
 * rules: one transaction writes the record and its stock movement, an edit reverses what was
 * live and writes the new version, and a void reverses and marks. What it deliberately does
 * **not** do is move money: a return to a supplier becomes a company credit and a customer's
 * returned goods a customer credit, each an explicit action with its own permission (A-31).
 */
@Injectable()
export class DamagesService {
  constructor(
    private readonly database: Database,
    private readonly damages: DamagesRepository,
    private readonly items: ItemsRepository,
    private readonly companies: CompaniesService,
    private readonly stock: StockService,
    private readonly period: PeriodService,
    private readonly audit: AuditService,
    private readonly history: HistoryRepository,
  ) {}

  async list(filters: DamageFilters): Promise<{ items: DamageDto[]; total: number; totals: DamageTotals }> {
    const { rows, total, totals } = await this.damages.list(filters);
    return { items: rows.map(toDamageDto), total, totals };
  }

  async get(id: string): Promise<DamageDetailDto> {
    const row = await this.requireDamage(id);
    const [prefill, credits] = await Promise.all([this.creditPrefill(row), this.damages.creditsFor(id)]);
    return {
      ...toDamageDto(row),
      credit_prefill: prefill,
      credits: credits.map((credit) => ({
        side: credit.side,
        owner_id: credit.owner_id,
        owner_name: credit.owner_name,
        entry_id: credit.entry_id,
        entry_date: credit.entry_date,
        settlement_currency: credit.settlement_currency,
        note: credit.note,
        cost: { amount_iqd: Number(credit.amount_iqd), amount_usd_cents: Number(credit.amount_usd_cents) },
      })),
    };
  }

  private async requireDamage(id: string, tx?: Db): Promise<DamageListRow> {
    const row = await this.damages.findById(id, tx);
    if (!row) throw ApiError.notFound();
    return row;
  }

  // ─────────────────────────────── recording one (FR-801) ───────────────────────────────

  async create(context: RequestContext, input: CreateDamageInput): Promise<DamageDetailDto> {
    this.period.assertNotFuture(input.damage_date, 'damage_date');
    await this.period.assertNotLocked(input.damage_date);

    const attribution = input.attribution ?? 'none';
    const item = await this.items.findById(input.item_id);
    if (!item) {
      throw ApiError.validation([
        { path: 'item_id', code: 'NOT_FOUND', message_key: 'errors:field.required', params: {} },
      ]);
    }
    const pricedMeasure: Measure = item.pricing_unit === 'per_piece' ? 'count' : 'kg';
    const quantity = this.quantityOf(input, pricedMeasure);
    const links = await this.resolveLinks(attribution, input);
    const actingUserId = await this.actingUser(context, input.acting_user_id);
    const isReturnable = input.is_returnable ?? false;

    // The value of what was lost, snapshotted from the damage month's bought price (FR-807).
    const prices = await this.items.pricesUpTo(item.id, firstOfMonth(input.damage_date));
    const value = damageValue(
      { priced_measure: pricedMeasure, ...quantity },
      selectMonthPrice(prices, 'bought', input.damage_date),
    );
    const stockEffect = stockEffectOf(attribution);

    const created = await this.database.transaction(async (tx) => {
      const record = await this.damages.create(
        {
          item_id: item.id,
          qty_count: quantity.qty_count,
          qty_kg: quantity.qty_kg,
          damage_date: input.damage_date,
          acting_user_id: actingUserId,
          reason: input.reason?.trim() || null,
          attribution,
          order_id: links.order_id,
          company_id: links.company_id,
          purchase_id: links.purchase_id,
          is_returnable: isReturnable,
          return_status: initialReturnStatus(isReturnable),
          stock_effect: stockEffect,
          est_value_iqd: value.est_value_iqd,
          est_value_usd_cents: value.est_value_usd_cents,
          est_value_source: value.est_value_source,
          notes: input.notes?.trim() || null,
          created_by: context.userId,
        },
        tx,
      );

      if (stockEffect === 'reduced') {
        await this.writeDamageOut(tx, context, record.id, item.id, input.damage_date, quantity);
      }

      await this.audit.record(
        context,
        {
          action: 'create',
          entity_type: 'damage',
          entity_id: record.id,
          entity_label: `Damage #${record.number}`,
          changes: {
            item_id: { old: null, new: item.id },
            item: { old: null, new: item.name },
            quantity: { old: null, new: quantity },
            damage_date: { old: null, new: input.damage_date },
            attribution: { old: null, new: attribution },
            is_returnable: { old: null, new: isReturnable },
            stock_effect: { old: null, new: stockEffect },
            est_value: {
              old: null,
              new: { iqd: value.est_value_iqd, usd_cents: value.est_value_usd_cents, source: value.est_value_source },
            },
          },
          note: input.reason?.trim() || input.notes?.trim() || null,
          related: {
            damage_id: record.id,
            item_id: item.id,
            order_id: links.order_id,
            company_id: links.company_id,
            purchase_id: links.purchase_id,
          },
        },
        tx,
      );

      return record;
    });

    return this.get(created.id);
  }

  /**
   * An edit (FR-804): quantities, date, attribution, the returnable flag and the texts. A
   * change to the quantity or to the attribution rewrites the stock story by reversing what is
   * live and writing what is true now, exactly as an order or a purchase edit does (2.5.3).
   */
  async update(context: RequestContext, id: string, input: UpdateDamageInput): Promise<DamageDetailDto> {
    const existing = await this.requireDamage(id);
    if (existing.status === 'void') throw new ApiError('DOCUMENT_VOID', { damage_id: id });
    await this.period.assertNotLocked(existing.damage_date);

    const damageDate = input.damage_date ?? existing.damage_date;
    this.period.assertNotFuture(damageDate, 'damage_date');
    await this.period.assertNotLocked(damageDate);

    const attribution = input.attribution ?? existing.attribution;
    const pricedMeasure: Measure = existing.pricing_unit === 'per_piece' ? 'count' : 'kg';
    const quantity =
      input.qty_count === undefined && input.qty_kg === undefined
        ? { qty_count: existing.qty_count, qty_kg: existing.qty_kg }
        : this.quantityOf(input, pricedMeasure);
    const links = await this.resolveLinks(attribution, {
      order_id: input.order_id ?? (attribution === existing.attribution ? existing.order_id : null),
      company_id: input.company_id ?? (attribution === existing.attribution ? existing.company_id : null),
      purchase_id: input.purchase_id ?? (attribution === existing.attribution ? existing.purchase_id : null),
    });
    const isReturnable = input.is_returnable ?? existing.is_returnable;

    // A record already returned or credited is not re-opened by an edit: that is a void and a
    // new record, because the supplier has the goods and the ledger has the credit.
    if (existing.return_status !== 'pending' && existing.return_status !== 'not_returnable') {
      throw new ApiError('EDIT_WINDOW_CLOSED', { reason: 'return_recorded', return_status: existing.return_status });
    }

    const quantityChanged =
      String(quantity.qty_count ?? '') !== String(existing.qty_count ?? '') ||
      decimalsEqual(quantity.qty_kg, existing.qty_kg) === false;
    const attributionChanged = attribution !== existing.attribution;
    const dateChanged = damageDate !== existing.damage_date;

    const prices = await this.items.pricesUpTo(existing.item_id, firstOfMonth(damageDate));
    const value = damageValue(
      { priced_measure: pricedMeasure, ...quantity },
      selectMonthPrice(prices, 'bought', damageDate),
    );
    const stockEffect = stockEffectOf(attribution);

    await this.database.transaction(async (tx) => {
      const record = await this.damages.lock(id, tx);
      if (!record) throw ApiError.notFound();
      if (record.version !== input.version) throw await this.versionConflict(id);

      if (quantityChanged || attributionChanged || dateChanged) {
        await this.stock.reverseLiveForRef(
          tx,
          { ref_type: 'damage', ref_ids: [id] },
          { created_by: context.userId, note: 'damage record edited', entry_date: damageDate },
        );
        if (stockEffect === 'reduced') {
          await this.writeDamageOut(tx, context, id, record.item_id, damageDate, quantity);
        }
      }

      const updated = await this.damages.update(
        id,
        input.version,
        {
          qty_count: quantity.qty_count,
          qty_kg: quantity.qty_kg,
          damage_date: damageDate,
          acting_user_id: await this.actingUser(context, input.acting_user_id ?? record.acting_user_id),
          reason: input.reason === undefined ? record.reason : input.reason?.trim() || null,
          attribution,
          order_id: links.order_id,
          company_id: links.company_id,
          purchase_id: links.purchase_id,
          is_returnable: isReturnable,
          // The flag and the status move together, and a record that was returnable and is now
          // not becomes `not_returnable` rather than a pending return nobody expects (FR-803).
          return_status: isReturnable === existing.is_returnable ? record.return_status : initialReturnStatus(isReturnable),
          stock_effect: stockEffect === 'none' && record.stock_effect === 'returned_in' ? 'returned_in' : stockEffect,
          est_value_iqd: value.est_value_iqd,
          est_value_usd_cents: value.est_value_usd_cents,
          est_value_source: value.est_value_source,
          notes: input.notes === undefined ? record.notes : input.notes?.trim() || null,
        },
        context.userId,
        tx,
      );
      if (!updated) throw await this.versionConflict(id);

      await this.audit.record(
        context,
        {
          action: 'update',
          entity_type: 'damage',
          entity_id: id,
          entity_label: `Damage #${record.number}`,
          changes: {
            quantity: {
              old: { qty_count: record.qty_count, qty_kg: record.qty_kg },
              new: quantity,
            },
            damage_date: { old: record.damage_date, new: damageDate },
            attribution: { old: record.attribution, new: attribution },
            order_id: { old: record.order_id, new: links.order_id },
            company_id: { old: record.company_id, new: links.company_id },
            purchase_id: { old: record.purchase_id, new: links.purchase_id },
            is_returnable: { old: record.is_returnable, new: isReturnable },
            stock_effect: { old: record.stock_effect, new: updated.stock_effect },
            est_value: {
              old: {
                iqd: record.est_value_iqd === null ? null : Number(record.est_value_iqd),
                usd_cents: record.est_value_usd_cents === null ? null : Number(record.est_value_usd_cents),
              },
              new: { iqd: value.est_value_iqd, usd_cents: value.est_value_usd_cents },
            },
          },
          note: input.notes?.trim() || null,
          related: {
            damage_id: id,
            item_id: record.item_id,
            order_id: links.order_id,
            company_id: links.company_id,
            purchase_id: links.purchase_id,
          },
        },
        tx,
      );
    });

    return this.get(id);
  }

  /** A void (FR-804): every live movement is reversed and the record keeps its reason. */
  async void(context: RequestContext, id: string, input: { reason: string; version?: number }): Promise<DamageDetailDto> {
    const existing = await this.requireDamage(id);
    if (existing.status === 'void') throw new ApiError('DOCUMENT_VOID', { damage_id: id });
    await this.period.assertNotLocked(existing.damage_date);

    await this.database.transaction(async (tx) => {
      const record = await this.damages.lock(id, tx);
      if (!record) throw ApiError.notFound();
      if (record.status === 'void') throw new ApiError('DOCUMENT_VOID', { damage_id: id });

      await this.stock.reverseLiveForRef(
        tx,
        { ref_type: 'damage', ref_ids: [id] },
        { created_by: context.userId, note: input.reason, entry_date: record.damage_date },
      );

      const updated = await this.damages.update(
        id,
        input.version ?? record.version,
        { status: 'void', void_reason: input.reason, voided_by: context.userId, voided_at: new Date() },
        context.userId,
        tx,
      );
      if (!updated) throw await this.versionConflict(id);

      await this.audit.record(
        context,
        {
          action: 'void',
          entity_type: 'damage',
          entity_id: id,
          entity_label: `Damage #${record.number}`,
          changes: { status: { old: 'active', new: 'void' } },
          note: input.reason,
          related: { damage_id: id, item_id: record.item_id, company_id: record.company_id },
        },
        tx,
      );
    });

    return this.get(id);
  }

  // ─────────────────────────── returns and their credit (FR-803, FR-805) ───────────────────────────

  /**
   * "Mark returned" and "Written off" (FR-803), with the supplier credit of FR-805 when the
   * caller asks for it and holds `companies.record_credit`.
   *
   * The credit is a company-ledger row naming this record and the purchase the goods arrived
   * on, so the accounting tab, the purchase and the damage record all tell the same story. It
   * does **not** touch stock: the damage record already took the goods out (A-31).
   */
  async markReturn(context: RequestContext, id: string, input: ReturnDamageInput): Promise<DamageDetailDto> {
    const existing = await this.requireDamage(id);
    if (existing.status === 'void') throw new ApiError('DOCUMENT_VOID', { damage_id: id });
    await this.period.assertNotLocked(existing.damage_date);

    const withCredit = Boolean(input.credit);
    if (withCredit) {
      if (existing.attribution !== 'company' || !existing.company_id) {
        throw ApiError.validation([
          { path: 'credit', code: 'NOT_A_COMPANY_RETURN', message_key: 'errors:credit_needs_company', params: {} },
        ]);
      }
      if (!can(context, 'companies.record_credit')) throw ApiError.permissionDenied('companies.record_credit');
    }

    const action = withCredit ? 'credited' : input.status;
    let status: ReturnStatus;
    try {
      status = nextReturnStatus(existing.return_status, action);
    } catch (error) {
      if (error instanceof ReturnNotAllowedError) {
        throw ApiError.validation([
          {
            path: 'status',
            code: 'RETURN_NOT_ALLOWED',
            message_key: 'errors:return_not_allowed',
            params: { from: error.from, action: error.action },
          },
        ]);
      }
      throw error;
    }

    const returnedAt = input.returned_at ? new Date(`${input.returned_at}T12:00:00Z`) : new Date();

    // The credit is written through the company service, so it goes through the one ledger
    // writer with its lock, its balance before/after and its audit row (D-019).
    if (withCredit && input.credit) {
      await this.companies.recordEntry(context, existing.company_id as string, 'credit', {
        amount: input.credit.amount,
        currency: input.credit.currency,
        other_amount: input.credit.other_amount ?? null,
        entry_date: this.period.today(),
        note: input.credit.note?.trim() || input.note?.trim() || `returned on damage #${existing.number}`,
        purchase_id: existing.purchase_id,
        damage_id: id,
      });
    }

    await this.database.transaction(async (tx) => {
      const record = await this.damages.lock(id, tx);
      if (!record) throw ApiError.notFound();

      const updated = await this.damages.update(
        id,
        record.version,
        {
          return_status: status,
          returned_at: returnedAt,
          returned_by: context.userId,
        },
        context.userId,
        tx,
      );
      if (!updated) throw await this.versionConflict(id);

      await this.audit.record(
        context,
        {
          action: 'status_change',
          entity_type: 'damage',
          entity_id: id,
          entity_label: `Damage #${record.number}`,
          changes: { return_status: { old: record.return_status, new: status } },
          note: input.note?.trim() || input.credit?.note?.trim() || null,
          related: { damage_id: id, item_id: record.item_id, company_id: record.company_id },
        },
        tx,
      );
    });

    return this.get(id);
  }

  /**
   * "Return to stock" (FR-804): goods a customer brought back that turn out to be usable go
   * back in, explicitly and once. It is the only way `stock_effect` becomes `returned_in`, and
   * it exists only where the damage never left stock in the first place (A-30).
   */
  async returnToStock(context: RequestContext, id: string, input: { note?: string | null }): Promise<DamageDetailDto> {
    const existing = await this.requireDamage(id);
    if (existing.status === 'void') throw new ApiError('DOCUMENT_VOID', { damage_id: id });
    await this.period.assertNotLocked(existing.damage_date);

    if (existing.attribution !== 'customer_order') {
      throw ApiError.validation([
        {
          path: 'attribution',
          code: 'NOT_A_CUSTOMER_RETURN',
          message_key: 'errors:return_to_stock_customer_only',
          params: {},
        },
      ]);
    }
    if (existing.stock_effect === 'returned_in') {
      throw ApiError.validation([
        { path: 'stock_effect', code: 'ALREADY_RETURNED', message_key: 'errors:already_returned_to_stock', params: {} },
      ]);
    }

    await this.database.transaction(async (tx) => {
      const record = await this.damages.lock(id, tx);
      if (!record) throw ApiError.notFound();

      await this.stock.append(tx, {
        item_id: record.item_id,
        movement_type: 'return_in',
        qty_count: record.qty_count,
        qty_kg: record.qty_kg,
        entry_date: this.period.today(),
        ref_type: 'damage',
        ref_id: id,
        note: input.note?.trim() || 'usable — returned to stock',
        created_by: context.userId,
      });

      const updated = await this.damages.update(
        id,
        record.version,
        { stock_effect: 'returned_in' },
        context.userId,
        tx,
      );
      if (!updated) throw await this.versionConflict(id);

      await this.audit.record(
        context,
        {
          action: 'update',
          entity_type: 'damage',
          entity_id: id,
          entity_label: `Damage #${record.number}`,
          changes: { stock_effect: { old: record.stock_effect, new: 'returned_in' } },
          note: input.note?.trim() || null,
          related: { damage_id: id, item_id: record.item_id, order_id: record.order_id },
        },
        tx,
      );
    });

    return this.get(id);
  }

  async historyOf(id: string, options: { cursor?: string; limit?: number }) {
    await this.requireDamage(id);
    return this.history.list({ entity_type: 'damage', entity_id: id, ...options });
  }

  // ───────────────────────────── the pieces the writes share ─────────────────────────────

  /**
   * The quantity, with the priced measure required: a material priced per kilo needs kilos,
   * and the other measure is recorded when it was counted, never invented (FR-302, 2.2.3).
   */
  private quantityOf(
    input: DamageQuantityInput,
    pricedMeasure: Measure,
  ): { qty_count: number | null; qty_kg: string | null } {
    const qtyCount = input.qty_count ?? null;
    const qtyKg = input.qty_kg ?? null;
    const priced = pricedMeasure === 'count' ? qtyCount : qtyKg;
    if (priced === null || Number(priced) <= 0) {
      throw ApiError.validation([
        {
          path: pricedMeasure === 'count' ? 'qty_count' : 'qty_kg',
          code: 'REQUIRED',
          message_key: 'errors:field.required',
          params: { field: pricedMeasure },
        },
      ]);
    }
    return { qty_count: qtyCount, qty_kg: qtyKg === null ? null : new Decimal(qtyKg).toFixed(3) };
  }

  /**
   * The attribution and its links (FR-802). The database enforces that they agree; this
   * refuses the ones it cannot know: an order or a company that does not exist, a voided
   * document, or a purchase that belongs to another company.
   *
   * What it deliberately does **not** check is that the document contains the material: the
   * pickers filter by it (3.4.3), but an order edited afterwards may no longer carry the line
   * the goods came back from, and refusing the link then would leave the record unattributable
   * (D-026).
   */
  private async resolveLinks(
    attribution: DamageAttribution,
    input: { order_id?: string | null; company_id?: string | null; purchase_id?: string | null },
  ): Promise<{ order_id: string | null; company_id: string | null; purchase_id: string | null }> {
    if (attribution === 'customer_order') {
      const orderId = input.order_id ?? null;
      if (!orderId) {
        throw ApiError.validation([
          { path: 'order_id', code: 'REQUIRED', message_key: 'errors:field.required', params: { field: 'order_id' } },
        ]);
      }
      const { rows } = await this.database.query<{ status: string }>(
        `SELECT status::text AS status FROM orders WHERE id = $1 AND deleted_at IS NULL`,
        [orderId],
      );
      const order = rows[0];
      if (!order) {
        throw ApiError.validation([
          { path: 'order_id', code: 'NOT_FOUND', message_key: 'errors:field.required', params: {} },
        ]);
      }
      if (order.status === 'void') throw new ApiError('DOCUMENT_VOID', { order_id: orderId });
      return { order_id: orderId, company_id: null, purchase_id: null };
    }

    if (attribution === 'company') {
      const companyId = input.company_id ?? null;
      if (!companyId) {
        throw ApiError.validation([
          {
            path: 'company_id',
            code: 'REQUIRED',
            message_key: 'errors:field.required',
            params: { field: 'company_id' },
          },
        ]);
      }
      const { rows } = await this.database.query<{ id: string }>(
        'SELECT id FROM companies WHERE id = $1 AND deleted_at IS NULL',
        [companyId],
      );
      if (!rows[0]) {
        throw ApiError.validation([
          { path: 'company_id', code: 'NOT_FOUND', message_key: 'errors:field.required', params: {} },
        ]);
      }

      const purchaseId = input.purchase_id ?? null;
      if (purchaseId) {
        const purchase = await this.database.query<{ company_id: string | null; status: string }>(
          `SELECT company_id, status::text AS status FROM purchases WHERE id = $1 AND deleted_at IS NULL`,
          [purchaseId],
        );
        const row = purchase.rows[0];
        if (!row || row.company_id !== companyId) {
          throw ApiError.validation([
            { path: 'purchase_id', code: 'NOT_FOUND', message_key: 'errors:field.required', params: {} },
          ]);
        }
        if (row.status === 'void') throw new ApiError('DOCUMENT_VOID', { purchase_id: purchaseId });
      }
      return { order_id: null, company_id: companyId, purchase_id: purchaseId };
    }

    return { order_id: null, company_id: null, purchase_id: null };
  }

  /** Only an admin may record a damage as found by somebody else (spec 2.7). */
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

  /** One `damage_out` movement for the record's quantities, negated (2.5.1, FR-804). */
  private async writeDamageOut(
    tx: Db,
    context: RequestContext,
    damageId: string,
    itemId: string,
    entryDate: string,
    quantity: { qty_count: number | null; qty_kg: string | null },
  ): Promise<void> {
    await this.stock.append(tx, {
      item_id: itemId,
      movement_type: 'damage_out',
      // A measure the record did not carry stays null: "not recorded", never zero (2.2.3).
      qty_count: quantity.qty_count === null ? null : -quantity.qty_count,
      qty_kg: quantity.qty_kg === null ? null : new Decimal(quantity.qty_kg).negated().toFixed(3),
      entry_date: entryDate,
      ref_type: 'damage',
      ref_id: damageId,
      note: null,
      created_by: context.userId,
    });
  }

  /**
   * What the credit sheet opens with (A-39): the purchase line's bought price when the goods
   * arrived on one, else the month's, valued at the company's own rate (FR-805, 2.3.3).
   */
  private async creditPrefill(row: DamageListRow): Promise<DamageDetailDto['credit_prefill']> {
    if (row.attribution !== 'company' || !row.company_id) return null;

    const line = row.purchase_id ? await this.damages.purchaseLineFor(row.purchase_id, row.item_id) : null;
    const prices = await this.items.pricesUpTo(row.item_id, firstOfMonth(row.damage_date));
    const price = damageCreditPrice({
      purchase_line: line,
      month_price: selectMonthPrice(prices, 'bought', row.damage_date),
    });
    if (!price) return null;

    const { rate, source } = await this.companies.rateFor(row.company_id);
    const pricedMeasure: Measure = row.pricing_unit === 'per_piece' ? 'count' : 'kg';
    const totals = damageCreditValue(
      { priced_measure: pricedMeasure, qty_count: row.qty_count, qty_kg: row.qty_kg },
      price,
      rate,
      source,
    );

    return {
      amount_iqd: totals.line_total_iqd,
      amount_usd_cents: totals.line_total_usd_cents,
      entered_currency: price.price_entered_currency,
      rate_iqd_per_usd: totals.rate_iqd_per_usd,
      rate_source: totals.rate_source,
      source: price.source,
      from_month: price.from_month,
    };
  }

  private async versionConflict(id: string): Promise<ApiError> {
    const current = await this.damages.findById(id);
    return new ApiError('VERSION_CONFLICT', { entity: 'damage', version: current?.version ?? null });
  }
}

/** Three decimals compared as numbers, so "4.000" and "4" are the same quantity. */
function decimalsEqual(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return new Decimal(left).equals(new Decimal(right));
}

function toDamageDto(row: DamageListRow): DamageDto {
  return {
    id: row.id,
    number: Number(row.number),
    item_id: row.item_id,
    item_name: row.item_name,
    priced_measure: row.pricing_unit === 'per_piece' ? 'count' : 'kg',
    qty_count: row.qty_count,
    qty_kg: row.qty_kg,
    damage_date: row.damage_date,
    acting_user_id: row.acting_user_id,
    acting_user_name: row.acting_user_name,
    reason: row.reason,
    attribution: row.attribution,
    order_id: row.order_id,
    order_number: row.order_number === null ? null : Number(row.order_number),
    company_id: row.company_id,
    company_name: row.company_name,
    purchase_id: row.purchase_id,
    purchase_number: row.purchase_number === null ? null : Number(row.purchase_number),
    is_returnable: row.is_returnable,
    return_status: row.return_status,
    returned_at: row.returned_at?.toISOString() ?? null,
    returned_by_name: row.returned_by_name,
    stock_effect: row.stock_effect,
    credited: row.credited,
    notes: row.notes,
    doc_status: row.status,
    void_reason: row.void_reason,
    voided_by_name: row.voided_by_name,
    version: row.version,
    created_at: row.created_at.toISOString(),
    cost: {
      est_value_iqd: row.est_value_iqd === null ? null : Number(row.est_value_iqd),
      est_value_usd_cents: row.est_value_usd_cents === null ? null : Number(row.est_value_usd_cents),
      est_value_source: row.est_value_source,
    },
  };
}

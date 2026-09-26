import { Injectable } from '@nestjs/common';
import { completePair, firstOfMonth, priceSideOf, selectMonthPrice } from '@mizan/money';
import type { Currency, MonthPriceRow } from '@mizan/money';
import { pricedStock } from '@mizan/ledger';
import type { ItemStock } from '@mizan/ledger';
import { todayInBaghdad } from '@mizan/i18n';
import { normalizeForSearch } from '@mizan/text';
import { AuditService, diffOf } from '../audit/audit.service.js';
import { ApiError } from '../common/errors.js';
import { can } from '../common/request-context.js';
import type { RequestContext } from '../common/request-context.js';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';
import { HistoryRepository } from '../history/history.repository.js';
import { RatesService } from '../rates/rates.service.js';
import { PeriodService } from '../settings/period.service.js';
import { StockService } from '../stock/stock.service.js';
import { ItemsRepository } from './items.repository.js';
import type { ItemFilters, ItemListRow, StoredMonthPrice } from './items.repository.js';
import type { ItemDto, ItemRow, MonthPriceDto, PricePairDto, PricingUnit } from './item.types.js';

export interface CreateItemInput {
  name: string;
  pricing_unit: PricingUnit;
  code?: string | null;
  min_stock_count?: number | null;
  min_stock_kg?: string | null;
  notes?: string | null;
}

export interface UpdateItemInput extends Partial<CreateItemInput> {
  version: number;
}

/** One side of a month price as it arrives from a form: one currency typed, maybe both. */
export interface PriceInput {
  amount: number;
  currency: Currency;
  /** The calculated side, when the user overwrote it — stored as a manual rate (2.3.2). */
  other_amount?: number | null;
}

export interface SetMonthPricesInput {
  bought?: PriceInput | null;
  sale?: PriceInput | null;
  note?: string | null;
  version?: number | null;
}

export interface QuantityInput {
  qty_count?: number | null;
  qty_kg?: string | null;
}

@Injectable()
export class ItemsService {
  constructor(
    private readonly database: Database,
    private readonly items: ItemsRepository,
    private readonly stock: StockService,
    private readonly rates: RatesService,
    private readonly period: PeriodService,
    private readonly audit: AuditService,
    private readonly history: HistoryRepository,
  ) {}

  async list(filters: ItemFilters): Promise<{ items: ItemDto[]; total: number }> {
    const { rows, total } = await this.items.list(filters);
    return { items: rows.map(toItemDtoFromListRow), total };
  }

  async get(id: string): Promise<ItemDto> {
    const row = await this.items.findById(id);
    if (!row) throw ApiError.notFound();
    return this.detailOf(row);
  }

  /** The detail view: stock from the ledger, this month's prices with their fallback marker. */
  private async detailOf(row: ItemRow, tx?: Db): Promise<ItemDto> {
    const db = tx ?? this.database;
    const month = this.period.today();
    const [stats, prices] = await Promise.all([
      this.statsFor(db, row.id),
      this.items.pricesUpTo(row.id, firstOfMonth(month), db),
    ]);

    const sale = selectMonthPrice(prices, 'sale', month);
    const bought = selectMonthPrice(prices, 'bought', month);
    const priced = pricedStock(stats.stock, row.pricing_unit);

    return {
      id: row.id,
      name: row.name,
      code: row.code,
      pricing_unit: row.pricing_unit,
      notes: row.notes,
      is_active: row.is_active,
      min_stock_count: row.min_stock_count,
      min_stock_kg: row.min_stock_kg,
      stock: {
        stock_count: stats.stock.stock_count,
        stock_kg: stats.stock.stock_kg,
        count_complete: stats.stock.count_complete,
        kg_complete: stats.stock.kg_complete,
        priced_measure: priced.measure,
        priced_quantity: priced.quantity,
        priced_complete: priced.complete,
        is_low: isLow(row, priced.measure, priced.quantity),
      },
      first_bought_on: stats.first_bought_on,
      last_sold_on: stats.last_sold_on,
      sale: toPairDto(sale),
      bought: toPairDto(bought),
      version: row.version,
    };
  }

  /**
   * Stock and the two derived dates of FR-304 in one read of `item_stats`: the material card
   * shows them together, so it asks once.
   */
  private async statsFor(
    db: Db,
    itemId: string,
  ): Promise<{ stock: ItemStock; first_bought_on: string | null; last_sold_on: string | null }> {
    const { rows } = await db.query<{
      stock_count: string;
      stock_kg: string;
      count_complete: boolean;
      kg_complete: boolean;
      first_bought_on: string | null;
      last_sold_on: string | null;
    }>(
      `SELECT stock_count::text AS stock_count, stock_kg::text AS stock_kg,
              count_complete, kg_complete,
              to_char(first_bought_on, 'YYYY-MM-DD') AS first_bought_on,
              to_char(last_sold_on, 'YYYY-MM-DD') AS last_sold_on
         FROM item_stats WHERE item_id = $1`,
      [itemId],
    );
    const row = rows[0];
    if (!row) {
      return {
        stock: { stock_count: 0, stock_kg: '0.000', count_complete: true, kg_complete: true },
        first_bought_on: null,
        last_sold_on: null,
      };
    }
    return {
      stock: {
        stock_count: Number(row.stock_count),
        stock_kg: Number(row.stock_kg).toFixed(3),
        count_complete: row.count_complete,
        kg_complete: row.kg_complete,
      },
      first_bought_on: row.first_bought_on,
      last_sold_on: row.last_sold_on,
    };
  }

  /**
   * Creating a material (FR-301). The name is unique among the materials that still exist,
   * compared after script normalisation, so "کەرەستە" typed on an Arabic keyboard collides
   * with the same word typed on a Kurdish one instead of creating a twin (FR-1205).
   */
  async create(context: RequestContext, input: CreateItemInput): Promise<ItemDto> {
    const name = input.name.trim();
    const existing = await this.items.findByNormalizedName(normalizeForSearch(name));
    if (existing) {
      throw ApiError.validation([
        {
          path: 'name',
          code: 'DUPLICATE_NAME',
          message_key: 'errors:duplicate_material',
          params: { name: existing.name, id: existing.id },
        },
      ]);
    }

    const created = await this.database.transaction(async (tx) => {
      const row = await this.items.create(
        {
          name,
          code: input.code?.trim() || null,
          pricing_unit: input.pricing_unit,
          min_stock_count: input.min_stock_count ?? null,
          min_stock_kg: input.min_stock_kg ?? null,
          notes: input.notes?.trim() || null,
          created_by: context.userId,
        },
        tx,
      );

      await this.audit.record(
        context,
        {
          action: 'create',
          entity_type: 'item',
          entity_id: row.id,
          entity_label: `Material: ${row.name}`,
          changes: {
            name: { old: null, new: row.name },
            pricing_unit: { old: null, new: row.pricing_unit },
            code: { old: null, new: row.code },
          },
          related: { item_id: row.id },
        },
        tx,
      );
      return row;
    });

    return this.detailOf(created);
  }

  async update(context: RequestContext, id: string, input: UpdateItemInput): Promise<ItemDto> {
    const updated = await this.database.transaction(async (tx) => {
      const before = await this.items.lock(id, tx);
      if (!before) throw ApiError.notFound();

      const patch: Parameters<ItemsRepository['update']>[2] = {};
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (normalizeForSearch(name) !== before.name_normalized) {
          const clash = await this.items.findByNormalizedName(normalizeForSearch(name), tx);
          if (clash && clash.id !== id) {
            throw ApiError.validation([
              {
                path: 'name',
                code: 'DUPLICATE_NAME',
                message_key: 'errors:duplicate_material',
                params: { name: clash.name, id: clash.id },
              },
            ]);
          }
        }
        patch.name = name;
      }
      if (input.code !== undefined) patch.code = input.code?.trim() || null;
      if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
      if (input.min_stock_count !== undefined) patch.min_stock_count = input.min_stock_count;
      if (input.min_stock_kg !== undefined) patch.min_stock_kg = input.min_stock_kg;

      // Changing what a material is priced by rewrites the meaning of every line ever typed
      // for it, so it needs an admin once the material has moved — and it never recomputes a
      // line, which keeps its snapshot of the priced measure (FR-302).
      if (input.pricing_unit !== undefined && input.pricing_unit !== before.pricing_unit) {
        const referenced = await this.items.isReferenced(id, tx);
        if (referenced && context.role !== 'admin') {
          throw ApiError.permissionDenied('admin');
        }
        patch.pricing_unit = input.pricing_unit;
      }

      const row = await this.items.update(id, input.version, patch, context.userId, tx);
      if (!row) throw await this.versionConflict(id);

      const changes = diffOf({ ...before }, { ...patch }, [
        'name',
        'code',
        'pricing_unit',
        'notes',
        'min_stock_count',
        'min_stock_kg',
      ]);
      if (Object.keys(changes).length > 0) {
        await this.audit.record(
          context,
          {
            action: 'update',
            entity_type: 'item',
            entity_id: id,
            entity_label: `Material: ${row.name}`,
            changes,
            related: { item_id: id },
          },
          tx,
        );
      }
      return row;
    });

    return this.detailOf(updated);
  }

  /** Materials are deactivated, not deleted; deactivation is reversible and logged (FR-309). */
  async setActive(
    context: RequestContext,
    id: string,
    isActive: boolean,
    version: number,
  ): Promise<ItemDto> {
    const updated = await this.database.transaction(async (tx) => {
      const before = await this.items.lock(id, tx);
      if (!before) throw ApiError.notFound();
      if (before.is_active === isActive) return before;

      const row = await this.items.update(id, version, { is_active: isActive }, context.userId, tx);
      if (!row) throw await this.versionConflict(id);

      await this.audit.record(
        context,
        {
          action: 'status_change',
          entity_type: 'item',
          entity_id: id,
          entity_label: `Material: ${row.name}`,
          changes: { is_active: { old: before.is_active, new: isActive } },
          related: { item_id: id },
        },
        tx,
      );
      return row;
    });

    return this.detailOf(updated);
  }

  /**
   * The admin-only delete of FR-309: only a material with no movements, no lines and no
   * prices, and even then the row is not removed — `deleted_at` is set and the record leaves
   * every list, including the "inactive" filter (A-32).
   */
  async softDelete(context: RequestContext, id: string, version: number): Promise<void> {
    await this.database.transaction(async (tx) => {
      const before = await this.items.lock(id, tx);
      if (!before) throw ApiError.notFound();
      if (await this.items.isReferenced(id, tx)) {
        throw ApiError.validation([
          { path: 'id', code: 'REFERENCED', message_key: 'errors:record_referenced', params: {} },
        ]);
      }

      const row = await this.items.softDelete(id, version, context.userId, tx);
      if (!row) throw await this.versionConflict(id);

      await this.audit.record(
        context,
        {
          action: 'delete',
          entity_type: 'item',
          entity_id: id,
          entity_label: `Material: ${before.name}`,
          // A delete logs the whole record, because the row will not be visible again (2.4.4).
          changes: { snapshot: { old: { ...before }, new: null } },
          related: { item_id: id },
        },
        tx,
      );
    });
  }

  async prices(id: string): Promise<{ items: MonthPriceDto[] }> {
    if (!(await this.items.findById(id))) throw ApiError.notFound();
    const rows = await this.items.pricesOf(id);
    return { items: rows.map(toMonthPriceDto) };
  }

  /**
   * Setting a month's prices (FR-305). The user types one currency; the other is calculated at
   * the global rate at the time of entry and stored with it (A-37), so the pair keeps saying
   * what it was worth then. Past months can be edited — existing lines keep their snapshots.
   */
  async setMonthPrices(
    context: RequestContext,
    id: string,
    month: string,
    input: SetMonthPricesInput,
  ): Promise<MonthPriceDto> {
    const firstOf = firstOfMonth(month);
    if (!input.bought && !input.sale) {
      throw ApiError.validation([
        {
          path: 'sale',
          code: 'REQUIRED',
          message_key: 'errors:field.required',
          params: { field: 'sale' },
        },
      ]);
    }

    const rate = await this.rates.requireCurrent();

    const saved = await this.database.transaction(async (tx) => {
      const item = await this.items.lock(id, tx);
      if (!item) throw ApiError.notFound();
      const before = await this.items.priceForMonth(id, firstOf, tx);

      const bought = input.bought
        ? completePair({ ...input.bought, rate, rate_source: 'global' })
        : null;
      const sale = input.sale ? completePair({ ...input.sale, rate, rate_source: 'global' }) : null;

      // A side that is not sent keeps what it had: setting only the sale price of a month must
      // not erase the bought price somebody else typed.
      const row = await this.items.upsertMonthPrice(
        {
          item_id: id,
          month: firstOf,
          bought_iqd: bought ? bought.amount_iqd : (before?.bought_iqd ?? null),
          bought_usd_cents: bought ? bought.amount_usd_cents : (before?.bought_usd_cents ?? null),
          bought_entered_currency: bought
            ? bought.entered_currency
            : (before?.bought_entered_currency ?? null),
          bought_rate: bought ? bought.rate_iqd_per_usd : (before?.bought_rate ?? null),
          sale_iqd: sale ? sale.amount_iqd : (before?.sale_iqd ?? null),
          sale_usd_cents: sale ? sale.amount_usd_cents : (before?.sale_usd_cents ?? null),
          sale_entered_currency: sale
            ? sale.entered_currency
            : (before?.sale_entered_currency ?? null),
          sale_rate: sale ? sale.rate_iqd_per_usd : (before?.sale_rate ?? null),
          note: input.note?.trim() ? input.note.trim() : (before?.note ?? null),
          user_id: context.userId,
          version: input.version ?? before?.version ?? null,
        },
        tx,
      );
      if (!row) throw new ApiError('VERSION_CONFLICT', { entity: 'item_month_price' });

      await this.audit.record(
        context,
        {
          action: 'price_change',
          entity_type: 'item',
          entity_id: id,
          entity_label: `Material: ${item.name}`,
          changes: priceChanges(before, row),
          note: input.note?.trim() || null,
          related: { item_id: id, month: firstOf },
        },
        tx,
      );
      return row;
    });

    return toMonthPriceDto({ ...saved, updated_by_name: null });
  }

  /**
   * "Copy last month's prices to this month" for the start of the month (FR-305). Each
   * material is logged on its own, so History answers "who set September's prices".
   */
  async copyMonth(
    context: RequestContext,
    input: { source_month: string; target_month: string; item_ids?: string[] | null },
  ): Promise<{ copied: number; skipped: number }> {
    const source = firstOfMonth(input.source_month);
    const target = firstOfMonth(input.target_month);
    if (source === target) {
      throw ApiError.validation([
        { path: 'target_month', code: 'INVALID', message_key: 'errors:field.required', params: {} },
      ]);
    }

    return this.database.transaction(async (tx) => {
      const ids = await this.items.idsForCopy(input.item_ids ?? null, tx);
      let copied = 0;
      let skipped = 0;

      for (const id of ids) {
        const item = await this.items.lock(id, tx);
        if (!item) {
          skipped += 1;
          continue;
        }
        const from = await this.items.priceForMonth(id, source, tx);
        if (!from || (from.sale_iqd === null && from.bought_iqd === null)) {
          skipped += 1;
          continue;
        }
        const before = await this.items.priceForMonth(id, target, tx);

        const row = await this.items.upsertMonthPrice(
          {
            item_id: id,
            month: target,
            bought_iqd: from.bought_iqd,
            bought_usd_cents: from.bought_usd_cents,
            bought_entered_currency: from.bought_entered_currency,
            bought_rate: from.bought_rate,
            sale_iqd: from.sale_iqd,
            sale_usd_cents: from.sale_usd_cents,
            sale_entered_currency: from.sale_entered_currency,
            sale_rate: from.sale_rate,
            note: from.note,
            user_id: context.userId,
            version: before?.version ?? null,
          },
          tx,
        );
        if (!row) {
          skipped += 1;
          continue;
        }

        await this.audit.record(
          context,
          {
            action: 'price_change',
            entity_type: 'item',
            entity_id: id,
            entity_label: `Material: ${item.name}`,
            changes: priceChanges(before, row),
            note: `copied from ${source}`,
            related: { item_id: id, month: target },
          },
          tx,
        );
        copied += 1;
      }

      return { copied, skipped };
    });
  }

  async movements(id: string, options: { page?: number; page_size?: number }) {
    if (!(await this.items.findById(id))) throw ApiError.notFound();
    return this.stock.movementPage(this.database, id, options);
  }

  /**
   * Opening stock at go-live and stock corrections afterwards (FR-303, FR-308) — the same
   * permission covers both, and both are movements with a mandatory note rather than an edit
   * of a quantity, because stock is the sum of what happened.
   */
  async recordMovement(
    context: RequestContext,
    id: string,
    kind: 'opening' | 'adjustment',
    input: QuantityInput & {
      entry_date: string;
      note: string;
      unit_cost?: PriceInput | null;
    },
  ): Promise<ItemDto> {
    this.period.assertNotFuture(input.entry_date, 'entry_date');

    if ((input.qty_count ?? null) === null && (input.qty_kg ?? null) === null) {
      throw ApiError.validation([
        { path: 'qty_count', code: 'REQUIRED', message_key: 'errors:field.required', params: {} },
      ]);
    }
    // An opening quantity is what is there; a correction can go either way, but neither may be
    // a zero pretending to be a measure the movement did not carry (spec 2.2.3).
    if (kind === 'opening' && ((input.qty_count ?? 0) < 0 || Number(input.qty_kg ?? 0) < 0)) {
      throw ApiError.validation([
        { path: 'qty_count', code: 'INVALID', message_key: 'errors:field.required', params: {} },
      ]);
    }

    const rate = input.unit_cost ? await this.rates.requireCurrent() : null;

    const item = await this.database.transaction(async (tx) => {
      const row = await this.items.lock(id, tx);
      if (!row) throw ApiError.notFound();

      const cost =
        input.unit_cost && rate
          ? completePair({ ...input.unit_cost, rate, rate_source: 'global' })
          : null;

      const movement = await this.stock.append(tx, {
        item_id: id,
        movement_type: kind,
        qty_count: input.qty_count ?? null,
        qty_kg: input.qty_kg ?? null,
        entry_date: input.entry_date,
        ref_type: 'manual',
        ref_id: null,
        unit_cost_iqd: cost?.amount_iqd ?? null,
        unit_cost_usd_cents: cost?.amount_usd_cents ?? null,
        note: input.note,
        created_by: context.userId,
      });

      const stock = await this.stock.stockFor(tx, id);
      await this.audit.record(
        context,
        {
          action: kind === 'opening' ? 'create' : 'update',
          entity_type: 'item',
          entity_id: id,
          entity_label: `Material: ${row.name}`,
          changes: {
            movement: {
              old: null,
              new: {
                type: kind,
                qty_count: movement.qty_count,
                qty_kg: movement.qty_kg,
                entry_date: movement.entry_date,
              },
            },
            stock: {
              old: null,
              new: { count: stock.stock_count, kg: stock.stock_kg },
            },
          },
          note: input.note,
          related: { item_id: id, stock_movement_id: movement.id },
        },
        tx,
      );
      return row;
    });

    return this.detailOf(item);
  }

  async historyOf(id: string, options: { cursor?: string; limit?: number }) {
    if (!(await this.items.findById(id))) throw ApiError.notFound();
    return this.history.list({ entity_type: 'item', entity_id: id, ...options });
  }

  /** 409 with the current representation, so the client can show the two side by side (2.9.5). */
  private async versionConflict(id: string): Promise<ApiError> {
    const current = await this.items.findById(id);
    return new ApiError('VERSION_CONFLICT', {
      entity: 'item',
      version: current?.version ?? null,
    });
  }

  /** Whether the caller may see bought prices at all, for the pickers that default a price. */
  canSeeBoughtPrice(context: RequestContext): boolean {
    return can(context, 'fields.see_bought_price');
  }
}

function isLow(row: ItemRow, measure: 'count' | 'kg', quantity: string): boolean {
  // Proposed — not requested (FR-310): the badge is the only behaviour that depends on it.
  if (measure === 'count') {
    return row.min_stock_count !== null && Number(quantity) <= row.min_stock_count;
  }
  return row.min_stock_kg !== null && Number(quantity) <= Number(row.min_stock_kg);
}

function toPairDto(selection: ReturnType<typeof selectMonthPrice>): PricePairDto | null {
  if (!selection.value || selection.source === 'none' || !selection.from_month) return null;
  return {
    amount_iqd: selection.value.amount_iqd,
    amount_usd_cents: selection.value.amount_usd_cents,
    entered_currency: selection.value.entered_currency,
    rate_iqd_per_usd: selection.value.rate,
    from_month: selection.from_month,
    source: selection.source,
  };
}

function toItemDtoFromListRow(row: ItemListRow): ItemDto {
  const stock = {
    stock_count: Number(row.stock_count),
    stock_kg: Number(row.stock_kg).toFixed(3),
    count_complete: row.count_complete,
    kg_complete: row.kg_complete,
  };
  const priced = pricedStock(stock, row.pricing_unit);
  const thisMonth = firstOfMonth(todayInBaghdad());

  const side = (
    month: string | null,
    amountIqd: string | null,
    amountUsd: string | null,
    currency: Currency | null,
    rate: string | null,
  ): PricePairDto | null =>
    month === null || amountIqd === null || amountUsd === null || currency === null || rate === null
      ? null
      : {
          amount_iqd: Number(amountIqd),
          amount_usd_cents: Number(amountUsd),
          entered_currency: currency,
          rate_iqd_per_usd: rate,
          from_month: month,
          source: month === thisMonth ? 'month' : 'fallback',
        };

  return {
    id: row.id,
    name: row.name,
    code: row.code,
    pricing_unit: row.pricing_unit,
    notes: row.notes,
    is_active: row.is_active,
    min_stock_count: row.min_stock_count,
    min_stock_kg: row.min_stock_kg,
    stock: {
      ...stock,
      priced_measure: priced.measure,
      priced_quantity: priced.quantity,
      priced_complete: priced.complete,
      is_low: isLow(row, priced.measure, priced.quantity),
    },
    first_bought_on: row.first_bought_on,
    last_sold_on: row.last_sold_on,
    sale: side(
      row.sale_month,
      row.sale_iqd,
      row.sale_usd_cents,
      row.sale_entered_currency,
      row.sale_rate,
    ),
    bought: side(
      row.bought_month,
      row.bought_iqd,
      row.bought_usd_cents,
      row.bought_entered_currency,
      row.bought_rate,
    ),
    version: row.version,
  };
}

function toMonthPriceDto(
  row: StoredMonthPrice & { updated_by_name: string | null },
): MonthPriceDto {
  const side = (which: 'bought' | 'sale') => {
    const value = priceSideOf(row, which);
    return value
      ? {
          amount_iqd: value.amount_iqd,
          amount_usd_cents: value.amount_usd_cents,
          entered_currency: value.entered_currency,
          rate_iqd_per_usd: value.rate,
        }
      : null;
  };

  return {
    id: row.id,
    month: row.month,
    sale: side('sale'),
    bought: side('bought'),
    note: row.note,
    version: row.version,
    updated_at: row.updated_at.toISOString(),
    updated_by_name: row.updated_by_name,
  };
}

/** The old → new of a price change, per side and per currency (spec 2.4.2, FR-305). */
function priceChanges(
  before: MonthPriceRow | null,
  after: MonthPriceRow,
): Record<string, { old: unknown; new: unknown }> {
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  for (const side of ['bought', 'sale'] as const) {
    const from = before ? priceSideOf(before, side) : null;
    const to = priceSideOf(after, side);
    if (from?.amount_iqd === to?.amount_iqd && from?.amount_usd_cents === to?.amount_usd_cents) {
      continue;
    }
    changes[side] = {
      old: from
        ? { iqd: from.amount_iqd, usd_cents: from.amount_usd_cents, rate: from.rate }
        : null,
      new: to ? { iqd: to.amount_iqd, usd_cents: to.amount_usd_cents, rate: to.rate } : null,
    };
  }
  return changes;
}

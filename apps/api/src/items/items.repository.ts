import { Injectable } from '@nestjs/common';
import { normalizeForSearch } from '@mizan/text';
import { firstOfMonth } from '@mizan/money';
import type { MonthPriceRow } from '@mizan/money';
import { todayInBaghdad } from '@mizan/i18n';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';
import type { ItemRow, PricingUnit } from './item.types.js';

/**
 * Column lists take the table alias they are read under, so the same list serves a plain
 * `SELECT … FROM items` and the aliased list query without any string surgery.
 */
function itemColumns(alias = 'items'): string {
  return [
    'id',
    'name',
    'name_normalized',
    'code',
    'pricing_unit::text AS pricing_unit',
    'min_stock_count',
    'min_stock_kg::text AS min_stock_kg',
    'notes',
    'is_active',
    'created_at',
    'updated_at',
    'deleted_at',
    'version',
  ]
    .map((field) => `${alias}.${field}`)
    .join(', ');
}

function priceColumns(alias = 'item_month_prices'): string {
  return [
    `${alias}.id`,
    `${alias}.item_id`,
    `to_char(${alias}.month, 'YYYY-MM-DD') AS month`,
    `${alias}.bought_iqd::text AS bought_iqd`,
    `${alias}.bought_usd_cents::text AS bought_usd_cents`,
    `${alias}.bought_entered_currency::text AS bought_entered_currency`,
    `${alias}.bought_rate::text AS bought_rate`,
    `${alias}.sale_iqd::text AS sale_iqd`,
    `${alias}.sale_usd_cents::text AS sale_usd_cents`,
    `${alias}.sale_entered_currency::text AS sale_entered_currency`,
    `${alias}.sale_rate::text AS sale_rate`,
    `${alias}.note`,
    `${alias}.version`,
    `${alias}.updated_at`,
    `${alias}.updated_by`,
  ].join(', ');
}

export interface ItemFilters {
  q?: string;
  pricing_unit?: PricingUnit;
  /** `in` = anything left in stock, `out` = nothing or less than nothing (FR-307). */
  stock?: 'in' | 'out';
  include_inactive?: boolean;
  page?: number;
  page_size?: number;
}

/** One row of the list query: the material, its stock and the prices that apply this month. */
export interface ItemListRow extends ItemRow {
  stock_count: string;
  stock_kg: string;
  count_complete: boolean;
  kg_complete: boolean;
  first_bought_on: string | null;
  last_sold_on: string | null;
  sale_month: string | null;
  sale_iqd: string | null;
  sale_usd_cents: string | null;
  sale_entered_currency: 'IQD' | 'USD' | null;
  sale_rate: string | null;
  bought_month: string | null;
  bought_iqd: string | null;
  bought_usd_cents: string | null;
  bought_entered_currency: 'IQD' | 'USD' | null;
  bought_rate: string | null;
}

interface RawMonthPriceRow {
  id: string;
  item_id: string;
  month: string;
  bought_iqd: string | null;
  bought_usd_cents: string | null;
  bought_entered_currency: 'IQD' | 'USD' | null;
  bought_rate: string | null;
  sale_iqd: string | null;
  sale_usd_cents: string | null;
  sale_entered_currency: 'IQD' | 'USD' | null;
  sale_rate: string | null;
  note: string | null;
  version: number;
  updated_at: Date;
  updated_by: string;
}

export interface StoredMonthPrice extends MonthPriceRow {
  item_id: string;
  note: string | null;
  version: number;
  updated_at: Date;
  updated_by: string;
}

function toMonthPrice(row: RawMonthPriceRow): StoredMonthPrice {
  const amount = (value: string | null) => (value === null ? null : Number(value));
  return {
    id: row.id,
    item_id: row.item_id,
    month: row.month,
    bought_iqd: amount(row.bought_iqd),
    bought_usd_cents: amount(row.bought_usd_cents),
    bought_entered_currency: row.bought_entered_currency,
    bought_rate: row.bought_rate,
    sale_iqd: amount(row.sale_iqd),
    sale_usd_cents: amount(row.sale_usd_cents),
    sale_entered_currency: row.sale_entered_currency,
    sale_rate: row.sale_rate,
    note: row.note,
    version: row.version,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

/**
 * All SQL for materials, their monthly prices and the derived figures (decision D-008).
 *
 * The list query reads each material's stock and this month's prices through LATERAL
 * subqueries so both are served by the per-item indices — one index scan per row of the page
 * — rather than aggregating the whole stock ledger to show twenty-five materials (NFR-13).
 */
@Injectable()
export class ItemsRepository {
  constructor(private readonly database: Database) {}

  async findById(id: string, tx?: Db): Promise<ItemRow | null> {
    const { rows } = await (tx ?? this.database).query<ItemRow>(
      `SELECT ${itemColumns()} FROM items WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** Locks a material for the transaction, so two edits cannot interleave (spec 2.9.5). */
  async lock(id: string, tx: Db): Promise<ItemRow | null> {
    const { rows } = await tx.query<ItemRow>(
      `SELECT ${itemColumns()} FROM items WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findByNormalizedName(normalized: string, tx?: Db): Promise<ItemRow | null> {
    const { rows } = await (tx ?? this.database).query<ItemRow>(
      `SELECT ${itemColumns()} FROM items WHERE name_normalized = $1 AND deleted_at IS NULL`,
      [normalized],
    );
    return rows[0] ?? null;
  }

  async list(filters: ItemFilters): Promise<{ rows: ItemListRow[]; total: number }> {
    const month = firstOfMonth(todayInBaghdad());
    const conditions = ['i.deleted_at IS NULL'];
    // Filter parameters first, so the count query can be given exactly this prefix; the
    // month, page size and offset belong to the list query alone.
    const values: unknown[] = [];

    if (!filters.include_inactive) conditions.push('i.is_active = true');
    if (filters.pricing_unit) {
      values.push(filters.pricing_unit);
      conditions.push(`i.pricing_unit = $${values.length}::pricing_unit`);
    }
    const query = filters.q?.trim();
    if (query) {
      values.push(`%${normalizeForSearch(query)}%`);
      conditions.push(`(i.name_normalized LIKE $${values.length} OR i.code ILIKE $${values.length})`);
    }
    // The one filter whose cost grows with the number of movements: it has to know each
    // candidate's stock before it can page. The LATERAL keeps it to one index scan per
    // material; 2.2.6 records the upgrade path (a materialised sum) if it ever bites.
    if (filters.stock) {
      conditions.push(filters.stock === 'in' ? 'st.priced > 0' : 'st.priced <= 0');
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const stockLateral = `
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(CASE WHEN i.pricing_unit = 'per_piece' THEN s.qty_count ELSE s.qty_kg END), 0) AS priced,
               coalesce(sum(s.qty_count), 0) AS stock_count,
               coalesce(sum(s.qty_kg), 0) AS stock_kg,
               coalesce(bool_and(s.qty_count IS NOT NULL), true) AS count_complete,
               coalesce(bool_and(s.qty_kg IS NOT NULL), true) AS kg_complete
          FROM stock_ledger s
         WHERE s.item_id = i.id
      ) st ON true`;
    const from = `FROM items i${stockLateral}`;
    /**
     * The count is built from the narrowest `FROM` the filters actually need (the I3 review's
     * lesson, at the design point): summing the stock of **every** material to count them cost
     * 4.8 seconds at 5,000 materials and 1.2 million movements, for a figure that only depends
     * on the stock when somebody filters by it.
     */
    const countFrom = filters.stock ? from : 'FROM items i';

    const countValues = [...values];
    values.push(month);
    const monthParam = values.length;
    const pageSize = Math.min(filters.page_size ?? 25, 100);
    const offset = Math.max((filters.page ?? 1) - 1, 0) * pageSize;
    values.push(pageSize, offset);

    /**
     * The page is chosen **before** the per-material lookups run.
     *
     * Ordering by name with the lookups in the same `FROM` forced the planner to compute every
     * material's stock, its first purchase, its last sale and its two month prices — 5,000
     * materials' worth — and then throw away all but 25: 7.8 seconds at the design point of
     * NFR-13. Choosing the 25 ids first and hanging the lookups off those turns the same screen
     * into twenty-five index scans (I6 load test).
     */
    const page = `
      WITH page AS (
        SELECT i.id, i.name
          FROM items i${filters.stock ? stockLateral : ''}
         ${where}
         ORDER BY i.name ASC
         LIMIT $${values.length - 1} OFFSET $${values.length}
      )`;

    const [list, count] = await Promise.all([
      this.database.query<ItemListRow>(
        `${page}
         SELECT ${itemColumns('i')},
                st.stock_count::text AS stock_count, st.stock_kg::text AS stock_kg,
                st.count_complete, st.kg_complete,
                stats.first_bought_on, stats.last_sold_on,
                sale.month AS sale_month, sale.sale_iqd::text AS sale_iqd,
                sale.sale_usd_cents::text AS sale_usd_cents,
                sale.sale_entered_currency::text AS sale_entered_currency,
                sale.sale_rate::text AS sale_rate,
                bought.month AS bought_month, bought.bought_iqd::text AS bought_iqd,
                bought.bought_usd_cents::text AS bought_usd_cents,
                bought.bought_entered_currency::text AS bought_entered_currency,
                bought.bought_rate::text AS bought_rate
         FROM page
         JOIN items i ON i.id = page.id
         ${stockLateral}
         LEFT JOIN LATERAL (
           SELECT to_char(min(s.entry_date), 'YYYY-MM-DD') AS first_bought_on,
                  (SELECT to_char(max(o.order_date), 'YYYY-MM-DD')
                     FROM order_lines ol JOIN orders o ON o.id = ol.order_id
                    WHERE ol.item_id = i.id AND ol.deleted_at IS NULL
                      AND o.status = 'active' AND o.deleted_at IS NULL) AS last_sold_on
             FROM stock_ledger s
            WHERE s.item_id = i.id
              AND s.movement_type IN ('purchase_in', 'opening')
              AND NOT EXISTS (SELECT 1 FROM stock_ledger r WHERE r.reverses_entry_id = s.id)
         ) stats ON true
         ${monthPriceLateral('sale', monthParam)}
         ${monthPriceLateral('bought', monthParam)}
         ORDER BY i.name ASC`,
        values,
      ),
      this.database.query<{ total: string }>(
        `SELECT count(*)::text AS total ${countFrom} ${where}`,
        countValues,
      ),
    ]);

    return { rows: list.rows, total: Number(count.rows[0]?.total ?? 0) };
  }

  /** Every month price of one material, newest month first (FR-307 Prices tab). */
  async pricesOf(itemId: string, tx?: Db): Promise<(StoredMonthPrice & { updated_by_name: string | null })[]> {
    const { rows } = await (tx ?? this.database).query<RawMonthPriceRow & { updated_by_name: string | null }>(
      `SELECT ${priceColumns('p')}, u.display_name AS updated_by_name
         FROM item_month_prices p
         LEFT JOIN users u ON u.id = p.updated_by
        WHERE p.item_id = $1 AND p.deleted_at IS NULL
        ORDER BY p.month DESC`,
      [itemId],
    );
    return rows.map((row) => ({ ...toMonthPrice(row), updated_by_name: row.updated_by_name }));
  }

  /**
   * The rows the price lookup of FR-306 needs: this month's and every earlier month's, newest
   * first, so `selectMonthPrice` can carry a price forward. Limited because only the most
   * recent months can ever win, and a material priced monthly for five years has sixty rows.
   */
  async pricesUpTo(itemId: string, month: string, tx?: Db, limit = 24): Promise<StoredMonthPrice[]> {
    const { rows } = await (tx ?? this.database).query<RawMonthPriceRow>(
      `SELECT ${priceColumns()} FROM item_month_prices
        WHERE item_id = $1 AND deleted_at IS NULL AND month <= $2::date
        ORDER BY month DESC
        LIMIT $3`,
      [itemId, month, limit],
    );
    return rows.map(toMonthPrice);
  }

  async priceForMonth(itemId: string, month: string, tx?: Db): Promise<StoredMonthPrice | null> {
    const { rows } = await (tx ?? this.database).query<RawMonthPriceRow>(
      `SELECT ${priceColumns()} FROM item_month_prices
        WHERE item_id = $1 AND month = $2::date AND deleted_at IS NULL`,
      [itemId, month],
    );
    const row = rows[0];
    return row ? toMonthPrice(row) : null;
  }

  async create(
    input: {
      name: string;
      code: string | null;
      pricing_unit: PricingUnit;
      min_stock_count: number | null;
      min_stock_kg: string | null;
      notes: string | null;
      created_by: string;
    },
    tx?: Db,
  ): Promise<ItemRow> {
    const { rows } = await (tx ?? this.database).query<ItemRow>(
      `INSERT INTO items (name, name_normalized, code, pricing_unit, min_stock_count, min_stock_kg,
                          notes, created_by, updated_by)
       VALUES ($1, $2, $3, $4::pricing_unit, $5, $6::numeric, $7, $8, $8)
       RETURNING ${itemColumns()}`,
      [
        input.name,
        normalizeForSearch(input.name),
        input.code,
        input.pricing_unit,
        input.min_stock_count,
        input.min_stock_kg,
        input.notes,
        input.created_by,
      ],
    );
    return rows[0] as ItemRow;
  }

  /** Optimistic locking: a null return means the version the client sent was stale (2.9.5). */
  async update(
    id: string,
    version: number,
    patch: Partial<Pick<ItemRow, 'name' | 'code' | 'pricing_unit' | 'min_stock_count' | 'min_stock_kg' | 'notes' | 'is_active'>>,
    updatedBy: string,
    tx?: Db,
  ): Promise<ItemRow | null> {
    const fields = Object.keys(patch) as (keyof typeof patch)[];
    if (fields.length === 0) return this.findById(id, tx);

    const values: unknown[] = [id, version, updatedBy];
    const assignments: string[] = [];
    for (const field of fields) {
      values.push(patch[field] ?? null);
      assignments.push(`${field} = $${values.length}`);
      if (field === 'name') {
        values.push(normalizeForSearch(String(patch.name ?? '')));
        assignments.push(`name_normalized = $${values.length}`);
      }
    }

    const { rows } = await (tx ?? this.database).query<ItemRow>(
      `UPDATE items
          SET ${assignments.join(', ')}, updated_at = now(), updated_by = $3, version = version + 1
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL
        RETURNING ${itemColumns()}`,
      values,
    );
    return rows[0] ?? null;
  }

  async softDelete(id: string, version: number, deletedBy: string, tx: Db): Promise<ItemRow | null> {
    const { rows } = await tx.query<ItemRow>(
      `UPDATE items
          SET deleted_at = now(), deleted_by = $3, updated_at = now(), updated_by = $3, version = version + 1
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL
        RETURNING ${itemColumns()}`,
      [id, version, deletedBy],
    );
    return rows[0] ?? null;
  }

  /** A material may only be hidden while nothing references it (FR-309, A-32). */
  async isReferenced(id: string, tx?: Db): Promise<boolean> {
    const { rows } = await (tx ?? this.database).query<{ referenced: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM stock_ledger WHERE item_id = $1)
           OR EXISTS (SELECT 1 FROM order_lines WHERE item_id = $1)
           OR EXISTS (SELECT 1 FROM item_month_prices WHERE item_id = $1 AND deleted_at IS NULL)
              AS referenced`,
      [id],
    );
    return rows[0]?.referenced ?? true;
  }

  async upsertMonthPrice(
    input: {
      item_id: string;
      month: string;
      bought_iqd: number | null;
      bought_usd_cents: number | null;
      bought_entered_currency: string | null;
      bought_rate: string | null;
      sale_iqd: number | null;
      sale_usd_cents: number | null;
      sale_entered_currency: string | null;
      sale_rate: string | null;
      note: string | null;
      user_id: string;
      /** Sent on an update; a mismatch means someone else changed the row first (2.9.5). */
      version?: number | null;
    },
    tx: Db,
  ): Promise<StoredMonthPrice | null> {
    const existing = await this.priceForMonth(input.item_id, input.month, tx);

    if (!existing) {
      const { rows } = await tx.query<RawMonthPriceRow>(
        `INSERT INTO item_month_prices
           (item_id, month, bought_iqd, bought_usd_cents, bought_entered_currency, bought_rate,
            sale_iqd, sale_usd_cents, sale_entered_currency, sale_rate, note, created_by, updated_by)
         VALUES ($1, $2::date, $3, $4, $5::currency, $6::numeric, $7, $8, $9::currency, $10::numeric, $11, $12, $12)
         RETURNING ${priceColumns()}`,
        [
          input.item_id,
          input.month,
          input.bought_iqd,
          input.bought_usd_cents,
          input.bought_entered_currency,
          input.bought_rate,
          input.sale_iqd,
          input.sale_usd_cents,
          input.sale_entered_currency,
          input.sale_rate,
          input.note,
          input.user_id,
        ],
      );
      return toMonthPrice(rows[0] as RawMonthPriceRow);
    }

    const { rows } = await tx.query<RawMonthPriceRow>(
      `UPDATE item_month_prices
          SET bought_iqd = $3, bought_usd_cents = $4, bought_entered_currency = $5::currency,
              bought_rate = $6::numeric, sale_iqd = $7, sale_usd_cents = $8,
              sale_entered_currency = $9::currency, sale_rate = $10::numeric, note = $11,
              updated_at = now(), updated_by = $12, version = version + 1
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL
        RETURNING ${priceColumns()}`,
      [
        existing.id,
        input.version ?? existing.version,
        input.bought_iqd,
        input.bought_usd_cents,
        input.bought_entered_currency,
        input.bought_rate,
        input.sale_iqd,
        input.sale_usd_cents,
        input.sale_entered_currency,
        input.sale_rate,
        input.note,
        input.user_id,
      ],
    );
    const row = rows[0];
    return row ? toMonthPrice(row) : null;
  }

  /** The materials a "copy last month" covers: every active one, or the given selection. */
  async idsForCopy(itemIds: readonly string[] | null, tx?: Db): Promise<string[]> {
    if (itemIds && itemIds.length > 0) {
      const { rows } = await (tx ?? this.database).query<{ id: string }>(
        `SELECT id FROM items WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY name`,
        [[...itemIds]],
      );
      return rows.map((row) => row.id);
    }
    const { rows } = await (tx ?? this.database).query<{ id: string }>(
      `SELECT id FROM items WHERE deleted_at IS NULL AND is_active = true ORDER BY name`,
    );
    return rows.map((row) => row.id);
  }
}

/** The lateral that finds the price for a side: this month's, else the latest earlier one. */
function monthPriceLateral(side: 'sale' | 'bought', monthParam: number): string {
  return `
    LEFT JOIN LATERAL (
      SELECT to_char(p.month, 'YYYY-MM-DD') AS month,
             p.${side}_iqd, p.${side}_usd_cents, p.${side}_entered_currency, p.${side}_rate
        FROM item_month_prices p
       WHERE p.item_id = i.id AND p.deleted_at IS NULL AND p.month <= $${monthParam}::date
         AND p.${side}_iqd IS NOT NULL
       ORDER BY p.month DESC
       LIMIT 1
    ) ${side} ON true`;
}

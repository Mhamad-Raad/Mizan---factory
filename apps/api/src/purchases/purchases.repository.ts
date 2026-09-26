import { Injectable } from '@nestjs/common';
import { normalizeForSearch } from '@mizan/text';
import type { Currency, Measure, RateSource } from '@mizan/money';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';

export type PriceSource = 'month' | 'override';

export interface PurchaseRow {
  id: string;
  number: string;
  company_id: string | null;
  purchase_date: string;
  acting_user_id: string;
  notes: string | null;
  rate_iqd_per_usd: string;
  rate_source: RateSource;
  status: 'active' | 'void';
  void_reason: string | null;
  voided_by: string | null;
  voided_at: Date | null;
  discount_iqd: string;
  discount_usd_cents: string;
  total_iqd: string;
  total_usd_cents: string;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  version: number;
}

export interface PurchaseListRow extends PurchaseRow {
  company_name: string | null;
  settlement_currency: Currency | null;
  acting_user_name: string | null;
  voided_by_name: string | null;
  line_count: string;
}

export interface PurchaseLineRow {
  id: string;
  purchase_id: string;
  line_no: number;
  item_id: string;
  qty_count: number | null;
  qty_kg: string | null;
  priced_measure: Measure;
  unit_price_iqd: string;
  unit_price_usd_cents: string;
  price_entered_currency: Currency;
  price_source: PriceSource;
  month_price_id: string | null;
  rate_iqd_per_usd: string;
  rate_source: RateSource;
  line_total_iqd: string;
  line_total_usd_cents: string;
  note: string | null;
  item_name?: string;
  price_month?: string | null;
}

export interface NewPurchaseLine {
  line_no: number;
  item_id: string;
  qty_count: number | null;
  qty_kg: string | null;
  priced_measure: Measure;
  unit_price_iqd: number;
  unit_price_usd_cents: number;
  price_entered_currency: Currency;
  price_source: PriceSource;
  month_price_id: string | null;
  rate_iqd_per_usd: string;
  rate_source: RateSource;
  line_total_iqd: number;
  line_total_usd_cents: number;
  note: string | null;
}

export interface PurchaseFilters {
  company_id?: string;
  /** FR-802: the damage picker shows only the purchases that brought the material in. */
  item_id?: string;
  /** `stock_only` lists the purchases that name no company (FR-407). */
  company?: 'stock_only';
  from?: string;
  to?: string;
  done_by?: string;
  status?: 'active' | 'void';
  q?: string;
  include_undone?: boolean;
  page?: number;
  page_size?: number;
}

function purchaseColumns(alias = 'purchases'): string {
  return [
    'id',
    'number::text AS number',
    'company_id',
    "to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date",
    'acting_user_id',
    'notes',
    'rate_iqd_per_usd::text AS rate_iqd_per_usd',
    'rate_source::text AS rate_source',
    'status::text AS status',
    'void_reason',
    'voided_by',
    'voided_at',
    'discount_iqd::text AS discount_iqd',
    'discount_usd_cents::text AS discount_usd_cents',
    'total_iqd::text AS total_iqd',
    'total_usd_cents::text AS total_usd_cents',
    'created_at',
    'created_by',
    'updated_at',
    'version',
  ]
    .map((field) =>
      field.startsWith('to_char') ? field.replace('purchase_date', `${alias}.purchase_date`) : `${alias}.${field}`,
    )
    .join(', ');
}

const LINE_COLUMNS = `l.id, l.purchase_id, l.line_no, l.item_id, l.qty_count, l.qty_kg::text AS qty_kg,
                      l.priced_measure::text AS priced_measure,
                      l.unit_price_iqd::text AS unit_price_iqd,
                      l.unit_price_usd_cents::text AS unit_price_usd_cents,
                      l.price_entered_currency::text AS price_entered_currency,
                      l.price_source::text AS price_source, l.month_price_id,
                      l.rate_iqd_per_usd::text AS rate_iqd_per_usd,
                      l.rate_source::text AS rate_source,
                      l.line_total_iqd::text AS line_total_iqd,
                      l.line_total_usd_cents::text AS line_total_usd_cents, l.note`;

/**
 * A purchase row carries no "remaining" column on purpose.
 *
 * FR-712 defines remaining as the total less the entries linked to it **and** its oldest-first
 * share of everything unlinked — and that share depends on the company's other purchases, so
 * it cannot be read from one row. Summing only the linked entries here would put a different,
 * larger figure beside the same purchase on the list than on its own page. The allocation is
 * computed instead: once per company for the breakdown, and on `/purchases/:id/balance`.
 */
const LIST_COLUMNS = `co.name AS company_name, co.settlement_currency::text AS settlement_currency,
                      u.display_name AS acting_user_name, v.display_name AS voided_by_name,
                      (SELECT count(*)::text FROM purchase_lines l
                        WHERE l.purchase_id = p.id AND l.deleted_at IS NULL) AS line_count`;

@Injectable()
export class PurchasesRepository {
  constructor(private readonly database: Database) {}

  async findById(id: string, tx?: Db): Promise<PurchaseListRow | null> {
    const { rows } = await (tx ?? this.database).query<PurchaseListRow>(
      `SELECT ${purchaseColumns('p')}, ${LIST_COLUMNS}
         FROM purchases p
         LEFT JOIN customers co ON co.id = p.company_id
         LEFT JOIN users u ON u.id = p.acting_user_id
         LEFT JOIN users v ON v.id = p.voided_by
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [id],
    );
    return rows[0] ?? null;
  }

  async lock(id: string, tx: Db): Promise<PurchaseRow | null> {
    const { rows } = await tx.query<PurchaseRow>(
      `SELECT ${purchaseColumns()} FROM purchases WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [id],
    );
    return rows[0] ?? null;
  }

  async list(filters: PurchaseFilters): Promise<{ rows: PurchaseListRow[]; total: number }> {
    const conditions = ['p.deleted_at IS NULL'];
    const values: unknown[] = [];

    if (filters.company_id) {
      values.push(filters.company_id);
      conditions.push(`p.company_id = $${values.length}::uuid`);
    }
    if (filters.company === 'stock_only') conditions.push('p.company_id IS NULL');
    if (filters.item_id) {
      values.push(filters.item_id);
      conditions.push(
        `EXISTS (SELECT 1 FROM purchase_lines pl
                  WHERE pl.purchase_id = p.id AND pl.deleted_at IS NULL
                    AND pl.item_id = $${values.length}::uuid)`,
      );
    }
    // The bound is converted, never the column, so `purchases_date_idx` serves the filter.
    if (filters.from) {
      values.push(filters.from);
      conditions.push(`p.purchase_date >= $${values.length}::date`);
    }
    if (filters.to) {
      values.push(filters.to);
      conditions.push(`p.purchase_date <= $${values.length}::date`);
    }
    if (filters.done_by) {
      values.push(filters.done_by);
      conditions.push(`p.acting_user_id = $${values.length}::uuid`);
    }
    if (filters.status) {
      values.push(filters.status);
      conditions.push(`p.status = $${values.length}::doc_status`);
    }
    if (!filters.include_undone) {
      conditions.push(`(p.status <> 'void' OR p.void_reason <> 'undo')`);
    }
    const query = filters.q?.trim();
    if (query) {
      values.push(`%${normalizeForSearch(query)}%`);
      const nameParam = values.length;
      values.push(`%${query}%`);
      const textParam = values.length;
      const asNumber = Number(query.replace(/\D/g, ''));
      values.push(Number.isFinite(asNumber) && asNumber > 0 ? asNumber : null);
      const numberParam = values.length;
      conditions.push(
        `(co.name_normalized LIKE $${nameParam} OR p.notes ILIKE $${textParam}` +
          ` OR ($${numberParam}::bigint IS NOT NULL AND p.number = $${numberParam}::bigint))`,
      );
    }

    const from = `
      FROM purchases p
      LEFT JOIN customers co ON co.id = p.company_id
      LEFT JOIN users u ON u.id = p.acting_user_id
      LEFT JOIN users v ON v.id = p.voided_by`;
    const where = `WHERE ${conditions.join(' AND ')}`;

    const countValues = [...values];
    const pageSize = Math.min(filters.page_size ?? 25, 100);
    const offset = Math.max((filters.page ?? 1) - 1, 0) * pageSize;
    values.push(pageSize, offset);

    const [list, count] = await Promise.all([
      this.database.query<PurchaseListRow>(
        `SELECT ${purchaseColumns('p')}, ${LIST_COLUMNS}
         ${from} ${where}
         ORDER BY p.purchase_date DESC, p.number DESC
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      ),
      this.database.query<{ total: string }>(`SELECT count(*)::text AS total ${from} ${where}`, countValues),
    ]);

    return { rows: list.rows, total: Number(count.rows[0]?.total ?? 0) };
  }

  async linesOf(purchaseId: string, tx?: Db): Promise<PurchaseLineRow[]> {
    const { rows } = await (tx ?? this.database).query<PurchaseLineRow>(
      `SELECT ${LINE_COLUMNS}, i.name AS item_name, to_char(mp.month, 'YYYY-MM-DD') AS price_month
         FROM purchase_lines l
         JOIN items i ON i.id = l.item_id
         LEFT JOIN item_month_prices mp ON mp.id = l.month_price_id
        WHERE l.purchase_id = $1 AND l.deleted_at IS NULL
        ORDER BY l.line_no ASC`,
      [purchaseId],
    );
    return rows;
  }

  async createPurchase(
    input: {
      company_id: string | null;
      purchase_date: string;
      acting_user_id: string;
      notes: string | null;
      rate_iqd_per_usd: string;
      rate_source: RateSource;
      discount_iqd: number;
      discount_usd_cents: number;
      created_by: string;
    },
    tx: Db,
  ): Promise<PurchaseRow> {
    const { rows } = await tx.query<PurchaseRow>(
      `INSERT INTO purchases (company_id, purchase_date, acting_user_id, notes, rate_iqd_per_usd,
                              rate_source, discount_iqd, discount_usd_cents, created_by, updated_by)
       VALUES ($1, $2::date, $3, $4, $5::numeric, $6::rate_source, $7, $8, $9, $9)
       RETURNING ${purchaseColumns()}`,
      [
        input.company_id,
        input.purchase_date,
        input.acting_user_id,
        input.notes,
        input.rate_iqd_per_usd,
        input.rate_source,
        input.discount_iqd,
        input.discount_usd_cents,
        input.created_by,
      ],
    );
    return rows[0] as PurchaseRow;
  }

  async insertLines(
    purchaseId: string,
    lines: readonly NewPurchaseLine[],
    createdBy: string,
    tx: Db,
  ): Promise<PurchaseLineRow[]> {
    const inserted: PurchaseLineRow[] = [];
    for (const line of lines) {
      const { rows } = await tx.query<PurchaseLineRow>(
        `INSERT INTO purchase_lines
           (purchase_id, line_no, item_id, qty_count, qty_kg, priced_measure, unit_price_iqd,
            unit_price_usd_cents, price_entered_currency, price_source, month_price_id,
            rate_iqd_per_usd, rate_source, line_total_iqd, line_total_usd_cents, note, created_by)
         VALUES ($1, $2, $3, $4, $5::numeric, $6::measure, $7, $8, $9::currency, $10::price_source,
                 $11, $12::numeric, $13::rate_source, $14, $15, $16, $17)
         RETURNING ${LINE_COLUMNS.replace(/l\./g, 'purchase_lines.')}`,
        [
          purchaseId,
          line.line_no,
          line.item_id,
          line.qty_count,
          line.qty_kg,
          line.priced_measure,
          line.unit_price_iqd,
          line.unit_price_usd_cents,
          line.price_entered_currency,
          line.price_source,
          line.month_price_id,
          line.rate_iqd_per_usd,
          line.rate_source,
          line.line_total_iqd,
          line.line_total_usd_cents,
          line.note,
          createdBy,
        ],
      );
      inserted.push(rows[0] as PurchaseLineRow);
    }
    return inserted;
  }

  /** An edit replaces the set: the old rows are soft-deleted, never overwritten (2.5.3). */
  async softDeleteLines(purchaseId: string, tx: Db): Promise<void> {
    await tx.query(
      'UPDATE purchase_lines SET deleted_at = now() WHERE purchase_id = $1 AND deleted_at IS NULL',
      [purchaseId],
    );
  }

  async updatePurchase(
    id: string,
    version: number,
    patch: Partial<{
      purchase_date: string;
      notes: string | null;
      rate_iqd_per_usd: string;
      rate_source: RateSource;
      discount_iqd: number;
      discount_usd_cents: number;
      total_iqd: number;
      total_usd_cents: number;
      acting_user_id: string;
      status: 'active' | 'void';
      void_reason: string | null;
      voided_by: string | null;
      voided_at: Date | null;
    }>,
    updatedBy: string,
    tx: Db,
  ): Promise<PurchaseRow | null> {
    const fields = Object.keys(patch) as (keyof typeof patch)[];
    if (fields.length === 0) return this.lock(id, tx);

    const values: unknown[] = [id, version, updatedBy];
    const assignments: string[] = [];
    for (const field of fields) {
      values.push(patch[field] ?? null);
      const cast =
        field === 'purchase_date'
          ? '::date'
          : field === 'rate_iqd_per_usd'
            ? '::numeric'
            : field === 'rate_source'
              ? '::rate_source'
              : field === 'status'
                ? '::doc_status'
                : '';
      assignments.push(`${field} = $${values.length}${cast}`);
    }

    const { rows } = await tx.query<PurchaseRow>(
      `UPDATE purchases
          SET ${assignments.join(', ')}, updated_at = now(), updated_by = $3, version = version + 1
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL
        RETURNING ${purchaseColumns()}`,
      values,
    );
    return rows[0] ?? null;
  }

  /** Whether any payment, credit or adjustment names this purchase — which closes the edit
   * window (FR-405). */
  async hasLinkedMoney(purchaseId: string, tx: Db): Promise<boolean> {
    const { rows } = await tx.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM company_ledger
          WHERE purchase_id = $1
            AND entry_type IN ('payment', 'credit', 'adjustment')
            AND NOT EXISTS (SELECT 1 FROM company_ledger r WHERE r.reverses_entry_id = company_ledger.id)
       ) AS exists`,
      [purchaseId],
    );
    return rows[0]?.exists ?? false;
  }
}

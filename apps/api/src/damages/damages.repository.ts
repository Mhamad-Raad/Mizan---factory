import { Injectable } from '@nestjs/common';
import type { DamageAttribution, ReturnStatus, StockEffect } from '@mizan/ledger';
import type { PriceSource } from '@mizan/money';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';

export interface DamageRow {
  id: string;
  number: string;
  item_id: string;
  qty_count: number | null;
  qty_kg: string | null;
  damage_date: string;
  acting_user_id: string;
  reason: string | null;
  attribution: DamageAttribution;
  order_id: string | null;
  company_id: string | null;
  purchase_id: string | null;
  is_returnable: boolean;
  return_status: ReturnStatus;
  returned_at: Date | null;
  returned_by: string | null;
  stock_effect: StockEffect;
  est_value_iqd: string | null;
  est_value_usd_cents: string | null;
  est_value_source: PriceSource;
  status: 'active' | 'void';
  void_reason: string | null;
  voided_by: string | null;
  voided_at: Date | null;
  notes: string | null;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  version: number;
}

export interface DamageListRow extends DamageRow {
  item_name: string;
  pricing_unit: 'per_piece' | 'per_kg';
  acting_user_name: string | null;
  returned_by_name: string | null;
  voided_by_name: string | null;
  company_name: string | null;
  order_number: string | null;
  purchase_number: string | null;
  customer_id: string | null;
  customer_name: string | null;
  /** Whether a credit already names this record, so the detail can say so (FR-805, FR-806). */
  credited: boolean;
}

export interface DamageFilters {
  item_id?: string;
  from?: string;
  to?: string;
  attribution?: DamageAttribution;
  return_status?: ReturnStatus;
  /** `pending` plus `returnable` is the chip of 3.3: everything still expected to go back. */
  returnable?: boolean;
  done_by?: string;
  company_id?: string;
  order_id?: string;
  purchase_id?: string;
  include_void?: boolean;
  q?: string;
  page?: number;
  page_size?: number;
}

export interface DamageTotals {
  records: number;
  qty_count: number;
  qty_kg: string;
  /** How many records in the period have no valued month price behind them (FR-807). */
  unvalued: number;
  /** Under `cost` so one flag hides the period's value and leaves its quantities (D-022). */
  cost: {
    est_value_iqd: number;
    est_value_usd_cents: number;
  };
}

export interface NewDamage {
  item_id: string;
  qty_count: number | null;
  qty_kg: string | null;
  damage_date: string;
  acting_user_id: string;
  reason: string | null;
  attribution: DamageAttribution;
  order_id: string | null;
  company_id: string | null;
  purchase_id: string | null;
  is_returnable: boolean;
  return_status: ReturnStatus;
  stock_effect: StockEffect;
  est_value_iqd: number | null;
  est_value_usd_cents: number | null;
  est_value_source: PriceSource;
  notes: string | null;
  created_by: string;
}

function damageColumns(alias = 'damages'): string {
  return [
    'id',
    'number::text AS number',
    'item_id',
    'qty_count',
    'qty_kg::text AS qty_kg',
    "to_char(damage_date, 'YYYY-MM-DD') AS damage_date",
    'acting_user_id',
    'reason',
    'attribution::text AS attribution',
    'order_id',
    'company_id',
    'purchase_id',
    'is_returnable',
    'return_status::text AS return_status',
    'returned_at',
    'returned_by',
    'stock_effect::text AS stock_effect',
    'est_value_iqd::text AS est_value_iqd',
    'est_value_usd_cents::text AS est_value_usd_cents',
    'est_value_source::text AS est_value_source',
    'status::text AS status',
    'void_reason',
    'voided_by',
    'voided_at',
    'notes',
    'created_at',
    'created_by',
    'updated_at',
    'version',
  ]
    .map((field) =>
      field.startsWith('to_char') ? field.replace('damage_date', `${alias}.damage_date`) : `${alias}.${field}`,
    )
    .join(', ');
}

/**
 * The names and numbers the list and the detail show beside a record. The credit flag is an
 * EXISTS over the two ledgers rather than a column on the record: a credit is a ledger row,
 * and asking the ledger is the only answer that cannot go stale (FR-805, FR-806).
 */
const LIST_COLUMNS = `i.name AS item_name, i.pricing_unit::text AS pricing_unit,
                      u.display_name AS acting_user_name,
                      r.display_name AS returned_by_name,
                      v.display_name AS voided_by_name,
                      co.name AS company_name,
                      o.number::text AS order_number,
                      o.customer_id AS customer_id,
                      cust.name AS customer_name,
                      p.number::text AS purchase_number,
                      (EXISTS (SELECT 1 FROM company_ledger cl WHERE cl.damage_id = d.id)
                       OR EXISTS (SELECT 1 FROM customer_ledger cu WHERE cu.damage_id = d.id)) AS credited`;

const JOINS = `
  JOIN items i ON i.id = d.item_id
  LEFT JOIN users u ON u.id = d.acting_user_id
  LEFT JOIN users r ON r.id = d.returned_by
  LEFT JOIN users v ON v.id = d.voided_by
  LEFT JOIN customers co ON co.id = d.company_id
  LEFT JOIN orders o ON o.id = d.order_id
  LEFT JOIN customers cust ON cust.id = o.customer_id
  LEFT JOIN purchases p ON p.id = d.purchase_id`;

/**
 * All SQL for damage records (decision D-008: repositories own the SQL, services own the
 * rules). There is no scope rule: damage belongs to the factory, and the filters of FR-801
 * are what narrows the list.
 */
@Injectable()
export class DamagesRepository {
  constructor(private readonly database: Database) {}

  async findById(id: string, tx?: Db): Promise<DamageListRow | null> {
    const { rows } = await (tx ?? this.database).query<DamageListRow>(
      `SELECT ${damageColumns('d')}, ${LIST_COLUMNS}
         FROM damages d ${JOINS}
        WHERE d.id = $1 AND d.deleted_at IS NULL`,
      [id],
    );
    return rows[0] ?? null;
  }

  async lock(id: string, tx: Db): Promise<DamageRow | null> {
    const { rows } = await tx.query<DamageRow>(
      `SELECT ${damageColumns()} FROM damages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * The filters of FR-801, shared by the list and its period totals.
   *
   * `needsItems` says whether the material table has to be joined at all: only the free-text
   * filter reads from it, and joining it for the totals costs the covering index — the sums
   * then read the heap, which is review pattern 2 (measured: 0.19 ms index-only against
   * 0.26 ms with the join for a month, at forty thousand records).
   */
  private conditions(filters: DamageFilters): { where: string; values: unknown[]; needsItems: boolean } {
    const conditions = ['d.deleted_at IS NULL'];
    const values: unknown[] = [];

    if (!filters.include_void) conditions.push("d.status = 'active'");
    if (filters.item_id) {
      values.push(filters.item_id);
      conditions.push(`d.item_id = $${values.length}::uuid`);
    }
    // The bound is cast, never the column, so `damages_date_idx` serves the filter.
    if (filters.from) {
      values.push(filters.from);
      conditions.push(`d.damage_date >= $${values.length}::date`);
    }
    if (filters.to) {
      values.push(filters.to);
      conditions.push(`d.damage_date <= $${values.length}::date`);
    }
    if (filters.attribution) {
      values.push(filters.attribution);
      conditions.push(`d.attribution = $${values.length}::damage_attribution`);
    }
    if (filters.return_status) {
      values.push(filters.return_status);
      conditions.push(`d.return_status = $${values.length}::return_status`);
    }
    if (filters.returnable) conditions.push('d.is_returnable = true');
    if (filters.done_by) {
      values.push(filters.done_by);
      conditions.push(`d.acting_user_id = $${values.length}::uuid`);
    }
    if (filters.company_id) {
      values.push(filters.company_id);
      conditions.push(`d.company_id = $${values.length}::uuid`);
    }
    if (filters.order_id) {
      values.push(filters.order_id);
      conditions.push(`d.order_id = $${values.length}::uuid`);
    }
    if (filters.purchase_id) {
      values.push(filters.purchase_id);
      conditions.push(`d.purchase_id = $${values.length}::uuid`);
    }
    const query = filters.q?.trim();
    if (query) {
      values.push(`%${query}%`);
      const textParam = values.length;
      const asNumber = Number(query.replace(/\D/g, ''));
      values.push(Number.isFinite(asNumber) && asNumber > 0 ? asNumber : null);
      const numberParam = values.length;
      conditions.push(
        `(d.reason ILIKE $${textParam} OR d.notes ILIKE $${textParam} OR i.name ILIKE $${textParam}` +
          ` OR ($${numberParam}::bigint IS NOT NULL AND d.number = $${numberParam}::bigint))`,
      );
    }

    return { where: `WHERE ${conditions.join(' AND ')}`, values, needsItems: Boolean(query) };
  }

  async list(filters: DamageFilters): Promise<{ rows: DamageListRow[]; total: number; totals: DamageTotals }> {
    const { where, values, needsItems } = this.conditions(filters);
    const countValues = [...values];
    const totalsValues = [...values];
    // The list needs the names; the count and the totals need only the rows.
    const aggregateFrom = needsItems ? `FROM damages d JOIN items i ON i.id = d.item_id` : 'FROM damages d';

    const pageSize = Math.min(filters.page_size ?? 25, 100);
    const offset = Math.max((filters.page ?? 1) - 1, 0) * pageSize;
    values.push(pageSize, offset);

    const [list, count, totals] = await Promise.all([
      this.database.query<DamageListRow>(
        `SELECT ${damageColumns('d')}, ${LIST_COLUMNS}
           FROM damages d ${JOINS} ${where}
          ORDER BY d.damage_date DESC, d.number DESC
          LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      ),
      this.database.query<{ total: string }>(
        `SELECT count(*)::text AS total ${aggregateFrom} ${where}`,
        countValues,
      ),
      // The period totals of FR-807, over the whole filter rather than the page — which is the
      // figure an owner asks for ("what did we lose this month?").
      this.database.query<{
        records: string;
        qty_count: string;
        qty_kg: string;
        est_value_iqd: string;
        est_value_usd_cents: string;
        unvalued: string;
      }>(
        `SELECT count(*)::text AS records,
                coalesce(sum(d.qty_count), 0)::text AS qty_count,
                coalesce(sum(d.qty_kg), 0)::text AS qty_kg,
                coalesce(sum(d.est_value_iqd), 0)::text AS est_value_iqd,
                coalesce(sum(d.est_value_usd_cents), 0)::text AS est_value_usd_cents,
                count(*) FILTER (WHERE d.est_value_iqd IS NULL)::text AS unvalued
           ${aggregateFrom} ${where}`,
        totalsValues,
      ),
    ]);

    const row = totals.rows[0];
    return {
      rows: list.rows,
      total: Number(count.rows[0]?.total ?? 0),
      totals: {
        records: Number(row?.records ?? 0),
        qty_count: Number(row?.qty_count ?? 0),
        qty_kg: Number(row?.qty_kg ?? 0).toFixed(3),
        unvalued: Number(row?.unvalued ?? 0),
        cost: {
          est_value_iqd: Number(row?.est_value_iqd ?? 0),
          est_value_usd_cents: Number(row?.est_value_usd_cents ?? 0),
        },
      },
    };
  }

  async create(input: NewDamage, tx: Db): Promise<DamageRow> {
    const { rows } = await tx.query<DamageRow>(
      `INSERT INTO damages
         (item_id, qty_count, qty_kg, damage_date, acting_user_id, reason, attribution,
          order_id, company_id, purchase_id, is_returnable, return_status, stock_effect,
          est_value_iqd, est_value_usd_cents, est_value_source, notes, created_by, updated_by)
       VALUES ($1, $2, $3::numeric, $4::date, $5, $6, $7::damage_attribution, $8, $9, $10, $11,
               $12::return_status, $13::stock_effect, $14, $15, $16::cost_source, $17, $18, $18)
       RETURNING ${damageColumns()}`,
      [
        input.item_id,
        input.qty_count,
        input.qty_kg,
        input.damage_date,
        input.acting_user_id,
        input.reason,
        input.attribution,
        input.order_id,
        input.company_id,
        input.purchase_id,
        input.is_returnable,
        input.return_status,
        input.stock_effect,
        input.est_value_iqd,
        input.est_value_usd_cents,
        input.est_value_source,
        input.notes,
        input.created_by,
      ],
    );
    return rows[0] as DamageRow;
  }

  async update(
    id: string,
    version: number,
    patch: Partial<{
      qty_count: number | null;
      qty_kg: string | null;
      damage_date: string;
      acting_user_id: string;
      reason: string | null;
      attribution: DamageAttribution;
      order_id: string | null;
      company_id: string | null;
      purchase_id: string | null;
      is_returnable: boolean;
      return_status: ReturnStatus;
      returned_at: Date | null;
      returned_by: string | null;
      stock_effect: StockEffect;
      est_value_iqd: number | null;
      est_value_usd_cents: number | null;
      est_value_source: PriceSource;
      notes: string | null;
      status: 'active' | 'void';
      void_reason: string | null;
      voided_by: string | null;
      voided_at: Date | null;
    }>,
    updatedBy: string,
    tx: Db,
  ): Promise<DamageRow | null> {
    const fields = Object.keys(patch) as (keyof typeof patch)[];
    if (fields.length === 0) return this.lock(id, tx);

    const values: unknown[] = [id, version, updatedBy];
    const assignments: string[] = [];
    const casts: Partial<Record<keyof typeof patch, string>> = {
      damage_date: '::date',
      qty_kg: '::numeric',
      attribution: '::damage_attribution',
      return_status: '::return_status',
      stock_effect: '::stock_effect',
      est_value_source: '::cost_source',
      status: '::doc_status',
    };
    for (const field of fields) {
      values.push(patch[field] ?? null);
      assignments.push(`${field} = $${values.length}${casts[field] ?? ''}`);
    }

    const { rows } = await tx.query<DamageRow>(
      `UPDATE damages
          SET ${assignments.join(', ')}, updated_at = now(), updated_by = $3, version = version + 1
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL
        RETURNING ${damageColumns()}`,
      values,
    );
    return rows[0] ?? null;
  }

  /** The purchase line the goods arrived on, for the credit pre-fill of A-39. */
  async purchaseLineFor(
    purchaseId: string,
    itemId: string,
    tx?: Db,
  ): Promise<{ unit_price_iqd: number; unit_price_usd_cents: number; price_entered_currency: 'IQD' | 'USD' } | null> {
    const { rows } = await (tx ?? this.database).query<{
      unit_price_iqd: string;
      unit_price_usd_cents: string;
      price_entered_currency: 'IQD' | 'USD';
    }>(
      `SELECT unit_price_iqd::text AS unit_price_iqd,
              unit_price_usd_cents::text AS unit_price_usd_cents,
              price_entered_currency::text AS price_entered_currency
         FROM purchase_lines
        WHERE purchase_id = $1 AND item_id = $2 AND deleted_at IS NULL
        ORDER BY line_no ASC
        LIMIT 1`,
      [purchaseId, itemId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      unit_price_iqd: Number(row.unit_price_iqd),
      unit_price_usd_cents: Number(row.unit_price_usd_cents),
      price_entered_currency: row.price_entered_currency,
    };
  }

  /** The ledger rows that name this record, for the detail page's "credited" section. */
  async creditsFor(id: string, tx?: Db) {
    const { rows } = await (tx ?? this.database).query<{
      side: 'company' | 'customer';
      owner_id: string;
      owner_name: string;
      entry_id: string;
      entry_type: string;
      entry_date: string;
      amount_iqd: string;
      amount_usd_cents: string;
      settlement_currency: 'IQD' | 'USD';
      note: string | null;
    }>(
      `SELECT 'company' AS side, l.company_id AS owner_id, c.name AS owner_name, l.id AS entry_id,
              l.entry_type::text AS entry_type, to_char(l.entry_date, 'YYYY-MM-DD') AS entry_date,
              l.amount_iqd::text AS amount_iqd, l.amount_usd_cents::text AS amount_usd_cents,
              c.settlement_currency::text AS settlement_currency, l.note
         FROM company_ledger l JOIN customers c ON c.id = l.company_id
        WHERE l.damage_id = $1
        UNION ALL
       SELECT 'customer' AS side, l.customer_id AS owner_id, cu.name AS owner_name, l.id AS entry_id,
              l.entry_type::text AS entry_type, to_char(l.entry_date, 'YYYY-MM-DD') AS entry_date,
              l.amount_iqd::text AS amount_iqd, l.amount_usd_cents::text AS amount_usd_cents,
              cu.settlement_currency::text AS settlement_currency, l.note
         FROM customer_ledger l JOIN customers cu ON cu.id = l.customer_id
        WHERE l.damage_id = $1
        ORDER BY entry_date ASC`,
      [id],
    );
    return rows;
  }
}

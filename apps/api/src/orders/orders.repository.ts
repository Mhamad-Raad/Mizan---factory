import { Injectable } from '@nestjs/common';
import { normalizeForSearch } from '@mizan/text';
import type { Currency, Measure, RateSource } from '@mizan/money';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';
import type { OrderLineRow, OrderRow, PaymentType, PriceSource } from './order.types.js';

function orderColumns(alias = 'orders'): string {
  return [
    'id',
    'number::text AS number',
    'customer_id',
    "to_char(order_date, 'YYYY-MM-DD') AS order_date",
    'acting_user_id',
    'payment_type::text AS payment_type',
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
    .map((field) => (field.startsWith('to_char') ? field.replace('order_date', `${alias}.order_date`) : `${alias}.${field}`))
    .join(', ');
}

const LINE_COLUMNS = `l.id, l.order_id, l.line_no, l.item_id, l.qty_count, l.qty_kg::text AS qty_kg,
                      l.priced_measure::text AS priced_measure,
                      l.unit_price_iqd::text AS unit_price_iqd,
                      l.unit_price_usd_cents::text AS unit_price_usd_cents,
                      l.price_entered_currency::text AS price_entered_currency,
                      l.price_source::text AS price_source, l.month_price_id,
                      l.rate_iqd_per_usd::text AS rate_iqd_per_usd,
                      l.rate_source::text AS rate_source,
                      l.line_total_iqd::text AS line_total_iqd,
                      l.line_total_usd_cents::text AS line_total_usd_cents,
                      l.cost_unit_iqd::text AS cost_unit_iqd,
                      l.cost_unit_usd_cents::text AS cost_unit_usd_cents,
                      l.cost_month_price_id, l.cost_source::text AS cost_source, l.note`;

/** The scope of the caller for orders (spec 2.6.4). */
export interface OrderScope {
  userId: string;
  /** `customers.view_all`: every order. Otherwise: my customers' orders, plus my own. */
  viewAll: boolean;
}

export interface OrderFilters {
  customer_id?: string;
  from?: string;
  to?: string;
  done_by?: string;
  assigned_to?: string;
  payment_type?: PaymentType;
  status?: 'unpaid' | 'partially_paid' | 'paid' | 'void';
  q?: string;
  /** Void-by-undo rows are hidden unless the Void filter asks for them (2.4.5). */
  include_undone?: boolean;
  page?: number;
  page_size?: number;
}

export interface OrderListRow extends OrderRow {
  customer_name: string;
  customer_is_system: boolean;
  settlement_currency: Currency;
  acting_user_name: string | null;
  voided_by_name: string | null;
  remaining: string;
  derived_status: string;
  received_currency: Currency | null;
  line_count: string;
}

export interface NewOrderLine {
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
  cost_unit_iqd: number | null;
  cost_unit_usd_cents: number | null;
  cost_month_price_id: string | null;
  cost_source: 'month' | 'fallback' | 'none';
  note: string | null;
}

@Injectable()
export class OrdersRepository {
  constructor(private readonly database: Database) {}

  /**
   * Orders the caller may see: every order with `customers.view_all`, otherwise the orders of
   * customers assigned to them **or** orders they entered themselves — an employee must not
   * lose sight of their own work when a customer is reassigned (spec 2.6.4).
   */
  private scopeCondition(scope: OrderScope, values: unknown[], alias = 'o'): string | null {
    if (scope.viewAll) return null;
    values.push(scope.userId);
    const param = values.length;
    return `(c.assigned_user_id = $${param}::uuid OR c.is_system OR ${alias}.created_by = $${param}::uuid)`;
  }

  async findById(id: string, scope: OrderScope, tx?: Db): Promise<OrderListRow | null> {
    const values: unknown[] = [id];
    const scoped = this.scopeCondition(scope, values);
    const { rows } = await (tx ?? this.database).query<OrderListRow>(
      `SELECT ${orderColumns('o')}, c.name AS customer_name, c.is_system AS customer_is_system,
              c.settlement_currency::text AS settlement_currency,
              u.display_name AS acting_user_name, v.display_name AS voided_by_name,
              b.remaining::text AS remaining, b.status AS derived_status,
              settle.entered_currency::text AS received_currency,
              (SELECT count(*)::text FROM order_lines l WHERE l.order_id = o.id AND l.deleted_at IS NULL) AS line_count
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
         LEFT JOIN users u ON u.id = o.acting_user_id
         LEFT JOIN users v ON v.id = o.voided_by
         LEFT JOIN order_balances b ON b.order_id = o.id
         LEFT JOIN LATERAL (
           SELECT e.entered_currency
             FROM customer_ledger e
            WHERE e.order_id = o.id AND e.entry_type = 'cash_settlement'
              AND NOT EXISTS (SELECT 1 FROM customer_ledger r WHERE r.reverses_entry_id = e.id)
            ORDER BY e.posting_seq DESC
            LIMIT 1
         ) settle ON true
        WHERE o.id = $1 AND o.deleted_at IS NULL ${scoped ? `AND ${scoped}` : ''}`,
      values,
    );
    return rows[0] ?? null;
  }

  async lock(id: string, tx: Db): Promise<OrderRow | null> {
    const { rows } = await tx.query<OrderRow>(
      `SELECT ${orderColumns()} FROM orders WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [id],
    );
    return rows[0] ?? null;
  }

  async list(filters: OrderFilters, scope: OrderScope): Promise<{ rows: OrderListRow[]; total: number }> {
    const conditions = ['o.deleted_at IS NULL'];
    const values: unknown[] = [];

    const scoped = this.scopeCondition(scope, values);
    if (scoped) conditions.push(scoped);

    if (filters.customer_id) {
      values.push(filters.customer_id);
      conditions.push(`o.customer_id = $${values.length}::uuid`);
    }
    // The bound is converted, never the column: a predicate around `order_date` cannot use
    // `orders_date_idx`, which is the defect the I0 review found in the History filter.
    if (filters.from) {
      values.push(filters.from);
      conditions.push(`o.order_date >= $${values.length}::date`);
    }
    if (filters.to) {
      values.push(filters.to);
      conditions.push(`o.order_date <= $${values.length}::date`);
    }
    if (filters.done_by) {
      values.push(filters.done_by);
      conditions.push(`o.acting_user_id = $${values.length}::uuid`);
    }
    if (filters.assigned_to) {
      values.push(filters.assigned_to);
      conditions.push(`c.assigned_user_id = $${values.length}::uuid`);
    }
    if (filters.payment_type) {
      values.push(filters.payment_type);
      conditions.push(`o.payment_type = $${values.length}::payment_type`);
    }
    if (filters.status) {
      values.push(filters.status);
      conditions.push(`b.status = $${values.length}`);
    }
    if (!filters.include_undone) {
      // Orders voided through the 8-second undo are hidden by default (2.4.5, FR-610).
      conditions.push(`(o.status <> 'void' OR o.void_reason <> 'undo')`);
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
        `(c.name_normalized LIKE $${nameParam} OR o.notes ILIKE $${textParam}` +
          ` OR ($${numberParam}::bigint IS NOT NULL AND o.number = $${numberParam}::bigint))`,
      );
    }

    const from = `
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN users u ON u.id = o.acting_user_id
      LEFT JOIN users v ON v.id = o.voided_by
      LEFT JOIN order_balances b ON b.order_id = o.id`;
    const where = `WHERE ${conditions.join(' AND ')}`;

    const countValues = [...values];
    const pageSize = Math.min(filters.page_size ?? 25, 100);
    const offset = Math.max((filters.page ?? 1) - 1, 0) * pageSize;
    values.push(pageSize, offset);

    const [list, count] = await Promise.all([
      this.database.query<OrderListRow>(
        `SELECT ${orderColumns('o')}, c.name AS customer_name, c.is_system AS customer_is_system,
                c.settlement_currency::text AS settlement_currency,
                u.display_name AS acting_user_name, v.display_name AS voided_by_name,
                b.remaining::text AS remaining, b.status AS derived_status,
                settle.entered_currency::text AS received_currency,
                (SELECT count(*)::text FROM order_lines l WHERE l.order_id = o.id AND l.deleted_at IS NULL) AS line_count
         ${from}
         LEFT JOIN LATERAL (
           SELECT e.entered_currency
             FROM customer_ledger e
            WHERE e.order_id = o.id AND e.entry_type = 'cash_settlement'
              AND NOT EXISTS (SELECT 1 FROM customer_ledger r WHERE r.reverses_entry_id = e.id)
            ORDER BY e.posting_seq DESC
            LIMIT 1
         ) settle ON true
         ${where}
         ORDER BY o.order_date DESC, o.number DESC
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      ),
      this.database.query<{ total: string }>(`SELECT count(*)::text AS total ${from} ${where}`, countValues),
    ]);

    return { rows: list.rows, total: Number(count.rows[0]?.total ?? 0) };
  }

  async linesOf(orderId: string, tx?: Db): Promise<OrderLineRow[]> {
    const { rows } = await (tx ?? this.database).query<OrderLineRow>(
      `SELECT ${LINE_COLUMNS}, i.name AS item_name, i.pricing_unit::text AS item_pricing_unit
         FROM order_lines l
         JOIN items i ON i.id = l.item_id
        WHERE l.order_id = $1 AND l.deleted_at IS NULL
        ORDER BY l.line_no ASC`,
      [orderId],
    );
    return rows;
  }

  async createOrder(
    input: {
      customer_id: string;
      order_date: string;
      acting_user_id: string;
      payment_type: PaymentType;
      notes: string | null;
      rate_iqd_per_usd: string;
      rate_source: RateSource;
      discount_iqd: number;
      discount_usd_cents: number;
      created_by: string;
    },
    tx: Db,
  ): Promise<OrderRow> {
    const { rows } = await tx.query<OrderRow>(
      `INSERT INTO orders (customer_id, order_date, acting_user_id, payment_type, notes,
                           rate_iqd_per_usd, rate_source, discount_iqd, discount_usd_cents,
                           created_by, updated_by)
       VALUES ($1, $2::date, $3, $4::payment_type, $5, $6::numeric, $7::rate_source, $8, $9, $10, $10)
       RETURNING ${orderColumns()}`,
      [
        input.customer_id,
        input.order_date,
        input.acting_user_id,
        input.payment_type,
        input.notes,
        input.rate_iqd_per_usd,
        input.rate_source,
        input.discount_iqd,
        input.discount_usd_cents,
        input.created_by,
      ],
    );
    return rows[0] as OrderRow;
  }

  async insertLines(orderId: string, lines: readonly NewOrderLine[], createdBy: string, tx: Db): Promise<OrderLineRow[]> {
    const inserted: OrderLineRow[] = [];
    for (const line of lines) {
      const { rows } = await tx.query<OrderLineRow>(
        `INSERT INTO order_lines
           (order_id, line_no, item_id, qty_count, qty_kg, priced_measure, unit_price_iqd,
            unit_price_usd_cents, price_entered_currency, price_source, month_price_id,
            rate_iqd_per_usd, rate_source, line_total_iqd, line_total_usd_cents,
            cost_unit_iqd, cost_unit_usd_cents, cost_month_price_id, cost_source, note, created_by)
         VALUES ($1, $2, $3, $4, $5::numeric, $6::measure, $7, $8, $9::currency, $10::price_source, $11,
                 $12::numeric, $13::rate_source, $14, $15, $16, $17, $18, $19::cost_source, $20, $21)
         RETURNING ${LINE_COLUMNS.replace(/l\./g, 'order_lines.')}`,
        [
          orderId,
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
          line.cost_unit_iqd,
          line.cost_unit_usd_cents,
          line.cost_month_price_id,
          line.cost_source,
          line.note,
          createdBy,
        ],
      );
      inserted.push(rows[0] as OrderLineRow);
    }
    return inserted;
  }

  /** An edit replaces the set: the old lines are soft-deleted, never overwritten (2.5.3). */
  async softDeleteLines(orderId: string, tx: Db): Promise<void> {
    await tx.query('UPDATE order_lines SET deleted_at = now() WHERE order_id = $1 AND deleted_at IS NULL', [
      orderId,
    ]);
  }

  async updateOrder(
    id: string,
    version: number,
    patch: Partial<{
      order_date: string;
      payment_type: PaymentType;
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
  ): Promise<OrderRow | null> {
    const fields = Object.keys(patch) as (keyof typeof patch)[];
    if (fields.length === 0) return this.lock(id, tx);

    const values: unknown[] = [id, version, updatedBy];
    const assignments: string[] = [];
    for (const field of fields) {
      values.push(patch[field] ?? null);
      const cast =
        field === 'order_date'
          ? '::date'
          : field === 'payment_type'
            ? '::payment_type'
            : field === 'rate_iqd_per_usd'
              ? '::numeric'
              : field === 'rate_source'
                ? '::rate_source'
                : field === 'status'
                  ? '::doc_status'
                  : '';
      assignments.push(`${field} = $${values.length}${cast}`);
    }

    const { rows } = await tx.query<OrderRow>(
      `UPDATE orders
          SET ${assignments.join(', ')}, updated_at = now(), updated_by = $3, version = version + 1
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL
        RETURNING ${orderColumns()}`,
      values,
    );
    return rows[0] ?? null;
  }

  /** The per-order payment-type history of FR-605, append-only. */
  async recordPaymentTypeChange(
    input: {
      order_id: string;
      from_type: PaymentType;
      to_type: PaymentType;
      note: string;
      ledger_entry_id: string | null;
      changed_by: string;
    },
    tx: Db,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO order_payment_type_changes (order_id, from_type, to_type, note, ledger_entry_id, changed_by)
       VALUES ($1, $2::payment_type, $3::payment_type, $4, $5, $6)`,
      [input.order_id, input.from_type, input.to_type, input.note, input.ledger_entry_id, input.changed_by],
    );
  }

  async paymentTypeHistory(orderId: string, tx?: Db) {
    const { rows } = await (tx ?? this.database).query<{
      id: string;
      from_type: string;
      to_type: string;
      note: string;
      changed_at: Date;
      changed_by: string;
      changed_by_name: string | null;
      ledger_entry_id: string | null;
    }>(
      `SELECT p.id, p.from_type::text AS from_type, p.to_type::text AS to_type, p.note, p.changed_at,
              p.changed_by, u.display_name AS changed_by_name, p.ledger_entry_id
         FROM order_payment_type_changes p
         LEFT JOIN users u ON u.id = p.changed_by
        WHERE p.order_id = $1
        ORDER BY p.changed_at DESC`,
      [orderId],
    );
    return rows;
  }

  /** Whether any *manual* payment is linked to the order, which closes the edit window. */
  async hasManualPayment(orderId: string, tx: Db): Promise<boolean> {
    const { rows } = await tx.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM customer_ledger
          WHERE order_id = $1
            AND entry_type IN ('payment', 'credit', 'refund', 'adjustment')
            AND NOT EXISTS (SELECT 1 FROM customer_ledger r WHERE r.reverses_entry_id = customer_ledger.id)
       ) AS exists`,
      [orderId],
    );
    return rows[0]?.exists ?? false;
  }
}

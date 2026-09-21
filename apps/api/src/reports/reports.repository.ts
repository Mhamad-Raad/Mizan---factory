import { Injectable } from '@nestjs/common';
import type { Currency, Measure } from '@mizan/money';
import { Database } from '../database/pool.js';

/**
 * All SQL for the reports (spec 2.11).
 *
 * Three rules run through every query here:
 *
 *   · **stored values only.** Every figure is a sum of amounts as they were stored, per
 *     currency, never a conversion at today's rate — so a report of last March reads the same
 *     next year as it did then;
 *   · **the business date decides.** `from`/`to` are inclusive Asia/Baghdad days compared
 *     against `order_date`, `purchase_date`, `entry_date` or `damage_date`, and the bound is
 *     cast rather than the column, so the date indices serve the filter;
 *   · **voided documents are not activity.** Every query excludes `status = 'void'` and
 *     soft-deleted rows.
 */

export type GroupBy = 'month' | 'day' | 'customer' | 'company' | 'item' | 'employee' | 'assigned';
/** The damage report also groups by where the goods came from and where they went (FR-1009). */
export type DamageGroupBy = GroupBy | 'attribution' | 'return_status';

export interface ReportFilters {
  from: string;
  to: string;
  done_by?: string;
  assigned_to?: string;
  group_by?: GroupBy;
  /** Narrows Payables to one company, which is what makes per-purchase remaining affordable. */
  company_id?: string;
  item_id?: string;
}

export interface GroupKey {
  key: string;
  label: string | null;
}

export interface SalesGroup extends GroupKey {
  count_orders: number;
  total_iqd: number;
  total_usd_cents: number;
  cash_iqd: number;
  cash_usd_cents: number;
  borrowed_iqd: number;
  borrowed_usd_cents: number;
  discount_iqd: number;
  discount_usd_cents: number;
  qty_count: number | null;
  qty_kg: string | null;
}

export interface PurchasesGroup extends GroupKey {
  count_purchases: number;
  total_iqd: number;
  total_usd_cents: number;
  qty_count: number | null;
  qty_kg: string | null;
}

export interface MarginLineRow {
  group_key: string;
  group_label: string | null;
  priced_measure: Measure;
  qty_count: number | null;
  qty_kg: string | null;
  unit_price_iqd: number;
  unit_price_usd_cents: number;
  price_entered_currency: Currency;
  rate_iqd_per_usd: string;
  cost_unit_iqd: number | null;
  cost_unit_usd_cents: number | null;
  cost_source: 'month' | 'fallback' | 'none';
  line_total_iqd: number;
  line_total_usd_cents: number;
}

@Injectable()
export class ReportsRepository {
  constructor(private readonly database: Database) {}

  // ───────────────────────────────── sales (FR-1003) ─────────────────────────────────

  /**
   * Totals of active orders in the period. Grouping by material is the one shape that reads
   * from the lines rather than the documents, because a quantity belongs to a line.
   */
  async sales(filters: ReportFilters): Promise<SalesGroup[]> {
    const groupBy = filters.group_by ?? 'month';
    const values: unknown[] = [filters.from, filters.to];
    const conditions = [
      "o.status = 'active'",
      'o.deleted_at IS NULL',
      'o.order_date >= $1::date',
      'o.order_date <= $2::date',
    ];
    if (filters.done_by) {
      values.push(filters.done_by);
      conditions.push(`o.acting_user_id = $${values.length}::uuid`);
    }
    if (filters.assigned_to) {
      values.push(filters.assigned_to);
      conditions.push(`c.assigned_user_id = $${values.length}::uuid`);
    }

    if (groupBy === 'item') {
      if (filters.item_id) {
        values.push(filters.item_id);
        conditions.push(`ol.item_id = $${values.length}::uuid`);
      }
      const { rows } = await this.database.query<SalesGroup>(
        `SELECT i.id::text AS key, i.name AS label,
                count(DISTINCT o.id)::int AS count_orders,
                coalesce(sum(ol.line_total_iqd), 0)::bigint AS total_iqd,
                coalesce(sum(ol.line_total_usd_cents), 0)::bigint AS total_usd_cents,
                0::bigint AS cash_iqd, 0::bigint AS cash_usd_cents,
                0::bigint AS borrowed_iqd, 0::bigint AS borrowed_usd_cents,
                0::bigint AS discount_iqd, 0::bigint AS discount_usd_cents,
                coalesce(sum(ol.qty_count), 0)::int AS qty_count,
                coalesce(sum(ol.qty_kg), 0)::text AS qty_kg
           FROM order_lines ol
           JOIN orders o ON o.id = ol.order_id
           JOIN customers c ON c.id = o.customer_id
           JOIN items i ON i.id = ol.item_id
          WHERE ${conditions.join(' AND ')} AND ol.deleted_at IS NULL
          GROUP BY i.id, i.name
          ORDER BY sum(ol.line_total_iqd) DESC`,
        values,
      );
      return rows;
    }

    const grouping = this.documentGrouping(
      groupBy,
      'o.order_date',
      {
        customer: { key: 'c.id::text', label: 'c.name' },
        employee: { key: 'o.acting_user_id::text', label: 'u.display_name' },
        assigned: { key: 'c.assigned_user_id::text', label: 'a.display_name' },
      },
      'sum(o.total_iqd)',
    );

    const { rows } = await this.database.query<SalesGroup>(
      `SELECT ${grouping.key} AS key, ${grouping.label} AS label,
              count(*)::int AS count_orders,
              coalesce(sum(o.total_iqd), 0)::bigint AS total_iqd,
              coalesce(sum(o.total_usd_cents), 0)::bigint AS total_usd_cents,
              coalesce(sum(CASE WHEN o.payment_type = 'cash' THEN o.total_iqd ELSE 0 END), 0)::bigint AS cash_iqd,
              coalesce(sum(CASE WHEN o.payment_type = 'cash' THEN o.total_usd_cents ELSE 0 END), 0)::bigint
                AS cash_usd_cents,
              coalesce(sum(CASE WHEN o.payment_type = 'borrowed' THEN o.total_iqd ELSE 0 END), 0)::bigint
                AS borrowed_iqd,
              coalesce(sum(CASE WHEN o.payment_type = 'borrowed' THEN o.total_usd_cents ELSE 0 END), 0)::bigint
                AS borrowed_usd_cents,
              coalesce(sum(o.discount_iqd), 0)::bigint AS discount_iqd,
              coalesce(sum(o.discount_usd_cents), 0)::bigint AS discount_usd_cents,
              NULL::int AS qty_count, NULL::text AS qty_kg
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
         LEFT JOIN users u ON u.id = o.acting_user_id
         LEFT JOIN users a ON a.id = c.assigned_user_id
        WHERE ${conditions.join(' AND ')}
        GROUP BY ${grouping.group}
        ORDER BY ${grouping.order}`,
      values,
    );
    return rows;
  }

  /** `collected_*` (2.11): customer payments and cash settlements in the period. */
  async collected(filters: ReportFilters): Promise<{ iqd: number; usd_cents: number }> {
    const values: unknown[] = [filters.from, filters.to];
    const conditions = [
      "l.entry_type IN ('payment', 'cash_settlement')",
      'l.entry_date >= $1::date',
      'l.entry_date <= $2::date',
    ];
    if (filters.done_by) {
      values.push(filters.done_by);
      conditions.push(`l.performed_by_user_id = $${values.length}::uuid`);
    }
    if (filters.assigned_to) {
      values.push(filters.assigned_to);
      conditions.push(`c.assigned_user_id = $${values.length}::uuid`);
    }
    const { rows } = await this.database.query<{ iqd: string; usd_cents: string }>(
      `SELECT coalesce(-sum(l.amount_iqd), 0)::text AS iqd,
              coalesce(-sum(l.amount_usd_cents), 0)::text AS usd_cents
         FROM customer_ledger l
         JOIN customers c ON c.id = l.customer_id
        WHERE ${conditions.join(' AND ')}`,
      values,
    );
    return { iqd: Number(rows[0]?.iqd ?? 0), usd_cents: Number(rows[0]?.usd_cents ?? 0) };
  }

  // ───────────────────────────────── purchases (FR-1004) ─────────────────────────────────

  async purchases(filters: ReportFilters): Promise<PurchasesGroup[]> {
    const groupBy = filters.group_by ?? 'month';
    const values: unknown[] = [filters.from, filters.to];
    const conditions = [
      "p.status = 'active'",
      'p.deleted_at IS NULL',
      'p.purchase_date >= $1::date',
      'p.purchase_date <= $2::date',
    ];
    if (filters.done_by) {
      values.push(filters.done_by);
      conditions.push(`p.acting_user_id = $${values.length}::uuid`);
    }
    if (filters.company_id) {
      values.push(filters.company_id);
      conditions.push(`p.company_id = $${values.length}::uuid`);
    }

    if (groupBy === 'item') {
      const { rows } = await this.database.query<PurchasesGroup>(
        `SELECT i.id::text AS key, i.name AS label,
                count(DISTINCT p.id)::int AS count_purchases,
                coalesce(sum(pl.line_total_iqd), 0)::bigint AS total_iqd,
                coalesce(sum(pl.line_total_usd_cents), 0)::bigint AS total_usd_cents,
                coalesce(sum(pl.qty_count), 0)::int AS qty_count,
                coalesce(sum(pl.qty_kg), 0)::text AS qty_kg
           FROM purchase_lines pl
           JOIN purchases p ON p.id = pl.purchase_id
           JOIN items i ON i.id = pl.item_id
          WHERE ${conditions.join(' AND ')} AND pl.deleted_at IS NULL
          GROUP BY i.id, i.name
          ORDER BY sum(pl.line_total_iqd) DESC`,
        values,
      );
      return rows;
    }

    const grouping = this.documentGrouping(
      groupBy,
      'p.purchase_date',
      {
        company: { key: 'p.company_id::text', label: 'co.name' },
        employee: { key: 'p.acting_user_id::text', label: 'u.display_name' },
      },
      'sum(p.total_iqd)',
    );

    const { rows } = await this.database.query<PurchasesGroup>(
      `SELECT ${grouping.key} AS key, ${grouping.label} AS label,
              count(*)::int AS count_purchases,
              coalesce(sum(p.total_iqd), 0)::bigint AS total_iqd,
              coalesce(sum(p.total_usd_cents), 0)::bigint AS total_usd_cents,
              NULL::int AS qty_count, NULL::text AS qty_kg
         FROM purchases p
         LEFT JOIN companies co ON co.id = p.company_id
         LEFT JOIN users u ON u.id = p.acting_user_id
        WHERE ${conditions.join(' AND ')}
        GROUP BY ${grouping.group}
        ORDER BY ${grouping.order}`,
      values,
    );
    return rows;
  }

  /** `paid_to_companies_*` (2.11): payments to companies in the period. */
  async paidToCompanies(filters: ReportFilters): Promise<{ iqd: number; usd_cents: number }> {
    const values: unknown[] = [filters.from, filters.to];
    const conditions = [
      "l.entry_type = 'payment'",
      'l.entry_date >= $1::date',
      'l.entry_date <= $2::date',
    ];
    if (filters.done_by) {
      values.push(filters.done_by);
      conditions.push(`l.performed_by_user_id = $${values.length}::uuid`);
    }
    const { rows } = await this.database.query<{ iqd: string; usd_cents: string }>(
      `SELECT coalesce(-sum(l.amount_iqd), 0)::text AS iqd,
              coalesce(-sum(l.amount_usd_cents), 0)::text AS usd_cents
         FROM company_ledger l
        WHERE ${conditions.join(' AND ')}`,
      values,
    );
    return { iqd: Number(rows[0]?.iqd ?? 0), usd_cents: Number(rows[0]?.usd_cents ?? 0) };
  }

  // ───────────────────────────────── profit (FR-1005) ─────────────────────────────────

  /**
   * The order lines of the period with their stored cost snapshots, already carrying the key
   * they are grouped by, **in batches**. The margin itself is computed by the kernel over these
   * rows, because there is one definition of it and it lives in `@mizan/money` (FR-1005, 2.11).
   *
   * A batch at a time, keyed on the line's own id, because the margin is a per-line rule and a
   * period is not bounded: five years of the volume fixture is 132,000 lines, and the design
   * point of NFR-13 is fourteen times that. Reading them all at once made the size of one
   * request's memory a function of how wide a range somebody typed — the I4 review's finding.
   * The fold is a sum, so a batch's totals add to the previous batches' exactly (asserted).
   */
  async *marginLineBatches(
    filters: ReportFilters,
    batchSize = 50_000,
  ): AsyncGenerator<MarginLineRow[], void, void> {
    let cursor: string | null = null;
    for (;;) {
      const batch = await this.marginLines(filters, { after: cursor, limit: batchSize });
      if (batch.length === 0) return;
      yield batch.map((row) => row.line);
      if (batch.length < batchSize) return;
      cursor = batch[batch.length - 1]!.id;
    }
  }

  private async marginLines(
    filters: ReportFilters,
    page: { after: string | null; limit: number },
  ): Promise<{ id: string; line: MarginLineRow }[]> {
    const groupBy = filters.group_by ?? 'month';
    const values: unknown[] = [filters.from, filters.to];
    const conditions = [
      "o.status = 'active'",
      'o.deleted_at IS NULL',
      'ol.deleted_at IS NULL',
      'o.order_date >= $1::date',
      'o.order_date <= $2::date',
    ];
    if (filters.done_by) {
      values.push(filters.done_by);
      conditions.push(`o.acting_user_id = $${values.length}::uuid`);
    }
    if (filters.assigned_to) {
      values.push(filters.assigned_to);
      conditions.push(`c.assigned_user_id = $${values.length}::uuid`);
    }
    if (filters.item_id) {
      values.push(filters.item_id);
      conditions.push(`ol.item_id = $${values.length}::uuid`);
    }

    const key =
      groupBy === 'item'
        ? { key: 'i.id::text', label: 'i.name' }
        : groupBy === 'customer'
          ? { key: 'c.id::text', label: 'c.name' }
          : groupBy === 'employee'
            ? { key: 'o.acting_user_id::text', label: 'u.display_name' }
            : groupBy === 'day'
              ? {
                  key: "to_char(o.order_date, 'YYYY-MM-DD')",
                  label: "to_char(o.order_date, 'YYYY-MM-DD')",
                }
              : { key: "to_char(date_trunc('month', o.order_date), 'YYYY-MM-DD')", label: 'NULL' };

    if (page.after) {
      values.push(page.after);
      conditions.push(`ol.id > $${values.length}::uuid`);
    }
    values.push(page.limit);

    const { rows } = await this.database.query<MarginLineRow & { id: string }>(
      `SELECT ol.id::text AS id, ${key.key} AS group_key, ${key.label} AS group_label,
              ol.priced_measure::text AS priced_measure,
              ol.qty_count, ol.qty_kg::text AS qty_kg,
              ol.unit_price_iqd::bigint AS unit_price_iqd,
              ol.unit_price_usd_cents::bigint AS unit_price_usd_cents,
              ol.price_entered_currency::text AS price_entered_currency,
              ol.rate_iqd_per_usd::text AS rate_iqd_per_usd,
              ol.cost_unit_iqd::bigint AS cost_unit_iqd,
              ol.cost_unit_usd_cents::bigint AS cost_unit_usd_cents,
              ol.cost_source::text AS cost_source,
              ol.line_total_iqd::bigint AS line_total_iqd,
              ol.line_total_usd_cents::bigint AS line_total_usd_cents
         FROM order_lines ol
         JOIN orders o ON o.id = ol.order_id
         JOIN customers c ON c.id = o.customer_id
         JOIN items i ON i.id = ol.item_id
         LEFT JOIN users u ON u.id = o.acting_user_id
        WHERE ${conditions.join(' AND ')}
        -- By the line's id, not by the group: the fold is order-independent, and a key the
        -- rows are already unique on is the only one a keyset can page on safely.
        ORDER BY ol.id ASC
        LIMIT $${values.length}`,
      values,
    );
    return rows.map(({ id, ...line }) => ({ id, line }));
  }

  // ───────────────────────────────── stock (FR-1006) ─────────────────────────────────

  async stock(filters: ReportFilters) {
    const values: unknown[] = [filters.from, filters.to];
    const conditions = ['i.deleted_at IS NULL'];
    if (filters.item_id) {
      values.push(filters.item_id);
      conditions.push(`i.id = $${values.length}::uuid`);
    }

    const { rows } = await this.database.query<{
      key: string;
      label: string;
      pricing_unit: 'per_piece' | 'per_kg';
      stock_count: string;
      stock_kg: string;
      count_complete: boolean;
      kg_complete: boolean;
      first_bought_on: string | null;
      last_sold_on: string | null;
      in_count: string;
      in_kg: string;
      out_count: string;
      out_kg: string;
      bought_iqd: string | null;
      bought_usd_cents: string | null;
      price_month: string | null;
    }>(
      `WITH sold AS (
         SELECT ol.item_id, max(o.order_date) AS last_sold_on
           FROM order_lines ol
           JOIN orders o ON o.id = ol.order_id
          WHERE ol.deleted_at IS NULL AND o.status = 'active' AND o.deleted_at IS NULL
          GROUP BY ol.item_id
       ),
       bought AS (
         SELECT s.item_id, min(s.entry_date) AS first_bought_on
           FROM stock_ledger s
          WHERE s.movement_type IN ('purchase_in', 'opening')
            AND NOT EXISTS (SELECT 1 FROM stock_ledger r WHERE r.reverses_entry_id = s.id)
          GROUP BY s.item_id
       )
       SELECT i.id::text AS key, i.name AS label, i.pricing_unit::text AS pricing_unit,
              st.stock_count::text AS stock_count, st.stock_kg::text AS stock_kg,
              st.count_complete, st.kg_complete,
              to_char(bought.first_bought_on, 'YYYY-MM-DD') AS first_bought_on,
              to_char(sold.last_sold_on, 'YYYY-MM-DD') AS last_sold_on,
              coalesce(moved.in_count, 0)::text AS in_count,
              coalesce(moved.in_kg, 0)::text AS in_kg,
              coalesce(moved.out_count, 0)::text AS out_count,
              coalesce(moved.out_kg, 0)::text AS out_kg,
              price.bought_iqd::text AS bought_iqd,
              price.bought_usd_cents::text AS bought_usd_cents,
              to_char(price.month, 'YYYY-MM-DD') AS price_month
         FROM items i
         LEFT JOIN item_stock st ON st.item_id = i.id
         LEFT JOIN sold ON sold.item_id = i.id
         LEFT JOIN bought ON bought.item_id = i.id
         LEFT JOIN LATERAL (
           SELECT sum(CASE WHEN s.qty_count > 0 THEN s.qty_count ELSE 0 END) AS in_count,
                  sum(CASE WHEN s.qty_kg > 0 THEN s.qty_kg ELSE 0 END) AS in_kg,
                  sum(CASE WHEN s.qty_count < 0 THEN -s.qty_count ELSE 0 END) AS out_count,
                  sum(CASE WHEN s.qty_kg < 0 THEN -s.qty_kg ELSE 0 END) AS out_kg
             FROM stock_ledger s
            WHERE s.item_id = i.id AND s.entry_date >= $1::date AND s.entry_date <= $2::date
         ) moved ON true
         -- The value is the *current* month's bought price, or the latest earlier one, which
         -- is the same fallback rule the forms use — and flagged when it is one (FR-1006).
         LEFT JOIN LATERAL (
           SELECT p.month, p.bought_iqd, p.bought_usd_cents
             FROM item_month_prices p
            WHERE p.item_id = i.id AND p.deleted_at IS NULL AND p.bought_iqd IS NOT NULL
              AND p.month <= date_trunc('month', $2::date)
            ORDER BY p.month DESC
            LIMIT 1
         ) price ON true
        WHERE ${conditions.join(' AND ')}
        ORDER BY i.name ASC`,
      values,
    );
    return rows;
  }

  // ─────────────────────── receivables and payables (FR-1007, FR-1008) ───────────────────────

  /**
   * Balances per customer as of the end of the range, what came in during it, and how many of
   * their orders are still owed.
   *
   * The unpaid count is computed in **one** grouped pass rather than per customer through the
   * `order_balances` view: that view groups every order ever placed, and a predicate on one
   * customer cannot be pushed inside it — the mistake the I1 review measured on the Orders list
   * and the I4 review measured again here (668 ms at 63,000 orders).
   */
  async receivables(filters: ReportFilters) {
    const values: unknown[] = [filters.from, filters.to];
    const conditions = ['c.deleted_at IS NULL', 'c.is_system = false'];
    if (filters.assigned_to) {
      values.push(filters.assigned_to);
      conditions.push(`c.assigned_user_id = $${values.length}::uuid`);
    }

    const { rows } = await this.database.query<{
      key: string;
      label: string;
      settlement_currency: Currency;
      assigned_user_name: string | null;
      balance: string;
      balance_iqd: string;
      balance_usd_cents: string;
      received_iqd: string;
      received_usd_cents: string;
      unpaid_orders: string;
    }>(
      `WITH order_remaining AS (
         SELECT o.customer_id,
                o.id,
                coalesce(sum(CASE WHEN cu.settlement_currency = 'IQD' THEN l.amount_iqd
                                  ELSE l.amount_usd_cents END), 0) AS remaining
           FROM orders o
           JOIN customers cu ON cu.id = o.customer_id
           LEFT JOIN customer_ledger l ON l.order_id = o.id
          WHERE o.status = 'active' AND o.deleted_at IS NULL
          GROUP BY o.customer_id, o.id, cu.settlement_currency
       ),
       unpaid AS (
         SELECT customer_id, count(*)::text AS unpaid_orders
           FROM order_remaining
          WHERE remaining > 0
          GROUP BY customer_id
       )
       SELECT c.id::text AS key, c.name AS label,
              c.settlement_currency::text AS settlement_currency,
              u.display_name AS assigned_user_name,
              -- As of the end of the range: a balance is "all time up to that day", not
              -- "in the period", which is what makes it a balance (2.11).
              coalesce(sum(CASE WHEN l.entry_date <= $2::date
                                THEN (CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd
                                           ELSE l.amount_usd_cents END) ELSE 0 END), 0)::text AS balance,
              coalesce(sum(CASE WHEN l.entry_date <= $2::date THEN l.amount_iqd ELSE 0 END), 0)::text AS balance_iqd,
              coalesce(sum(CASE WHEN l.entry_date <= $2::date THEN l.amount_usd_cents ELSE 0 END), 0)::text
                AS balance_usd_cents,
              coalesce(-sum(CASE WHEN l.entry_type IN ('payment', 'cash_settlement')
                                  AND l.entry_date >= $1::date AND l.entry_date <= $2::date
                                 THEN l.amount_iqd ELSE 0 END), 0)::text AS received_iqd,
              coalesce(-sum(CASE WHEN l.entry_type IN ('payment', 'cash_settlement')
                                  AND l.entry_date >= $1::date AND l.entry_date <= $2::date
                                 THEN l.amount_usd_cents ELSE 0 END), 0)::text AS received_usd_cents,
              coalesce(max(unpaid.unpaid_orders), '0') AS unpaid_orders
         FROM customers c
         LEFT JOIN customer_ledger l ON l.customer_id = c.id
         LEFT JOIN users u ON u.id = c.assigned_user_id
         LEFT JOIN unpaid ON unpaid.customer_id = c.id
        WHERE ${conditions.join(' AND ')}
        GROUP BY c.id, c.name, c.settlement_currency, u.display_name
        ORDER BY balance DESC`,
      values,
    );
    return rows;
  }

  async payables(filters: ReportFilters) {
    const values: unknown[] = [filters.from, filters.to];
    const conditions = ['co.deleted_at IS NULL'];
    if (filters.company_id) {
      values.push(filters.company_id);
      conditions.push(`co.id = $${values.length}::uuid`);
    }
    if (filters.assigned_to) {
      values.push(filters.assigned_to);
      conditions.push(`co.assigned_user_id = $${values.length}::uuid`);
    }

    const { rows } = await this.database.query<{
      key: string;
      label: string;
      settlement_currency: Currency;
      balance: string;
      balance_iqd: string;
      balance_usd_cents: string;
      purchased_iqd: string;
      purchased_usd_cents: string;
      paid_iqd: string;
      paid_usd_cents: string;
      credits_iqd: string;
      credits_usd_cents: string;
      adjustments_iqd: string;
      adjustments_usd_cents: string;
    }>(
      `SELECT co.id::text AS key, co.name AS label,
              co.settlement_currency::text AS settlement_currency,
              coalesce(sum(CASE WHEN l.entry_date <= $2::date
                                THEN (CASE WHEN co.settlement_currency = 'IQD' THEN l.amount_iqd
                                           ELSE l.amount_usd_cents END) ELSE 0 END), 0)::text AS balance,
              coalesce(sum(CASE WHEN l.entry_date <= $2::date THEN l.amount_iqd ELSE 0 END), 0)::text AS balance_iqd,
              coalesce(sum(CASE WHEN l.entry_date <= $2::date THEN l.amount_usd_cents ELSE 0 END), 0)::text
                AS balance_usd_cents,
              ${this.periodSum("l.entry_type = 'purchase'", 'purchased')},
              ${this.periodSum("l.entry_type = 'payment'", 'paid', true)},
              ${this.periodSum("l.entry_type = 'credit'", 'credits', true)},
              ${this.periodSum("l.entry_type = 'adjustment'", 'adjustments')}
         FROM companies co
         LEFT JOIN company_ledger l ON l.company_id = co.id
        WHERE ${conditions.join(' AND ')}
        GROUP BY co.id, co.name, co.settlement_currency
        ORDER BY balance DESC`,
      values,
    );
    return rows;
  }

  /** A period sum of one entry type, negated for the rows that reduce what we owe. */
  private periodSum(predicate: string, alias: string, negate = false): string {
    const sign = negate ? '-' : '';
    return `coalesce(${sign}sum(CASE WHEN ${predicate} AND l.entry_date >= $1::date AND l.entry_date <= $2::date
                        THEN l.amount_iqd ELSE 0 END), 0)::text AS ${alias}_iqd,
            coalesce(${sign}sum(CASE WHEN ${predicate} AND l.entry_date >= $1::date AND l.entry_date <= $2::date
                        THEN l.amount_usd_cents ELSE 0 END), 0)::text AS ${alias}_usd_cents`;
  }

  // ───────────────────────────────── damage (FR-1009) ─────────────────────────────────

  async damage(filters: Omit<ReportFilters, 'group_by'> & { group_by?: DamageGroupBy }) {
    const groupBy = filters.group_by ?? 'month';
    const values: unknown[] = [filters.from, filters.to];
    const conditions = [
      "d.status = 'active'",
      'd.deleted_at IS NULL',
      'd.damage_date >= $1::date',
      'd.damage_date <= $2::date',
    ];
    if (filters.done_by) {
      values.push(filters.done_by);
      conditions.push(`d.acting_user_id = $${values.length}::uuid`);
    }
    if (filters.item_id) {
      values.push(filters.item_id);
      conditions.push(`d.item_id = $${values.length}::uuid`);
    }

    const key =
      groupBy === 'item'
        ? { key: 'i.id::text', label: 'i.name', group: 'i.id, i.name' }
        : groupBy === 'attribution'
          ? { key: 'd.attribution::text', label: 'NULL', group: 'd.attribution' }
          : groupBy === 'return_status'
            ? { key: 'd.return_status::text', label: 'NULL', group: 'd.return_status' }
            : groupBy === 'day'
              ? {
                  key: "to_char(d.damage_date, 'YYYY-MM-DD')",
                  label: 'NULL',
                  group: 'd.damage_date',
                }
              : {
                  key: "to_char(date_trunc('month', d.damage_date), 'YYYY-MM-DD')",
                  label: 'NULL',
                  group: "date_trunc('month', d.damage_date)",
                };

    const { rows } = await this.database.query<{
      key: string;
      label: string | null;
      records: string;
      qty_count: string;
      qty_kg: string;
      est_value_iqd: string;
      est_value_usd_cents: string;
      unvalued: string;
      credited_iqd: string;
      credited_usd_cents: string;
    }>(
      `SELECT ${key.key} AS key, ${key.label} AS label,
              count(*)::text AS records,
              coalesce(sum(d.qty_count), 0)::text AS qty_count,
              coalesce(sum(d.qty_kg), 0)::text AS qty_kg,
              coalesce(sum(d.est_value_iqd), 0)::text AS est_value_iqd,
              coalesce(sum(d.est_value_usd_cents), 0)::text AS est_value_usd_cents,
              count(*) FILTER (WHERE d.est_value_iqd IS NULL)::text AS unvalued,
              -- What the returns brought back: credits on either ledger that name these records.
              coalesce(-sum(credits.iqd), 0)::text AS credited_iqd,
              coalesce(-sum(credits.usd_cents), 0)::text AS credited_usd_cents
         FROM damages d
         JOIN items i ON i.id = d.item_id
         LEFT JOIN LATERAL (
           SELECT coalesce(sum(amount_iqd), 0) AS iqd, coalesce(sum(amount_usd_cents), 0) AS usd_cents
             FROM (SELECT amount_iqd, amount_usd_cents FROM company_ledger WHERE damage_id = d.id
                   UNION ALL
                   SELECT amount_iqd, amount_usd_cents FROM customer_ledger WHERE damage_id = d.id)
                  linked_credits
         ) credits ON true
        WHERE ${conditions.join(' AND ')}
        GROUP BY ${key.group}
        ORDER BY ${key.key} ASC`,
      values,
    );
    return rows;
  }

  // ──────────────────────── employee activity (FR-1010) ────────────────────────

  /**
   * One row per employee: what they did in the period, counted from the documents they acted
   * on, the money rows they performed and the audit log for sign-ins and voids.
   */
  async employeeActivity(filters: ReportFilters) {
    const values: unknown[] = [filters.from, filters.to];
    const conditions = ['u.deleted_at IS NULL'];
    if (filters.done_by) {
      values.push(filters.done_by);
      conditions.push(`u.id = $${values.length}::uuid`);
    }

    const { rows } = await this.database.query<{
      key: string;
      label: string;
      orders: string;
      orders_iqd: string;
      orders_usd_cents: string;
      purchases: string;
      purchases_iqd: string;
      purchases_usd_cents: string;
      payments_in: string;
      payments_in_iqd: string;
      payments_out: string;
      payments_out_iqd: string;
      damages: string;
      adjustments: string;
      voids: string;
      sign_ins: string;
    }>(
      `SELECT u.id::text AS key, u.display_name AS label,
              (SELECT count(*)::text FROM orders o
                WHERE o.acting_user_id = u.id AND o.status = 'active' AND o.deleted_at IS NULL
                  AND o.order_date >= $1::date AND o.order_date <= $2::date) AS orders,
              (SELECT coalesce(sum(o.total_iqd), 0)::text FROM orders o
                WHERE o.acting_user_id = u.id AND o.status = 'active' AND o.deleted_at IS NULL
                  AND o.order_date >= $1::date AND o.order_date <= $2::date) AS orders_iqd,
              (SELECT coalesce(sum(o.total_usd_cents), 0)::text FROM orders o
                WHERE o.acting_user_id = u.id AND o.status = 'active' AND o.deleted_at IS NULL
                  AND o.order_date >= $1::date AND o.order_date <= $2::date) AS orders_usd_cents,
              (SELECT count(*)::text FROM purchases p
                WHERE p.acting_user_id = u.id AND p.status = 'active' AND p.deleted_at IS NULL
                  AND p.purchase_date >= $1::date AND p.purchase_date <= $2::date) AS purchases,
              (SELECT coalesce(sum(p.total_iqd), 0)::text FROM purchases p
                WHERE p.acting_user_id = u.id AND p.status = 'active' AND p.deleted_at IS NULL
                  AND p.purchase_date >= $1::date AND p.purchase_date <= $2::date) AS purchases_iqd,
              (SELECT coalesce(sum(p.total_usd_cents), 0)::text FROM purchases p
                WHERE p.acting_user_id = u.id AND p.status = 'active' AND p.deleted_at IS NULL
                  AND p.purchase_date >= $1::date AND p.purchase_date <= $2::date) AS purchases_usd_cents,
              (SELECT count(*)::text FROM customer_ledger l
                WHERE l.performed_by_user_id = u.id AND l.entry_type = 'payment'
                  AND l.entry_date >= $1::date AND l.entry_date <= $2::date) AS payments_in,
              (SELECT coalesce(-sum(l.amount_iqd), 0)::text FROM customer_ledger l
                WHERE l.performed_by_user_id = u.id AND l.entry_type = 'payment'
                  AND l.entry_date >= $1::date AND l.entry_date <= $2::date) AS payments_in_iqd,
              (SELECT count(*)::text FROM company_ledger l
                WHERE l.performed_by_user_id = u.id AND l.entry_type = 'payment'
                  AND l.entry_date >= $1::date AND l.entry_date <= $2::date) AS payments_out,
              (SELECT coalesce(-sum(l.amount_iqd), 0)::text FROM company_ledger l
                WHERE l.performed_by_user_id = u.id AND l.entry_type = 'payment'
                  AND l.entry_date >= $1::date AND l.entry_date <= $2::date) AS payments_out_iqd,
              (SELECT count(*)::text FROM damages d
                WHERE d.acting_user_id = u.id AND d.status = 'active' AND d.deleted_at IS NULL
                  AND d.damage_date >= $1::date AND d.damage_date <= $2::date) AS damages,
              (SELECT count(*)::text FROM company_ledger l
                WHERE l.performed_by_user_id = u.id AND l.entry_type = 'adjustment'
                  AND l.entry_date >= $1::date AND l.entry_date <= $2::date) AS adjustments,
              -- Voids and sign-ins are audit facts, not document columns (2.4.4).
              (SELECT count(*)::text FROM audit_log a
                WHERE a.actor_user_id = u.id AND a.action = 'void'
                  AND a.occurred_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Baghdad')
                  AND a.occurred_at < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Baghdad')) AS voids,
              (SELECT count(*)::text FROM audit_log a
                WHERE a.actor_user_id = u.id AND a.action = 'login'
                  AND a.occurred_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Baghdad')
                  AND a.occurred_at < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Baghdad')) AS sign_ins
         FROM users u
        WHERE ${conditions.join(' AND ')}
        ORDER BY u.display_name ASC`,
      values,
    );
    return rows;
  }

  // ──────────────── the daily cash-up (FR-1013, Proposed — not requested) ────────────────

  /**
   * "How much IQD and how much USD should each employee hand over?" — per employee and per
   * **physical** currency, which is the one the money arrived or left in (`entered_currency`),
   * never a conversion (FR-1013).
   */
  async cashUp(filters: ReportFilters) {
    const values: unknown[] = [filters.from, filters.to];
    const conditions = ['u.deleted_at IS NULL'];
    if (filters.done_by) {
      values.push(filters.done_by);
      conditions.push(`u.id = $${values.length}::uuid`);
    }

    const { rows } = await this.database.query<{
      key: string;
      label: string;
      received_iqd: string;
      received_usd_cents: string;
      paid_out_iqd: string;
      paid_out_usd_cents: string;
    }>(
      `SELECT u.id::text AS key, u.display_name AS label,
              -- Money in: customer payments and the settlement of a cash order, counted in the
              -- currency the customer physically handed over.
              (SELECT coalesce(-sum(CASE WHEN l.entered_currency = 'IQD' THEN l.amount_iqd ELSE 0 END), 0)::text
                 FROM customer_ledger l
                WHERE l.performed_by_user_id = u.id
                  AND l.entry_type IN ('payment', 'cash_settlement')
                  AND l.entry_date >= $1::date AND l.entry_date <= $2::date) AS received_iqd,
              (SELECT coalesce(-sum(CASE WHEN l.entered_currency = 'USD' THEN l.amount_usd_cents ELSE 0 END), 0)::text
                 FROM customer_ledger l
                WHERE l.performed_by_user_id = u.id
                  AND l.entry_type IN ('payment', 'cash_settlement')
                  AND l.entry_date >= $1::date AND l.entry_date <= $2::date) AS received_usd_cents,
              -- Money out: payments to companies and refunds to customers, likewise.
              (SELECT coalesce(-sum(CASE WHEN l.entered_currency = 'IQD' THEN l.amount_iqd ELSE 0 END), 0)::text
                 FROM company_ledger l
                WHERE l.performed_by_user_id = u.id AND l.entry_type = 'payment'
                  AND l.entry_date >= $1::date AND l.entry_date <= $2::date)::bigint
              + (SELECT coalesce(sum(CASE WHEN l.entered_currency = 'IQD' THEN l.amount_iqd ELSE 0 END), 0)
                   FROM customer_ledger l
                  WHERE l.performed_by_user_id = u.id AND l.entry_type = 'refund'
                    AND l.entry_date >= $1::date AND l.entry_date <= $2::date) AS paid_out_iqd,
              (SELECT coalesce(-sum(CASE WHEN l.entered_currency = 'USD' THEN l.amount_usd_cents ELSE 0 END), 0)::text
                 FROM company_ledger l
                WHERE l.performed_by_user_id = u.id AND l.entry_type = 'payment'
                  AND l.entry_date >= $1::date AND l.entry_date <= $2::date)::bigint
              + (SELECT coalesce(sum(CASE WHEN l.entered_currency = 'USD' THEN l.amount_usd_cents ELSE 0 END), 0)
                   FROM customer_ledger l
                  WHERE l.performed_by_user_id = u.id AND l.entry_type = 'refund'
                    AND l.entry_date >= $1::date AND l.entry_date <= $2::date) AS paid_out_usd_cents
         FROM users u
        WHERE ${conditions.join(' AND ')}
        ORDER BY u.display_name ASC`,
      values,
    );
    return rows;
  }

  /**
   * The grouping clause for a document report: the month or day of its business date, or one of
   * the named dimensions. Month grouping is `date_trunc` over a **date** column, so it is an
   * Asia/Baghdad month by construction — the date was stored as a Baghdad day (FR-1011).
   */
  private documentGrouping(
    groupBy: GroupBy,
    dateColumn: string,
    dimensions: Partial<Record<GroupBy, { key: string; label: string }>>,
    /** The money the dimension is ranked by, largest first — see `sortGroups` in the service. */
    measure = 'sum(1)',
  ): { key: string; label: string; group: string; order: string } {
    const dimension = dimensions[groupBy];
    if (dimension) {
      return {
        key: dimension.key,
        label: dimension.label,
        group: `${dimension.key}, ${dimension.label}`,
        // Largest first, not alphabetically: a customer list read by name is a directory, and
        // the response is capped, so the order decides which rows a phone is sent at all.
        order: `${measure} DESC, ${dimension.label} ASC NULLS LAST`,
      };
    }
    if (groupBy === 'day') {
      return {
        key: `to_char(${dateColumn}, 'YYYY-MM-DD')`,
        label: 'NULL',
        group: dateColumn,
        order: `${dateColumn} DESC`,
      };
    }
    return {
      key: `to_char(date_trunc('month', ${dateColumn}), 'YYYY-MM-DD')`,
      label: 'NULL',
      group: `date_trunc('month', ${dateColumn})`,
      order: `date_trunc('month', ${dateColumn}) DESC`,
    };
  }
}

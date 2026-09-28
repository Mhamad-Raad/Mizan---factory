import { Injectable } from '@nestjs/common';
import type { Currency } from '@mizan/money';
import { Database } from '../database/pool.js';
import type { Paging } from '../common/paging.js';

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

export type GroupBy = 'month' | 'day' | 'customer' | 'company' | 'item' | 'employee';
/** The damage report also groups by where the goods came from and where they went (FR-1009). */
export type DamageGroupBy = GroupBy | 'attribution' | 'return_status';

export interface ReportFilters {
  from: string;
  to: string;
  done_by?: string;
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
         LEFT JOIN customers co ON co.id = p.company_id
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
   * The margin of the period, grouped, as **one pass of stored integers** (FR-1005, D-039).
   *
   * Until I6 this read every line of the period and folded them through the kernel: correct,
   * and 436 seconds for a year at the design point of NFR-13. The kernel still owns the rule —
   * it computes each line's margin when the line is saved, in both currencies, at that line's
   * own rate (migration 0014) — and the report does what 2.11 says a report does: sums stored
   * values. Lines with no cost snapshot have no margin and are counted, never summed.
   */
  async margins(filters: ReportFilters) {
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
    if (filters.item_id) {
      values.push(filters.item_id);
      conditions.push(`ol.item_id = $${values.length}::uuid`);
    }

    const key =
      groupBy === 'item'
        ? { key: 'i.id::text', label: 'i.name', group: 'i.id, i.name' }
        : groupBy === 'customer'
          ? { key: 'c.id::text', label: 'c.name', group: 'c.id, c.name' }
          : groupBy === 'employee'
            ? { key: 'o.acting_user_id::text', label: 'u.display_name', group: 'o.acting_user_id, u.display_name' }
            : groupBy === 'day'
              ? {
                  key: "to_char(o.order_date, 'YYYY-MM-DD')",
                  label: 'NULL',
                  group: 'o.order_date',
                }
              : {
                  key: "to_char(date_trunc('month', o.order_date), 'YYYY-MM-DD')",
                  label: 'NULL',
                  group: "date_trunc('month', o.order_date)",
                };

    // Only the joins the chosen grouping needs: grouping by month must not drag in the
    // material and the employee (the I3 review's lesson about aggregates and their joins).
    const joins = [
      groupBy === 'item' ? 'JOIN items i ON i.id = ol.item_id' : '',
      groupBy === 'customer' ? 'JOIN customers c ON c.id = o.customer_id' : '',
      groupBy === 'employee' ? 'LEFT JOIN users u ON u.id = o.acting_user_id' : '',
    ]
      .filter(Boolean)
      .join('\n         ');

    const { rows } = await this.database.query<{
      group_key: string;
      group_label: string | null;
      lines: number;
      margin_iqd: string;
      margin_usd_cents: string;
      revenue_iqd: string;
      revenue_usd_cents: string;
      lines_without_cost: number;
      lines_with_fallback: number;
    }>(
      `SELECT ${key.key} AS group_key, ${key.label} AS group_label,
              count(*)::int AS lines,
              coalesce(sum(ol.margin_iqd), 0)::text AS margin_iqd,
              coalesce(sum(ol.margin_usd_cents), 0)::text AS margin_usd_cents,
              coalesce(sum(ol.line_total_iqd), 0)::text AS revenue_iqd,
              coalesce(sum(ol.line_total_usd_cents), 0)::text AS revenue_usd_cents,
              count(*) FILTER (WHERE ol.margin_iqd IS NULL)::int AS lines_without_cost,
              count(*) FILTER (WHERE ol.cost_source = 'fallback')::int AS lines_with_fallback
         FROM order_lines ol
         JOIN orders o ON o.id = ol.order_id
         ${joins}
        WHERE ${conditions.join(' AND ')}
        GROUP BY ${key.group}`,
      values,
    );
    return rows;
  }

  /**
   * What an order adds or takes away beyond its lines: the round-up to 250 dinars (D-065) less
   * the order's discount. Both belong to the order, not to a line, so the margins above cannot
   * see them — the Accounts page counts them, and without them the two disagreed (D-077).
   *
   * Grouped by the report's own key where the order decides it (month, day, company, employee).
   * A material cannot be given a share of an order-wide figure, so grouped by material this
   * answers one ungrouped row, which the report adds to its totals only; filtered to one
   * material it answers nothing, because the rows are that material's lines alone.
   */
  async orderAdjustments(filters: ReportFilters) {
    if (filters.item_id) return [];
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

    const key =
      groupBy === 'item'
        ? { key: 'NULL::text', group: '' }
        : groupBy === 'customer'
          ? { key: 'o.customer_id::text', group: 'GROUP BY o.customer_id' }
          : groupBy === 'employee'
            ? { key: 'o.acting_user_id::text', group: 'GROUP BY o.acting_user_id' }
            : groupBy === 'day'
              ? { key: "to_char(o.order_date, 'YYYY-MM-DD')", group: 'GROUP BY o.order_date' }
              : {
                  key: "to_char(date_trunc('month', o.order_date), 'YYYY-MM-DD')",
                  group: "GROUP BY date_trunc('month', o.order_date)",
                };

    const { rows } = await this.database.query<{
      group_key: string | null;
      adjustment_iqd: string;
      adjustment_usd_cents: string;
    }>(
      `SELECT ${key.key} AS group_key,
              coalesce(sum(o.rounding_iqd - o.discount_iqd), 0)::text AS adjustment_iqd,
              coalesce(sum(o.rounding_usd_cents - o.discount_usd_cents), 0)::text AS adjustment_usd_cents
         FROM orders o
        WHERE ${conditions.join(' AND ')}
        ${key.group}`,
      values,
    );
    return rows;
  }

  // ───────────────────────────────── stock (FR-1006) ─────────────────────────────────

  /** `limit` null values every material (LIMIT NULL is no limit), which the paged report does. */
  async stock(filters: ReportFilters, limit: number | null) {
    const values: unknown[] = [filters.from, filters.to];
    const conditions = ['i.deleted_at IS NULL'];
    if (filters.item_id) {
      values.push(filters.item_id);
      conditions.push(`i.id = $${values.length}::uuid`);
    }
    values.push(limit);
    const limitParam = values.length;

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
      lots_value_iqd: string | null;
      lots_value_usd_cents: string | null;
      lots_remaining: string | null;
    }>(
      // The page of materials is chosen first and everything else hangs off those rows: the
       // report sends two hundred groups (D-032), and computing five thousand materials' stock,
       // movements and prices to send two hundred cost 307 ms at the design point (REVIEW-I6).
      `WITH page AS (
         SELECT i.id, i.name
           FROM items i
          WHERE ${conditions.join(' AND ')}
          ORDER BY i.name ASC
          LIMIT $${limitParam}
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
              to_char(price.month, 'YYYY-MM-DD') AS price_month,
              CASE WHEN any_buy.bought THEN coalesce(open_lots.value_iqd, 0) END::text AS lots_value_iqd,
              CASE WHEN any_buy.bought THEN coalesce(open_lots.value_usd_cents, 0) END::text AS lots_value_usd_cents,
              CASE WHEN any_buy.bought THEN coalesce(open_lots.remaining, 0) END::text AS lots_remaining
         FROM page
         JOIN items i ON i.id = page.id
         LEFT JOIN item_stock st ON st.item_id = i.id
         CROSS JOIN LATERAL (
           SELECT greatest(coalesce(CASE WHEN i.pricing_unit = 'per_piece' THEN st.stock_count::numeric
                                         ELSE st.stock_kg END, 0), 0) AS quantity
         ) on_hand
         -- Both dates come from the stock ledger, newest (or oldest) movement of that kind
         -- first, so each is one index entry rather than an aggregate over a material's whole
         -- trading history: max(order_date) over 245 lines and their orders, per material of
         -- the page, was 200 of this report's 430 ms at the design point (migration 0019).
         LEFT JOIN LATERAL (
           SELECT s.entry_date AS last_sold_on
             FROM stock_ledger s
            WHERE s.item_id = i.id AND s.movement_type = 'sale_out'
              AND NOT EXISTS (SELECT 1 FROM stock_ledger r WHERE r.reverses_entry_id = s.id)
            ORDER BY s.entry_date DESC
            LIMIT 1
         ) sold ON true
         LEFT JOIN LATERAL (
           SELECT s.entry_date AS first_bought_on
             FROM stock_ledger s
            WHERE s.item_id = i.id
              AND s.movement_type IN ('purchase_in', 'opening')
              AND NOT EXISTS (SELECT 1 FROM stock_ledger r WHERE r.reverses_entry_id = s.id)
            ORDER BY s.entry_date ASC
            LIMIT 1
         ) bought ON true
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
         -- What the stock on hand cost us (D-062): what is left of every buy, as its share of
         -- what that buy cost — the same figure the material page splits by price. The month
         -- price above stands in for stock with no buy behind it (opening stock, a return),
         -- which the service adds on top.
         --
         -- item_lots trims the buys to the stock on hand oldest first, which is the same as
         -- giving the stock on hand to the newest open buys first: a buy keeps
         -- least(untaken, on hand − what the newer open buys already hold). So only a material
         -- with stock on hand reads its buys at all, and only its open ones (lot_balances,
         -- migration 0033): at ten years the report read all 2.6 million buys and their 7.8
         -- million takes on every request, 18.9–23.4 s (D-075). A material that has buys but
         -- nothing on hand, or nothing left in them, is valued at 0 from its buys, as before.
         LEFT JOIN LATERAL (
           SELECT round(sum(o.left_over * o.line_total_iqd / o.quantity)) AS value_iqd,
                  round(sum(o.left_over * o.line_total_usd_cents / o.quantity)) AS value_usd_cents,
                  sum(o.left_over) AS remaining
             FROM (
               SELECT greatest(0, least(u.untaken, on_hand.quantity - coalesce(sum(u.untaken) OVER (
                        ORDER BY u.purchase_date DESC, u.purchase_number DESC, u.line_no DESC
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0))) AS left_over,
                      u.quantity, u.line_total_iqd, u.line_total_usd_cents
                 FROM (
                   SELECT b.quantity, b.quantity - b.taken AS untaken,
                          p.purchase_date, p.number AS purchase_number, l.line_no,
                          l.line_total_iqd, l.line_total_usd_cents
                     FROM lot_balances b
                     JOIN purchase_lines l ON l.id = b.purchase_line_id
                     JOIN purchases p ON p.id = l.purchase_id
                    WHERE on_hand.quantity > 0
                      AND b.item_id = i.id AND b.live AND b.taken < b.quantity
                      AND l.deleted_at IS NULL AND p.status = 'active' AND p.deleted_at IS NULL
                 ) u
             ) o
         ) open_lots ON true
         -- Whether the material has any buy at all: one with nothing left is still a buy, and
         -- makes the material "valued from its buys" (0) rather than "never bought".
         LEFT JOIN LATERAL (
           SELECT true AS bought
             FROM purchase_lines l
             JOIN purchases p ON p.id = l.purchase_id
            WHERE l.item_id = i.id AND l.deleted_at IS NULL AND p.status = 'active' AND p.deleted_at IS NULL
            LIMIT 1
         ) any_buy ON true
        ORDER BY i.name ASC`,
      values,
    );
    return rows;
  }

  // ─────────────────────── receivables and payables (FR-1007, FR-1008) ───────────────────────

  /**
   * Balances per customer as of the end of the range, what came in during it, and how many of
   * their orders are still owed — **page first, then fill** (FR-1007).
   *
   * The balance as of the end of the range is the account's whole balance — the maintained
   * per-account sum of migration 0033 — less whatever was dated after that day, and the period's
   * figures come from the same short range of the ledger: one index range per account from the
   * start of the period on, instead of grouping every row of the ledger on every page (250–414 ms
   * a page at ten years, and an export of a year re-grouped it once per page: 22.9 s, D-075).
   * Only accounts with a row on this ledger take part — an account with none owes nothing and
   * received nothing (REVIEW-I6). The page and the totals over every account come back together
   * (the window functions run before the LIMIT), and each account's unpaid orders are read from
   * the maintained per-account sum of migration 0035.
   */
  async receivables(filters: ReportFilters, paging: Paging) {
    const values: unknown[] = [filters.from, filters.to];
    const conditions = ['c.deleted_at IS NULL', 'c.is_system = false', 't.receivable_entries > 0'];
    values.push(paging.page_size, paging.offset);

    const { rows } = await this.database.query<{
      key: string;
      label: string;
      settlement_currency: Currency;
      balance: string;
      balance_iqd: string;
      balance_usd_cents: string;
      received_iqd: string;
      received_usd_cents: string;
      unpaid_orders: string;
      group_count: string;
      total_balance_iqd: string;
      total_balance_usd_cents: string;
      total_received_iqd: string;
      total_received_usd_cents: string;
    }>(
      `WITH per_customer AS (
         SELECT c.id, c.name, c.settlement_currency,
                -- As of the end of the range: a balance is "all time up to that day", not "in
                -- the period", which is what makes it a balance (2.11).
                t.receivable_iqd - coalesce(x.after_iqd, 0) AS balance_iqd,
                t.receivable_usd_cents - coalesce(x.after_usd_cents, 0) AS balance_usd_cents,
                coalesce(x.received_iqd, 0) AS received_iqd,
                coalesce(x.received_usd_cents, 0) AS received_usd_cents
           FROM customers c
           JOIN account_totals t ON t.account_id = c.id
           LEFT JOIN LATERAL (
             SELECT sum(l.amount_iqd) FILTER (WHERE l.entry_date > $2::date) AS after_iqd,
                    sum(l.amount_usd_cents) FILTER (WHERE l.entry_date > $2::date) AS after_usd_cents,
                    -sum(l.amount_iqd) FILTER (WHERE l.entry_type IN ('payment', 'cash_settlement')
                                                AND l.entry_date >= $1::date AND l.entry_date <= $2::date)
                      AS received_iqd,
                    -sum(l.amount_usd_cents) FILTER (WHERE l.entry_type IN ('payment', 'cash_settlement')
                                                      AND l.entry_date >= $1::date AND l.entry_date <= $2::date)
                      AS received_usd_cents
               FROM customer_ledger l
              WHERE l.customer_id = c.id AND l.entry_date >= least($1::date, $2::date + 1)
           ) x ON true
          WHERE ${conditions.join(' AND ')}
       ),
       ranked AS (
         SELECT per_customer.*,
                CASE WHEN settlement_currency = 'IQD' THEN balance_iqd ELSE balance_usd_cents END AS balance
           FROM per_customer
       ),
       page AS (
         SELECT *,
                count(*) OVER () AS group_count,
                sum(balance_iqd) OVER () AS total_balance_iqd,
                sum(balance_usd_cents) OVER () AS total_balance_usd_cents,
                sum(received_iqd) OVER () AS total_received_iqd,
                sum(received_usd_cents) OVER () AS total_received_usd_cents
           FROM ranked
          ORDER BY balance DESC, id
          LIMIT $${values.length - 1} OFFSET $${values.length}
       )
       SELECT p.id::text AS key, p.name AS label,
              p.settlement_currency::text AS settlement_currency,
              p.balance::text AS balance,
              p.balance_iqd::text AS balance_iqd,
              p.balance_usd_cents::text AS balance_usd_cents,
              p.received_iqd::text AS received_iqd,
              p.received_usd_cents::text AS received_usd_cents,
              p.group_count::text AS group_count,
              p.total_balance_iqd::text AS total_balance_iqd,
              p.total_balance_usd_cents::text AS total_balance_usd_cents,
              p.total_received_iqd::text AS total_received_iqd,
              p.total_received_usd_cents::text AS total_received_usd_cents,
              coalesce(CASE WHEN p.settlement_currency = 'IQD' THEN owing.iqd_orders ELSE owing.usd_orders END, 0)::text
                AS unpaid_orders
         FROM page p
         -- How many of the account's orders are still owed, in its own settlement currency: the
         -- maintained per-account sum of migration 0035, one row per account sent (D-075).
         LEFT JOIN account_owing owing ON owing.account_id = p.id
        ORDER BY p.balance DESC, p.id`,
      values,
    );
    return rows;
  }

  /**
   * What we owe each company as of the end of the range, and the period's buying, payments,
   * credits and adjustments — the same shape as Receivables (D-075): the balance is the
   * maintained per-account sum less what was dated after the range, the period's figures come
   * from one index range per account, only accounts with a row on the buying ledger take part,
   * and the page and the totals over every account come back together. It grouped the whole
   * buying ledger of every account on every request: 2.9–3.7 s at ten years.
   */
  async payables(filters: ReportFilters, paging: Paging) {
    const values: unknown[] = [filters.from, filters.to];
    // Every account but the walk-in is a company (D-055).
    const conditions = ['co.deleted_at IS NULL', 'NOT co.is_system', 't.payable_entries > 0'];
    if (filters.company_id) {
      values.push(filters.company_id);
      conditions.push(`co.id = $${values.length}::uuid`);
    }
    values.push(paging.page_size, paging.offset);

    const period = (predicate: string, column: 'amount_iqd' | 'amount_usd_cents', negate = false) =>
      `${negate ? '-' : ''}sum(l.${column}) FILTER (WHERE ${predicate} AND l.entry_date >= $1::date AND l.entry_date <= $2::date)`;

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
      group_count: string;
      total_balance_iqd: string;
      total_balance_usd_cents: string;
      total_purchased_iqd: string;
      total_purchased_usd_cents: string;
      total_paid_iqd: string;
      total_paid_usd_cents: string;
    }>(
      `WITH per_company AS (
         SELECT co.id, co.name, co.settlement_currency,
                t.payable_iqd - coalesce(x.after_iqd, 0) AS balance_iqd,
                t.payable_usd_cents - coalesce(x.after_usd_cents, 0) AS balance_usd_cents,
                coalesce(x.purchased_iqd, 0) AS purchased_iqd,
                coalesce(x.purchased_usd_cents, 0) AS purchased_usd_cents,
                coalesce(x.paid_iqd, 0) AS paid_iqd,
                coalesce(x.paid_usd_cents, 0) AS paid_usd_cents,
                coalesce(x.credits_iqd, 0) AS credits_iqd,
                coalesce(x.credits_usd_cents, 0) AS credits_usd_cents,
                coalesce(x.adjustments_iqd, 0) AS adjustments_iqd,
                coalesce(x.adjustments_usd_cents, 0) AS adjustments_usd_cents
           FROM customers co
           JOIN account_totals t ON t.account_id = co.id
           LEFT JOIN LATERAL (
             SELECT sum(l.amount_iqd) FILTER (WHERE l.entry_date > $2::date) AS after_iqd,
                    sum(l.amount_usd_cents) FILTER (WHERE l.entry_date > $2::date) AS after_usd_cents,
                    ${period("l.entry_type = 'purchase'", 'amount_iqd')} AS purchased_iqd,
                    ${period("l.entry_type = 'purchase'", 'amount_usd_cents')} AS purchased_usd_cents,
                    ${period("l.entry_type = 'payment'", 'amount_iqd', true)} AS paid_iqd,
                    ${period("l.entry_type = 'payment'", 'amount_usd_cents', true)} AS paid_usd_cents,
                    ${period("l.entry_type = 'credit'", 'amount_iqd', true)} AS credits_iqd,
                    ${period("l.entry_type = 'credit'", 'amount_usd_cents', true)} AS credits_usd_cents,
                    ${period("l.entry_type = 'adjustment'", 'amount_iqd')} AS adjustments_iqd,
                    ${period("l.entry_type = 'adjustment'", 'amount_usd_cents')} AS adjustments_usd_cents
               FROM company_ledger l
              WHERE l.company_id = co.id AND l.entry_date >= least($1::date, $2::date + 1)
           ) x ON true
          WHERE ${conditions.join(' AND ')}
       ),
       ranked AS (
         SELECT per_company.*,
                CASE WHEN settlement_currency = 'IQD' THEN balance_iqd ELSE balance_usd_cents END AS balance
           FROM per_company
       )
       SELECT id::text AS key, name AS label, settlement_currency::text AS settlement_currency,
              balance::text AS balance, balance_iqd::text AS balance_iqd,
              balance_usd_cents::text AS balance_usd_cents,
              purchased_iqd::text AS purchased_iqd, purchased_usd_cents::text AS purchased_usd_cents,
              paid_iqd::text AS paid_iqd, paid_usd_cents::text AS paid_usd_cents,
              credits_iqd::text AS credits_iqd, credits_usd_cents::text AS credits_usd_cents,
              adjustments_iqd::text AS adjustments_iqd, adjustments_usd_cents::text AS adjustments_usd_cents,
              (count(*) OVER ())::text AS group_count,
              (sum(balance_iqd) OVER ())::text AS total_balance_iqd,
              (sum(balance_usd_cents) OVER ())::text AS total_balance_usd_cents,
              (sum(purchased_iqd) OVER ())::text AS total_purchased_iqd,
              (sum(purchased_usd_cents) OVER ())::text AS total_purchased_usd_cents,
              (sum(paid_iqd) OVER ())::text AS total_paid_iqd,
              (sum(paid_usd_cents) OVER ())::text AS total_paid_usd_cents
         FROM ranked
        -- Qualified, so the order is the number and not the text column of the same name.
        ORDER BY ranked.balance DESC, ranked.id
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return rows;
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
                   -- The charge a company's damage puts on their account names the record too,
                   -- but it is what they owe, not a credit — nor is its reversal (D-062, review).
                   SELECT cu.amount_iqd, cu.amount_usd_cents FROM customer_ledger cu
                    WHERE cu.damage_id = d.id AND cu.entry_type <> 'damage'
                      AND NOT EXISTS (SELECT 1 FROM customer_ledger charge
                                       WHERE charge.id = cu.reverses_entry_id AND charge.entry_type = 'damage'))
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
    const userParam = values.length;
    const byUser = (column: string) => (filters.done_by ? `AND ${column} = $${userParam}::uuid` : '');

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
      // One grouped pass per table, each read through its date index, instead of fourteen
      // subqueries per employee — every one of them a range over that employee's documents:
      // 3.9 s for a year at ten years (D-075). The pin (`done_by`) narrows every pass.
      `WITH sold AS (
         SELECT o.acting_user_id AS user_id, count(*) AS n,
                sum(o.total_iqd) AS iqd, sum(o.total_usd_cents) AS usd_cents
           FROM orders o
          WHERE o.status = 'active' AND o.deleted_at IS NULL
            AND o.order_date >= $1::date AND o.order_date <= $2::date ${byUser('o.acting_user_id')}
          GROUP BY o.acting_user_id
       ),
       bought AS (
         SELECT p.acting_user_id AS user_id, count(*) AS n,
                sum(p.total_iqd) AS iqd, sum(p.total_usd_cents) AS usd_cents
           FROM purchases p
          WHERE p.status = 'active' AND p.deleted_at IS NULL
            AND p.purchase_date >= $1::date AND p.purchase_date <= $2::date ${byUser('p.acting_user_id')}
          GROUP BY p.acting_user_id
       ),
       money_in AS (
         SELECT l.performed_by_user_id AS user_id, count(*) AS n, -sum(l.amount_iqd) AS iqd
           FROM customer_ledger l
          WHERE l.entry_type = 'payment'
            AND l.entry_date >= $1::date AND l.entry_date <= $2::date ${byUser('l.performed_by_user_id')}
          GROUP BY l.performed_by_user_id
       ),
       money_out AS (
         SELECT l.performed_by_user_id AS user_id,
                count(*) FILTER (WHERE l.entry_type = 'payment') AS payments,
                -sum(l.amount_iqd) FILTER (WHERE l.entry_type = 'payment') AS payments_iqd,
                count(*) FILTER (WHERE l.entry_type = 'adjustment') AS adjustments
           FROM company_ledger l
          WHERE l.entry_type IN ('payment', 'adjustment')
            AND l.entry_date >= $1::date AND l.entry_date <= $2::date ${byUser('l.performed_by_user_id')}
          GROUP BY l.performed_by_user_id
       ),
       broken AS (
         SELECT d.acting_user_id AS user_id, count(*) AS n
           FROM damages d
          WHERE d.status = 'active' AND d.deleted_at IS NULL
            AND d.damage_date >= $1::date AND d.damage_date <= $2::date ${byUser('d.acting_user_id')}
          GROUP BY d.acting_user_id
       ),
       -- Voids and sign-ins are audit facts, not document columns (2.4.4), read through
       -- audit_log_action_idx (migration 0034).
       audited AS (
         SELECT a.actor_user_id AS user_id,
                count(*) FILTER (WHERE a.action = 'void') AS voids,
                count(*) FILTER (WHERE a.action = 'login') AS sign_ins
           FROM audit_log a
          WHERE a.action IN ('void', 'login')
            AND a.occurred_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Baghdad')
            AND a.occurred_at < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Baghdad') ${byUser('a.actor_user_id')}
          GROUP BY a.actor_user_id
       )
       SELECT u.id::text AS key, u.display_name AS label,
              coalesce(sold.n, 0)::text AS orders,
              coalesce(sold.iqd, 0)::text AS orders_iqd,
              coalesce(sold.usd_cents, 0)::text AS orders_usd_cents,
              coalesce(bought.n, 0)::text AS purchases,
              coalesce(bought.iqd, 0)::text AS purchases_iqd,
              coalesce(bought.usd_cents, 0)::text AS purchases_usd_cents,
              coalesce(money_in.n, 0)::text AS payments_in,
              coalesce(money_in.iqd, 0)::text AS payments_in_iqd,
              coalesce(money_out.payments, 0)::text AS payments_out,
              coalesce(money_out.payments_iqd, 0)::text AS payments_out_iqd,
              coalesce(broken.n, 0)::text AS damages,
              coalesce(money_out.adjustments, 0)::text AS adjustments,
              coalesce(audited.voids, 0)::text AS voids,
              coalesce(audited.sign_ins, 0)::text AS sign_ins
         FROM users u
         LEFT JOIN sold ON sold.user_id = u.id
         LEFT JOIN bought ON bought.user_id = u.id
         LEFT JOIN money_in ON money_in.user_id = u.id
         LEFT JOIN money_out ON money_out.user_id = u.id
         LEFT JOIN broken ON broken.user_id = u.id
         LEFT JOIN audited ON audited.user_id = u.id
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
        // the response is paged, so the order decides which rows the first page shows.
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

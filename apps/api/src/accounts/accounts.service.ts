import { Injectable } from '@nestjs/common';
import { Decimal } from '@mizan/money';
import { normalizeForSearch } from '@mizan/text';
import { pagingOf } from '../common/paging.js';
import { Database } from '../database/pool.js';
import { containing } from '../common/like.js';

/** An amount in both currencies, summed from stored pairs — never converted here (rule 1). */
export interface Pair {
  amount_iqd: number;
  amount_usd_cents: number;
}

export interface AccountsSummary {
  from: string;
  to: string;
  /** What the period's orders came to, after their discounts. */
  sold: Pair & { count: number };
  /** What the goods those orders sold cost us, from the buys they came from (D-062). */
  cost_of_sold: Pair;
  /** Sold less the cost of what was sold — the orders' margins, less discounts, plus rounding. */
  profit: Pair;
  /** Order lines of a material never bought: they have no cost, so they are not in the profit. */
  lines_without_cost: number;
  /** Stock bought in the period: creating a material and adding to one (D-062). */
  bought: Pair & { count: number };
  /** The accountant's own expenses of the period. */
  expenses: Pair & { count: number };
  /** Damage that is still a cost: ours, and a company's not yet paid back. */
  damage_loss: Pair & { count: number };
  /** Damage a company paid back in the period's records: no longer a cost. */
  damage_recovered: Pair & { count: number };
  /** Profit less expenses less damage still a cost: what the period left us. */
  net: Pair;
}

const pair = (iqd: string | null | undefined, usd: string | null | undefined): Pair => ({
  amount_iqd: Number(iqd ?? 0),
  amount_usd_cents: Number(usd ?? 0),
});

const minus = (left: Pair, ...rest: Pair[]): Pair => ({
  amount_iqd: rest.reduce((sum, one) => sum - one.amount_iqd, left.amount_iqd),
  amount_usd_cents: rest.reduce((sum, one) => sum - one.amount_usd_cents, left.amount_usd_cents),
});

/**
 * The accountant page (client review, D-062): for a period, what was sold, what it cost, the
 * profit, what was bought, the expenses and the damage — every figure a sum of stored integers in
 * both currencies, each currency summed on its own side.
 */
@Injectable()
export class AccountsService {
  constructor(private readonly database: Database) {}

  async summary(from: string, to: string): Promise<AccountsSummary> {
    const [sales, lines, bought, expenses, damage] = await Promise.all([
      this.database.query<{
        count: string;
        iqd: string;
        usd: string;
        disc_iqd: string;
        disc_usd: string;
        round_iqd: string;
        round_usd: string;
      }>(
        `SELECT count(*)::text AS count,
                coalesce(sum(total_iqd), 0)::text AS iqd, coalesce(sum(total_usd_cents), 0)::text AS usd,
                coalesce(sum(discount_iqd), 0)::text AS disc_iqd, coalesce(sum(discount_usd_cents), 0)::text AS disc_usd,
                coalesce(sum(rounding_iqd), 0)::text AS round_iqd, coalesce(sum(rounding_usd_cents), 0)::text AS round_usd
           FROM orders
          WHERE status = 'active' AND deleted_at IS NULL AND order_date BETWEEN $1::date AND $2::date`,
        [from, to],
      ),
      this.database.query<{ margin_iqd: string; margin_usd: string; cost_iqd: string; cost_usd: string; uncosted: string }>(
        `SELECT coalesce(sum(l.margin_iqd), 0)::text AS margin_iqd,
                coalesce(sum(l.margin_usd_cents), 0)::text AS margin_usd,
                coalesce(sum(l.line_total_iqd - l.margin_iqd) FILTER (WHERE l.margin_iqd IS NOT NULL), 0)::text AS cost_iqd,
                coalesce(sum(l.line_total_usd_cents - l.margin_usd_cents) FILTER (WHERE l.margin_iqd IS NOT NULL), 0)::text
                  AS cost_usd,
                count(*) FILTER (WHERE l.margin_iqd IS NULL)::text AS uncosted
           FROM orders o
           JOIN order_lines l ON l.order_id = o.id AND l.deleted_at IS NULL
          WHERE o.status = 'active' AND o.deleted_at IS NULL AND o.order_date BETWEEN $1::date AND $2::date`,
        [from, to],
      ),
      this.database.query<{ count: string; iqd: string; usd: string }>(
        `SELECT count(*)::text AS count,
                coalesce(sum(total_iqd), 0)::text AS iqd, coalesce(sum(total_usd_cents), 0)::text AS usd
           FROM purchases
          WHERE status = 'active' AND deleted_at IS NULL AND purchase_date BETWEEN $1::date AND $2::date`,
        [from, to],
      ),
      this.database.query<{ count: string; iqd: string; usd: string }>(
        `SELECT count(*)::text AS count,
                coalesce(sum(amount_iqd), 0)::text AS iqd, coalesce(sum(amount_usd_cents), 0)::text AS usd
           FROM expenses
          WHERE status = 'active' AND expense_date BETWEEN $1::date AND $2::date`,
        [from, to],
      ),
      this.database.query<{ recovered: boolean; count: string; iqd: string; usd: string }>(
        `SELECT (compensation IN ('paid_money', 'paid_materials')) AS recovered, count(*)::text AS count,
                coalesce(sum(est_value_iqd), 0)::text AS iqd, coalesce(sum(est_value_usd_cents), 0)::text AS usd
           FROM damages
          WHERE status = 'active' AND deleted_at IS NULL AND stock_effect = 'reduced'
            AND damage_date BETWEEN $1::date AND $2::date
          GROUP BY 1`,
        [from, to],
      ),
    ]);

    const s = sales.rows[0];
    const l = lines.rows[0];
    const discount = pair(s?.disc_iqd, s?.disc_usd);
    // The rounding up to 250 dinars (D-065) is money received with no stock behind it: profit.
    const rounding = pair(s?.round_iqd, s?.round_usd);
    const profit = minus(pair(l?.margin_iqd, l?.margin_usd), discount, minus(pair('0', '0'), rounding));
    const expenseRow = expenses.rows[0];
    const lossRow = damage.rows.find((row) => !row.recovered);
    const recoveredRow = damage.rows.find((row) => row.recovered);
    const expenseTotal = pair(expenseRow?.iqd, expenseRow?.usd);
    const loss = pair(lossRow?.iqd, lossRow?.usd);

    return {
      from,
      to,
      sold: { ...pair(s?.iqd, s?.usd), count: Number(s?.count ?? 0) },
      cost_of_sold: pair(l?.cost_iqd, l?.cost_usd),
      profit,
      lines_without_cost: Number(l?.uncosted ?? 0),
      bought: { ...pair(bought.rows[0]?.iqd, bought.rows[0]?.usd), count: Number(bought.rows[0]?.count ?? 0) },
      expenses: { ...expenseTotal, count: Number(expenseRow?.count ?? 0) },
      damage_loss: { ...loss, count: Number(lossRow?.count ?? 0) },
      damage_recovered: { ...pair(recoveredRow?.iqd, recoveredRow?.usd), count: Number(recoveredRow?.count ?? 0) },
      net: minus(profit, expenseTotal, loss),
    };
  }

  /** The period's orders, each with what it sold for, what that cost and the profit — searchable. */
  async sales(filters: { from: string; to: string; q?: string; page?: number; page_size?: number }) {
    const values: unknown[] = [filters.from, filters.to];
    let search = '';
    const query = filters.q?.trim();
    if (query) {
      values.push(containing(normalizeForSearch(query)), query.replace(/\D/g, '') || null);
      search = `AND (c.name_normalized LIKE $3 OR o.number::text = $4)`;
    }
    const where = `o.status = 'active' AND o.deleted_at IS NULL AND o.order_date BETWEEN $1::date AND $2::date ${search}`;
    const paging = pagingOf(filters);
    const [list, count] = await Promise.all([
      this.database.query<{
        id: string;
        number: string;
        order_date: string;
        customer_id: string;
        customer_name: string;
        customer_is_system: boolean;
        settlement_currency: 'IQD' | 'USD';
        total_iqd: string;
        total_usd_cents: string;
        margin_iqd: string;
        margin_usd: string;
        discount_iqd: string;
        discount_usd_cents: string;
        rounding_iqd: string;
        rounding_usd_cents: string;
        uncosted: string;
        costed_iqd: string;
        costed_usd: string;
      }>(
        `SELECT o.id, o.number::text AS number, to_char(o.order_date, 'YYYY-MM-DD') AS order_date,
                c.id AS customer_id, c.name AS customer_name, c.is_system AS customer_is_system,
                c.settlement_currency::text AS settlement_currency,
                o.total_iqd::text AS total_iqd, o.total_usd_cents::text AS total_usd_cents,
                o.discount_iqd::text AS discount_iqd, o.discount_usd_cents::text AS discount_usd_cents,
                o.rounding_iqd::text AS rounding_iqd, o.rounding_usd_cents::text AS rounding_usd_cents,
                m.margin_iqd::text AS margin_iqd, m.margin_usd::text AS margin_usd, m.uncosted::text AS uncosted,
                m.costed_iqd::text AS costed_iqd, m.costed_usd::text AS costed_usd
           FROM orders o
           JOIN customers c ON c.id = o.customer_id
           CROSS JOIN LATERAL (
             SELECT coalesce(sum(margin_iqd), 0) AS margin_iqd, coalesce(sum(margin_usd_cents), 0) AS margin_usd,
                    -- What the costed lines sold for: a line with no cost is not counted as cost.
                    coalesce(sum(line_total_iqd) FILTER (WHERE margin_iqd IS NOT NULL), 0) AS costed_iqd,
                    coalesce(sum(line_total_usd_cents) FILTER (WHERE margin_iqd IS NOT NULL), 0) AS costed_usd,
                    count(*) FILTER (WHERE margin_iqd IS NULL) AS uncosted
               FROM order_lines WHERE order_id = o.id AND deleted_at IS NULL
           ) m
          WHERE ${where}
          ORDER BY o.order_date DESC, o.number DESC
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, paging.page_size, paging.offset],
      ),
      this.database.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM orders o JOIN customers c ON c.id = o.customer_id WHERE ${where}`,
        values,
      ),
    ]);
    return {
      items: list.rows.map((row) => {
        const total = pair(row.total_iqd, row.total_usd_cents);
        const profit = minus(
          pair(row.margin_iqd, row.margin_usd),
          pair(row.discount_iqd, row.discount_usd_cents),
          minus(pair('0', '0'), pair(row.rounding_iqd, row.rounding_usd_cents)),
        );
        return {
          id: row.id,
          number: Number(row.number),
          order_date: row.order_date,
          customer_id: row.customer_id,
          customer_name: row.customer_name,
          customer_is_system: row.customer_is_system,
          settlement_currency: row.settlement_currency,
          total,
          // What the costed lines cost us, as the summary's cost of sold counts it (review).
          cost: minus(pair(row.costed_iqd, row.costed_usd), pair(row.margin_iqd, row.margin_usd)),
          profit,
          lines_without_cost: Number(row.uncosted),
        };
      }),
      total: Number(count.rows[0]?.total ?? 0),
    };
  }

  /**
   * Every material with movement in the period: what of it was bought, what was sold, what that
   * cost and the profit on it, and the stock now — searchable by name.
   */
  async materials(filters: { from: string; to: string; q?: string; page?: number; page_size?: number }) {
    const values: unknown[] = [filters.from, filters.to];
    let search = '';
    const query = filters.q?.trim();
    if (query) {
      values.push(containing(normalizeForSearch(query)));
      search = `AND i.name_normalized LIKE $3`;
    }
    const paging = pagingOf(filters);
    const base = `
      WITH sold AS (
        SELECT l.item_id,
               sum(CASE WHEN l.priced_measure = 'count' THEN l.qty_count::numeric ELSE l.qty_kg END) AS qty,
               sum(l.line_total_iqd) AS revenue_iqd, sum(l.line_total_usd_cents) AS revenue_usd,
               sum(l.margin_iqd) AS margin_iqd, sum(l.margin_usd_cents) AS margin_usd,
               sum(l.line_total_iqd) FILTER (WHERE l.margin_iqd IS NOT NULL) AS costed_iqd,
               sum(l.line_total_usd_cents) FILTER (WHERE l.margin_iqd IS NOT NULL) AS costed_usd
          FROM order_lines l JOIN orders o ON o.id = l.order_id
         WHERE l.deleted_at IS NULL AND o.status = 'active' AND o.deleted_at IS NULL
           AND o.order_date BETWEEN $1::date AND $2::date
         GROUP BY l.item_id
      ), bought AS (
        SELECT l.item_id,
               sum(CASE WHEN l.priced_measure = 'count' THEN l.qty_count::numeric ELSE l.qty_kg END) AS qty,
               sum(l.line_total_iqd) AS spent_iqd, sum(l.line_total_usd_cents) AS spent_usd
          FROM purchase_lines l JOIN purchases p ON p.id = l.purchase_id
         WHERE l.deleted_at IS NULL AND p.status = 'active' AND p.deleted_at IS NULL
           AND p.purchase_date BETWEEN $1::date AND $2::date
         GROUP BY l.item_id
      )
      SELECT i.id, i.name, i.pricing_unit::text AS pricing_unit,
             coalesce(sold.qty, 0)::text AS sold_qty,
             coalesce(sold.revenue_iqd, 0)::text AS revenue_iqd, coalesce(sold.revenue_usd, 0)::text AS revenue_usd,
             coalesce(sold.margin_iqd, 0)::text AS margin_iqd, coalesce(sold.margin_usd, 0)::text AS margin_usd,
             coalesce(sold.costed_iqd, 0)::text AS costed_iqd, coalesce(sold.costed_usd, 0)::text AS costed_usd,
             coalesce(bought.qty, 0)::text AS bought_qty,
             coalesce(bought.spent_iqd, 0)::text AS spent_iqd, coalesce(bought.spent_usd, 0)::text AS spent_usd,
             (CASE WHEN i.pricing_unit = 'per_piece' THEN st.stock_count::numeric ELSE st.stock_kg END)::text AS stock
        FROM items i
        LEFT JOIN sold ON sold.item_id = i.id
        LEFT JOIN bought ON bought.item_id = i.id
        LEFT JOIN item_stock st ON st.item_id = i.id
       WHERE i.deleted_at IS NULL AND (sold.item_id IS NOT NULL OR bought.item_id IS NOT NULL) ${search}`;
    const [list, count] = await Promise.all([
      this.database.query<{
        id: string;
        name: string;
        pricing_unit: 'per_piece' | 'per_kg';
        sold_qty: string;
        revenue_iqd: string;
        revenue_usd: string;
        margin_iqd: string;
        margin_usd: string;
        costed_iqd: string;
        costed_usd: string;
        bought_qty: string;
        spent_iqd: string;
        spent_usd: string;
        stock: string | null;
      }>(
        `${base} ORDER BY coalesce(sold.margin_iqd, 0) DESC, i.name
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, paging.page_size, paging.offset],
      ),
      this.database.query<{ total: string }>(`SELECT count(*)::text AS total FROM (${base}) x`, values),
    ]);
    return {
      items: list.rows.map((row) => {
        const revenue = pair(row.revenue_iqd, row.revenue_usd);
        const profit = pair(row.margin_iqd, row.margin_usd);
        return {
          id: row.id,
          name: row.name,
          pricing_unit: row.pricing_unit,
          sold_qty: new Decimal(row.sold_qty).toFixed(3),
          sold: revenue,
          cost: minus(pair(row.costed_iqd, row.costed_usd), profit),
          profit,
          bought_qty: new Decimal(row.bought_qty).toFixed(3),
          bought: pair(row.spent_iqd, row.spent_usd),
          stock: new Decimal(row.stock ?? '0').toFixed(3),
        };
      }),
      total: Number(count.rows[0]?.total ?? 0),
    };
  }
}

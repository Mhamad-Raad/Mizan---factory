import { Injectable } from '@nestjs/common';
import { normalizeForSearch } from '@mizan/text';
import { lineMargin } from '@mizan/money';
import type { Currency, Measure, RateSource } from '@mizan/money';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';
import type { OrderLineRow, OrderRow, PaymentType, PriceSource } from './order.types.js';
import { countFrom } from '../common/count-from.js';
import { pagingOf } from '../common/paging.js';
import { containing } from '../common/like.js';

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
    'rounding_iqd::text AS rounding_iqd',
    'rounding_usd_cents::text AS rounding_usd_cents',
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
                      l.cost_month_price_id, l.cost_source::text AS cost_source,
                      l.margin_iqd::text AS margin_iqd,
                      l.margin_usd_cents::text AS margin_usd_cents, l.note`;

/**
 * What is still owed on one order, in the customer's settlement currency: the maintained
 * per-order sum of migration 0015, one primary-key probe per row.
 *
 * It used to be a lateral sum over the order's ledger rows. That was right for a page, but the
 * status filter derives the status of *every* candidate order, and "still owed, all dates" summed
 * the ledger for all 1.8 million orders of the ten-year database: 9.5 s (D-075). The maintained
 * sum is the same figure — a sum over the same rows, kept by a trigger on the append-only ledger
 * and compared with it by `check-integrity.mjs` — so the status is now a join, and the owing
 * orders have their own partial index (migration 0034).
 */
const REMAINING_JOIN = `LEFT JOIN order_remaining r ON r.order_id = o.id`;
const REMAINING = `coalesce(CASE WHEN c.settlement_currency = 'IQD' THEN r.remaining_iqd ELSE r.remaining_usd_cents END, 0)`;
/**
 * True of every order that owes anything in either currency — a superset of "owes in its
 * settlement currency", written out so the planner can use `order_remaining_owing_idx`.
 */
const MAY_OWE = `(r.remaining_iqd > 0 OR r.remaining_usd_cents > 0)`;

/** The currency the customer physically handed over, from the live settlement row (FR-604). */
const RECEIVED_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT e.entered_currency
      FROM customer_ledger e
     WHERE e.order_id = o.id AND e.entry_type = 'cash_settlement'
       AND NOT EXISTS (SELECT 1 FROM customer_ledger r WHERE r.reverses_entry_id = e.id)
     ORDER BY e.posting_seq DESC
     LIMIT 1
  ) settle ON true`;

/** The derived status of 2.4.3, in the same three steps as `orderStatus()` in @mizan/ledger. */
const STATUS_EXPRESSION = `
  CASE
    WHEN o.status = 'void' THEN 'void'
    WHEN ${REMAINING} <= 0 THEN 'paid'
    WHEN ${REMAINING} >= (CASE WHEN c.settlement_currency = 'IQD' THEN o.total_iqd ELSE o.total_usd_cents END)
      THEN 'unpaid'
    ELSE 'partially_paid'
  END`;

const LIST_COLUMNS = `c.name AS customer_name, c.is_system AS customer_is_system,
                      c.settlement_currency::text AS settlement_currency,
                      u.display_name AS acting_user_name, v.display_name AS voided_by_name,
                      ${REMAINING}::text AS remaining, ${STATUS_EXPRESSION} AS derived_status,
                      settle.entered_currency::text AS received_currency,
                      (SELECT count(*)::text FROM order_lines l
                        WHERE l.order_id = o.id AND l.deleted_at IS NULL) AS line_count`;

export interface OrderFilters {
  /** FR-802: the damage pickers show only the documents that carried the material. */
  item_id?: string;
  customer_id?: string;
  from?: string;
  to?: string;
  done_by?: string;
  payment_type?: PaymentType;
  /** `owing` is unpaid or partially paid — the account overview's "still owed" list (D-058). */
  status?: 'unpaid' | 'partially_paid' | 'paid' | 'void' | 'owing';
  q?: string;
  /** Void-by-undo rows are hidden unless the Void filter asks for them (2.4.5). */
  include_undone?: boolean;
  /** `false` skips the figures over the whole filter: the dashboard's latest orders (D-075). */
  totals?: boolean;
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
  cost_source: 'month' | 'fallback' | 'lots' | 'none';
  /** The exact cost of the stock sold, from the buys it came from (D-062); drives the margin. */
  cost_total_iqd?: number | null;
  cost_total_usd_cents?: number | null;
  note: string | null;
}

/** A set of owing orders from `account_owing` (migration 0035), in both currencies. */
export interface OwingSet {
  orders: number;
  remaining_iqd: number;
  remaining_usd_cents: number;
  total_iqd: number;
  total_usd_cents: number;
}

function minusSet(left: OwingSet, right: OwingSet): OwingSet {
  return {
    orders: left.orders - right.orders,
    remaining_iqd: left.remaining_iqd - right.remaining_iqd,
    remaining_usd_cents: left.remaining_usd_cents - right.remaining_usd_cents,
    total_iqd: left.total_iqd - right.total_iqd,
    total_usd_cents: left.total_usd_cents - right.total_usd_cents,
  };
}

function balanceOf(set: OwingSet): OrderTotals['balance'] {
  return { owing: set.orders, owed_iqd: set.remaining_iqd, owed_usd_cents: set.remaining_usd_cents };
}

/** The list's figures over the whole filter, not the page (client review). */
export interface OrderTotals {
  orders: number;
  total_iqd: number;
  total_usd_cents: number;
  /**
   * What is still owed: how many orders owe something, and how much. Both sit under `balance`,
   * so the flag that hides what customers owe hides the count as well (2.6.2).
   */
  balance: { owing: number; owed_iqd: number; owed_usd_cents: number };
}

@Injectable()
export class OrdersRepository {
  constructor(private readonly database: Database) {}

  /** An order by id. Everybody who may see orders sees them all (D-056): no scope to apply. */
  async findById(id: string, tx?: Db): Promise<OrderListRow | null> {
    const values: unknown[] = [id];
    const { rows } = await (tx ?? this.database).query<OrderListRow>(
      `SELECT ${orderColumns('o')}, ${LIST_COLUMNS}
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
         LEFT JOIN users u ON u.id = o.acting_user_id
         LEFT JOIN users v ON v.id = o.voided_by
         ${REMAINING_JOIN}
         ${RECEIVED_LATERAL}
        WHERE o.id = $1 AND o.deleted_at IS NULL`,
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

  async list(filters: OrderFilters): Promise<{ rows: OrderListRow[]; total: number; totals: OrderTotals | null }> {
    const conditions = ['o.deleted_at IS NULL'];
    const values: unknown[] = [];


    if (filters.customer_id) {
      values.push(filters.customer_id);
      conditions.push(`o.customer_id = $${values.length}::uuid`);
    }
    // FR-802: "which order did these come back from?" is asked of the orders that carried the
    // material, through `order_lines_item_idx` rather than a scan of the lines.
    if (filters.item_id) {
      values.push(filters.item_id);
      conditions.push(
        `EXISTS (SELECT 1 FROM order_lines ol
                  WHERE ol.order_id = o.id AND ol.deleted_at IS NULL
                    AND ol.item_id = $${values.length}::uuid)`,
      );
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
    if (filters.payment_type) {
      values.push(filters.payment_type);
      conditions.push(`o.payment_type = $${values.length}::payment_type`);
    }
    // The list without its status filter, for the figures answered from the maintained sums.
    const baseValues = [...values];
    const baseConditions = [
      ...conditions,
      ...(filters.include_undone ? [] : [`(o.status <> 'void' OR o.void_reason <> 'undo')`]),
    ];
    if (filters.status) {
      // The status is derived from the maintained per-order sum. The owing statuses also say
      // "owes something in some currency", which is what lets the partial index of the owing
      // orders answer them instead of every order ever placed (D-075).
      if (filters.status === 'owing') {
        conditions.push(`o.status <> 'void' AND ${MAY_OWE} AND ${REMAINING} > 0`);
      } else if (filters.status === 'unpaid' || filters.status === 'partially_paid') {
        values.push(filters.status);
        conditions.push(`${MAY_OWE} AND ${STATUS_EXPRESSION} = $${values.length}`);
      } else if (filters.status === 'void') {
        // The derived status is 'void' exactly when the document is: said so, it is a range of
        // the partial index of voided orders (migration 0034).
        conditions.push(`o.status = 'void'`);
      } else {
        // Paid: not void, and nothing left in the settlement currency.
        conditions.push(`o.status <> 'void' AND ${REMAINING} <= 0`);
      }
    }
    if (!filters.include_undone) {
      // Orders voided through the 8-second undo are hidden by default (2.4.5, FR-610).
      conditions.push(`(o.status <> 'void' OR o.void_reason <> 'undo')`);
    }
    const query = filters.q?.trim();
    if (query) {
      // Three questions, each answered by its own index and put together as one set of ids: the
      // customer's name (trigram index on customers, then the customer's orders), the notes
      // (trigram index on orders.notes, migration 0034) and the number (its unique key) — an OR
      // across two tables in one WHERE could use none of them, 750 ms at ten years (D-075).
      values.push(containing(normalizeForSearch(query)));
      const nameParam = values.length;
      values.push(containing(query));
      const textParam = values.length;
      const asNumber = Number(query.replace(/\D/g, ''));
      const byNumber = Number.isSafeInteger(asNumber) && asNumber > 0;
      if (byNumber) values.push(asNumber);
      const numberParam = values.length;
      conditions.push(
        `o.id IN (SELECT m.id FROM orders m
                   WHERE m.customer_id IN (SELECT who.id FROM customers who WHERE who.name_normalized LIKE $${nameParam})
                  UNION
                  SELECT m.id FROM orders m WHERE m.notes ILIKE $${textParam}` +
          (byNumber ? `\n                  UNION\n                  SELECT m.id FROM orders m WHERE m.number = $${numberParam}::bigint` : '') +
          `)`,
      );
    }

    const customer = 'JOIN customers c ON c.id = o.customer_id';
    const where = `WHERE ${conditions.join(' AND ')}`;
    /**
     * The count and the totals are built from the narrowest `FROM` the filters need (D-047):
     * the customer only when a condition names it, what is still owed only when the status
     * filter asks — and the totals, which always need both, in the same pass as the count.
     */
    const narrow = countFrom('FROM orders o', where, [
      { alias: 'c.', sql: customer },
      { alias: 'r.', sql: REMAINING_JOIN },
    ]);

    const countValues = [...values];
    const { page_size: pageSize, offset } = pagingOf(filters);
    values.push(pageSize, offset);

    /**
     * Page first, then fill (D-075): the ids of the page are chosen from the orders alone, in the
     * list's order, and only those twenty-five rows are joined to their customer, their people,
     * what they still owe and the currency that was handed over. The laterals used to run for
     * every row the OFFSET skipped, so the last page of ten years cost 4 s.
     */
    const pageQuery = this.database.query<OrderListRow>(
      `WITH page AS (
         SELECT o.id, o.order_date, o.number
         ${narrow}
         ${where}
         ORDER BY o.order_date DESC, o.number DESC
         LIMIT $${values.length - 1} OFFSET $${values.length}
       )
       SELECT ${orderColumns('o')}, ${LIST_COLUMNS}
         FROM page
         JOIN orders o ON o.id = page.id
         ${customer}
         LEFT JOIN users u ON u.id = o.acting_user_id
         LEFT JOIN users v ON v.id = o.voided_by
         ${REMAINING_JOIN}
         ${RECEIVED_LATERAL}
        ORDER BY page.order_date DESC, page.number DESC`,
      values,
    );

    if (filters.totals === false) {
      // The dashboard's latest orders: the rows and the count, not the figures over every order.
      const [list, count] = await Promise.all([
        pageQuery,
        this.database.query<{ total: string }>(`SELECT count(*)::text AS total ${narrow} ${where}`, countValues),
      ]);
      return { rows: list.rows, total: Number(count.rows[0]?.total ?? 0), totals: null };
    }

    // The figures over the whole filter, for the cards above the list (client review): what the
    // orders came to and what is still owed on them, in both currencies, counting only orders
    // that still owe something in their company's own currency.
    //
    // Two questions with two different shapes (D-075). What the orders came to is a pass over the
    // orders alone. What is still owed is a pass over the orders that owe — the partial index of
    // migration 0034 — joined to those orders; joining every order to its remaining figure to
    // find them spilled a 1.8-million-row hash to disk (560 ms). When the status filter already
    // joins the remaining figure, one pass answers both.
    const owes = `o.status = 'active' AND ${MAY_OWE} AND ${REMAINING} > 0`;
    const documents = `count(*)::text AS total,
                count(*) FILTER (WHERE o.status = 'active')::text AS orders,
                coalesce(sum(o.total_iqd) FILTER (WHERE o.status = 'active'), 0)::text AS total_iqd,
                coalesce(sum(o.total_usd_cents) FILTER (WHERE o.status = 'active'), 0)::text AS total_usd_cents`;
    const owing = `count(*) FILTER (WHERE ${owes})::text AS owing,
                coalesce(sum(r.remaining_iqd) FILTER (WHERE ${owes}), 0)::text AS owed_iqd,
                coalesce(sum(r.remaining_usd_cents) FILTER (WHERE ${owes}), 0)::text AS owed_usd_cents`;
    type Totals = {
      total: string;
      orders: string;
      total_iqd: string;
      total_usd_cents: string;
      owing: string;
      owed_iqd: string;
      owed_usd_cents: string;
    };
    const joinsRemaining = narrow.includes(REMAINING_JOIN);
    // Nothing narrows the list but, perhaps, the account and a status other than void: what is
    // owed — and, for a status filter, the whole count and the totals — is then the maintained
    // per-account sum of migration 0035, one row per account instead of every owing order
    // (430–480 ms at ten years, when two orders in three were still owed).
    const unnarrowed =
      !filters.item_id && !filters.from && !filters.to && !filters.done_by && !filters.payment_type && !query;
    if (unnarrowed && filters.status !== 'void') {
      const status = filters.status;
      const owingNow = this.owingOf(filters.customer_id);
      // The orders themselves, without the status filter: every order for "All", the active
      // ones for "paid" (every active order that does not owe).
      const documentsNow =
        status === undefined || status === 'paid'
          ? this.database
              .query<Totals>(`SELECT ${documents} FROM orders o WHERE ${baseConditions.join(' AND ')}`, baseValues)
              .then((result) => result.rows[0])
          : Promise.resolve(undefined);
      const [list, documentRow, owed] = await Promise.all([pageQuery, documentsNow, owingNow]);
      const set =
        status === 'unpaid' ? owed.unpaid : status === 'partially_paid' ? minusSet(owed.owing, owed.unpaid) : owed.owing;
      const active = {
        orders: Number(documentRow?.orders ?? 0),
        total_iqd: Number(documentRow?.total_iqd ?? 0),
        total_usd_cents: Number(documentRow?.total_usd_cents ?? 0),
      };
      if (status === undefined) {
        return {
          rows: list.rows,
          total: Number(documentRow?.total ?? 0),
          totals: { ...active, balance: balanceOf(owed.owing) },
        };
      }
      if (status === 'paid') {
        const paid = active.orders - owed.owing.orders;
        return {
          rows: list.rows,
          total: paid,
          totals: {
            orders: paid,
            total_iqd: active.total_iqd - owed.owing.total_iqd,
            total_usd_cents: active.total_usd_cents - owed.owing.total_usd_cents,
            balance: { owing: 0, owed_iqd: 0, owed_usd_cents: 0 },
          },
        };
      }
      // Owing, unpaid, partly paid: every one of these orders is active and owes, so the list's
      // count and its totals are the set's own.
      return {
        rows: list.rows,
        total: set.orders,
        totals: { orders: set.orders, total_iqd: set.total_iqd, total_usd_cents: set.total_usd_cents, balance: balanceOf(set) },
      };
    }
    const totalsQuery: Promise<Totals | undefined> = joinsRemaining
      ? this.database
          .query<Totals>(`SELECT ${documents}, ${owing} ${narrow} ${where}`, countValues)
          .then((result) => result.rows[0])
      : Promise.all([
          this.database.query<Totals>(`SELECT ${documents} ${narrow} ${where}`, countValues),
          this.database.query<Totals>(
            `SELECT ${owing}
               FROM order_remaining r
               JOIN orders o ON o.id = r.order_id
               ${customer}
               ${where} AND ${MAY_OWE}`,
            countValues,
          ),
        ]).then(([documentRows, owingRows]) => ({ ...documentRows.rows[0], ...owingRows.rows[0] }) as Totals);
    const [list, t] = await Promise.all([pageQuery, totalsQuery]);

    return {
      rows: list.rows,
      total: Number(t?.total ?? 0),
      totals: {
        orders: Number(t?.orders ?? 0),
        total_iqd: Number(t?.total_iqd ?? 0),
        total_usd_cents: Number(t?.total_usd_cents ?? 0),
        balance: {
          owing: Number(t?.owing ?? 0),
          owed_iqd: Number(t?.owed_iqd ?? 0),
          owed_usd_cents: Number(t?.owed_usd_cents ?? 0),
        },
      },
    };
  }

  /**
   * The orders still owed — of one account, or of all — from the maintained per-account sums of
   * migration 0035: how many, what is left on them and what they came to, and the same for the
   * ones owed in full ("unpaid"); each account's orders counted in its own settlement currency,
   * each currency summed on its own side (rule 1).
   */
  async owingOf(customerId?: string): Promise<{ owing: OwingSet; unpaid: OwingSet }> {
    const pick = (column: string) =>
      `coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN a.iqd_${column} ELSE a.usd_${column} END), 0)::text`;
    const columns = ['orders', 'remaining_iqd', 'remaining_usd_cents', 'total_iqd', 'total_usd_cents'] as const;
    const { rows } = await this.database.query<Record<string, string>>(
      `SELECT ${columns.map((column) => `${pick(column)} AS owing_${column}`).join(', ')},
              ${columns.map((column) => `${pick(`unpaid_${column}`)} AS unpaid_${column}`).join(', ')}
         FROM account_owing a
         JOIN customers c ON c.id = a.account_id
        WHERE ($1::uuid IS NULL OR a.account_id = $1::uuid)`,
      [customerId ?? null],
    );
    const row = rows[0] ?? {};
    const setOf = (prefix: string): OwingSet => ({
      orders: Number(row[`${prefix}_orders`] ?? 0),
      remaining_iqd: Number(row[`${prefix}_remaining_iqd`] ?? 0),
      remaining_usd_cents: Number(row[`${prefix}_remaining_usd_cents`] ?? 0),
      total_iqd: Number(row[`${prefix}_total_iqd`] ?? 0),
      total_usd_cents: Number(row[`${prefix}_total_usd_cents`] ?? 0),
    });
    return { owing: setOf('owing'), unpaid: setOf('unpaid') };
  }

  /** What the ledger says is still owed on one order, in one currency (0 before any entry). */
  async remainingOf(orderId: string, currency: 'IQD' | 'USD', tx: Db): Promise<number> {
    const column = currency === 'IQD' ? 'remaining_iqd' : 'remaining_usd_cents';
    const { rows } = await tx.query<{ remaining: string }>(
      `SELECT ${column}::text AS remaining FROM order_remaining WHERE order_id = $1`,
      [orderId],
    );
    return Number(rows[0]?.remaining ?? 0);
  }

  async linesOf(orderId: string, tx?: Db): Promise<OrderLineRow[]> {
    const { rows } = await (tx ?? this.database).query<OrderLineRow>(
      `SELECT ${LINE_COLUMNS}, i.name AS item_name, i.pricing_unit::text AS item_pricing_unit,
              to_char(p.month, 'YYYY-MM-DD') AS price_month
         FROM order_lines l
         JOIN items i ON i.id = l.item_id
         LEFT JOIN item_month_prices p ON p.id = l.month_price_id
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
      const margin = lineMargin({
        priced_measure: line.priced_measure,
        qty_count: line.qty_count,
        qty_kg: line.qty_kg,
        unit_price_iqd: line.unit_price_iqd,
        unit_price_usd_cents: line.unit_price_usd_cents,
        price_entered_currency: line.price_entered_currency,
        rate_iqd_per_usd: line.rate_iqd_per_usd,
        cost_unit_iqd: line.cost_unit_iqd,
        cost_unit_usd_cents: line.cost_unit_usd_cents,
        cost_source: line.cost_source,
        cost_total_iqd: line.cost_total_iqd ?? null,
        cost_total_usd_cents: line.cost_total_usd_cents ?? null,
      });
      const { rows } = await tx.query<OrderLineRow>(
        `INSERT INTO order_lines
           (order_id, line_no, item_id, qty_count, qty_kg, priced_measure, unit_price_iqd,
            unit_price_usd_cents, price_entered_currency, price_source, month_price_id,
            rate_iqd_per_usd, rate_source, line_total_iqd, line_total_usd_cents,
            cost_unit_iqd, cost_unit_usd_cents, cost_month_price_id, cost_source,
            margin_iqd, margin_usd_cents, note, created_by)
         VALUES ($1, $2, $3, $4, $5::numeric, $6::measure, $7, $8, $9::currency, $10::price_source, $11,
                 $12::numeric, $13::rate_source, $14, $15, $16, $17, $18, $19::cost_source,
                 $20, $21, $22, $23)
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
          // The margin is computed **here**, by the kernel, once — and stored like the cost
          // snapshot beside it, so the report can sum integers instead of re-deriving a
          // million lines (D-039, REVIEW-I6).
          margin?.margin_iqd ?? null,
          margin?.margin_usd_cents ?? null,
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
      rounding_iqd: number;
      rounding_usd_cents: number;
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

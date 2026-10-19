import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/errors.js';
import { can } from '../common/request-context.js';
import type { RequestContext } from '../common/request-context.js';
import { pagingOf } from '../common/paging.js';
import { owedToCompanies, owedToUs } from '../common/owed-totals.js';
import { Database } from '../database/pool.js';
import { OrdersRepository } from '../orders/orders.repository.js';
import type { OrderFilters } from '../orders/orders.repository.js';
import { OrdersService } from '../orders/orders.service.js';
import type { OrderDto } from '../orders/order.types.js';
import { PurchasesRepository } from '../purchases/purchases.repository.js';
import type { PurchaseFilters } from '../purchases/purchases.repository.js';
import { PurchasesService } from '../purchases/purchases.service.js';
import type { PurchaseDto } from '../purchases/purchases.service.js';

/** The two kinds of document the Buying & selling page lists (D-089). */
export type TradeKind = 'sale' | 'purchase';

export interface TradeFilters {
  kind?: TradeKind;
  from?: string;
  to?: string;
  q?: string;
  /** The company: the customer of a sale, the supplier of a purchase. */
  company_id?: string;
  /** The driver who took a sale or brought a purchase in (D-105, D-106). */
  driver_id?: string;
  done_by?: string;
  /** Paid states are a sale's alone; `void` is either kind's. */
  status?: 'unpaid' | 'partially_paid' | 'paid' | 'owing' | 'void';
  /** A sale's alone. */
  payment_type?: 'cash' | 'borrowed';
  totals?: boolean;
  page?: number;
  page_size?: number;
}

export type TradeItem = ({ kind: 'sale' } & OrderDto) | ({ kind: 'purchase' } & PurchaseDto);

type Owed = { companies: number; owed_iqd: number; owed_usd_cents: number };

/**
 * Buying & selling (D-089): sales and purchases on one page, newest first, paged as one list.
 *
 * Each side asks its own question of its own indexes — the very filter its own list runs
 * (`pageKeysSql`) — and the two are put together as one list of ids, sorted by the business date,
 * then by when they were entered; only the page's ids are then filled, each by its own side, as
 * its own list sends it. A reader sees the sides they may: sales with `orders.view`, purchases
 * with `purchases.view`, both with both; anyone with neither is refused.
 *
 * The figures: what the filter's sales and purchases came to, each on its own (never a sum of
 * the two), and — for the business as a whole, not the filter — what the companies owe us and
 * what we owe them, each behind its balances flag.
 */
@Injectable()
export class TradeService {
  constructor(
    private readonly database: Database,
    private readonly orders: OrdersRepository,
    private readonly ordersService: OrdersService,
    private readonly purchases: PurchasesRepository,
    private readonly purchasesService: PurchasesService,
  ) {}

  async list(context: RequestContext, filters: TradeFilters) {
    const maySales = can(context, 'orders.view');
    const mayPurchases = can(context, 'purchases.view');
    // The guard already refused a reader with neither key; this is the service saying it again
    // for anyone who calls it from elsewhere.
    if (!maySales && !mayPurchases) throw ApiError.permissionDenied('orders.view');

    // The side asked for narrows only a reader who may see both: one who may see one side sees
    // it whatever the address says — /orders opening on sales must not show a buyer nothing.
    const kind = maySales && mayPurchases ? filters.kind : undefined;
    // A paid state or a payment type is a sale's question: asked, the purchases leave the list.
    const saleOnly =
      filters.payment_type !== undefined || (filters.status !== undefined && filters.status !== 'void');
    const sales = maySales && kind !== 'purchase';
    const buys = mayPurchases && kind !== 'sale' && !saleOnly;

    const saleFilters: OrderFilters = {
      customer_id: filters.company_id,
      driver_id: filters.driver_id,
      from: filters.from,
      to: filters.to,
      done_by: filters.done_by,
      payment_type: filters.payment_type,
      status: filters.status,
      q: filters.q,
    };
    const purchaseFilters: PurchaseFilters = {
      company_id: filters.company_id,
      driver_id: filters.driver_id,
      from: filters.from,
      to: filters.to,
      done_by: filters.done_by,
      status: filters.status === 'void' ? 'void' : undefined,
      q: filters.q,
    };

    const wantsTotals = filters.totals !== false;
    const seesOwedToUs = can(context, 'fields.see_customer_balances');
    const seesOwedByUs = can(context, 'fields.see_company_balances');
    // What the companies owe us and what we owe them are the business's, not the filter's: they
    // are answered even when the filter leaves no side to list (review).
    const owedFigures = Promise.all([
      wantsTotals && maySales && seesOwedToUs ? owedToUs(this.database) : Promise.resolve(null),
      wantsTotals && mayPurchases && seesOwedByUs ? owedToCompanies(this.database) : Promise.resolve(null),
    ]);

    const { page_size: pageSize, offset } = pagingOf(filters);
    const values: unknown[] = [];
    const parts = [
      ...(sales ? [this.orders.pageKeysSql(saleFilters, values)] : []),
      ...(buys ? [this.purchases.pageKeysSql(purchaseFilters, values)] : []),
    ];
    const countValues = [...values];
    // Each side reads only the rows a page can need, newest first, straight from its (date,
    // number) index; only those are put together and sorted (review: sorting every matching row
    // of both tables was millions of rows a page at ten years). The final order adds the kind and
    // the id, so two documents that tie on date and number keep one place between pages.
    values.push(offset + pageSize);
    const reach = values.length;
    values.push(pageSize, offset);
    const pageSql = parts
      .map((part) => `(${part.keys} ORDER BY day DESC, number DESC LIMIT $${reach})`)
      .join('\nUNION ALL\n');

    const [page, saleList, buyList, count] = await Promise.all([
      parts.length > 0
        ? this.database.query<{ id: string; kind: TradeKind }>(
            `SELECT id, kind FROM (${pageSql}) t
              ORDER BY day DESC, number DESC, kind, id
              LIMIT $${values.length - 1} OFFSET $${values.length}`,
            values,
          )
        : Promise.resolve({ rows: [] as { id: string; kind: TradeKind }[] }),
      // With the figures asked for, each side's own list answers its count and its totals in
      // one go; the combined count is then their sum, with no separate count of its own.
      wantsTotals && sales ? this.orders.list({ ...saleFilters, page_size: 1 }) : Promise.resolve(null),
      wantsTotals && buys ? this.purchases.list({ ...purchaseFilters, page_size: 1 }) : Promise.resolve(null),
      !wantsTotals && parts.length > 0
        ? this.database
            .query<{ total: string }>(
              `SELECT (${parts.map((part) => `(${part.count})`).join(' + ')})::text AS total`,
              countValues,
            )
            .then((result) => Number(result.rows[0]?.total ?? 0))
        : Promise.resolve(0),
    ]);
    const [toUs, byUs] = await owedFigures;

    const saleIds = page.rows.filter((row) => row.kind === 'sale').map((row) => row.id);
    const buyIds = page.rows.filter((row) => row.kind === 'purchase').map((row) => row.id);
    const [saleItems, buyItems] = await Promise.all([
      this.ordersService.listItemsByIds(saleIds),
      this.purchasesService.listItemsByIds(buyIds, seesOwedByUs),
    ]);
    const byId = new Map<string, TradeItem>([
      ...saleItems.map((item): [string, TradeItem] => [item.id, { kind: 'sale', ...item }]),
      ...buyItems.map((item): [string, TradeItem] => [item.id, { kind: 'purchase', ...item }]),
    ]);
    const items = page.rows.map((row) => byId.get(row.id)).filter((item): item is TradeItem => item !== undefined);

    const total = wantsTotals ? (saleList?.total ?? 0) + (buyList?.total ?? 0) : count;
    if (!wantsTotals) return { items, total };
    const saleTotals = saleList?.totals;
    const buyTotals = buyList?.totals;
    return {
      items,
      total,
      totals: {
        ...(saleTotals
          ? { sales: { count: saleTotals.orders, total_iqd: saleTotals.total_iqd, total_usd_cents: saleTotals.total_usd_cents } }
          : {}),
        ...(buyTotals
          ? {
              purchases: {
                count: buyTotals.buys,
                cost: { total_iqd: buyTotals.total_iqd, total_usd_cents: buyTotals.total_usd_cents },
              },
            }
          : {}),
        ...(toUs ? { owed_to_us: toUs as Owed } : {}),
        ...(byUs ? { owed_by_us: byUs as Owed } : {}),
      },
    };
  }
}

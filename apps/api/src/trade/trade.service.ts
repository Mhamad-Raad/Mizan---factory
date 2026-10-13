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
    if (!maySales && !mayPurchases) throw ApiError.permissionDenied('orders.view');

    // A paid state or a payment type is a sale's question: asked, the purchases leave the list.
    const saleOnly =
      filters.payment_type !== undefined || (filters.status !== undefined && filters.status !== 'void');
    const sales = maySales && filters.kind !== 'purchase';
    const buys = mayPurchases && filters.kind !== 'sale' && !saleOnly;

    const saleFilters: OrderFilters = {
      customer_id: filters.company_id,
      from: filters.from,
      to: filters.to,
      done_by: filters.done_by,
      payment_type: filters.payment_type,
      status: filters.status,
      q: filters.q,
    };
    const purchaseFilters: PurchaseFilters = {
      company_id: filters.company_id,
      from: filters.from,
      to: filters.to,
      done_by: filters.done_by,
      status: filters.status === 'void' ? 'void' : undefined,
      q: filters.q,
    };

    const values: unknown[] = [];
    const parts = [
      ...(sales ? [this.orders.pageKeysSql(saleFilters, values)] : []),
      ...(buys ? [this.purchases.pageKeysSql(purchaseFilters, values)] : []),
    ];
    const { page_size: pageSize, offset } = pagingOf(filters);

    const seesOwedToUs = can(context, 'fields.see_customer_balances');
    const seesOwedByUs = can(context, 'fields.see_company_balances');

    if (parts.length === 0) {
      return { items: [] as TradeItem[], total: 0, totals: filters.totals === false ? undefined : {} };
    }

    const countValues = [...values];
    values.push(pageSize, offset);
    const [page, count, saleTotals, buyTotals, toUs, byUs] = await Promise.all([
      this.database.query<{ id: string; kind: TradeKind }>(
        `SELECT id, kind FROM (${parts.map((part) => part.keys).join('\nUNION ALL\n')}) t
          ORDER BY day DESC, created_at DESC, number DESC
          LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      ),
      this.database.query<{ total: string }>(
        `SELECT (${parts.map((part) => `(${part.count})`).join(' + ')})::text AS total`,
        countValues,
      ),
      // What the filter's sales and purchases came to: each list's own figures, on its own.
      filters.totals !== false && sales
        ? this.orders.list({ ...saleFilters, page_size: 1 }).then((result) => result.totals)
        : Promise.resolve(null),
      filters.totals !== false && buys
        ? this.purchases.list({ ...purchaseFilters, page_size: 1 }).then((result) => result.totals)
        : Promise.resolve(null),
      filters.totals !== false && maySales && seesOwedToUs ? owedToUs(this.database) : Promise.resolve(null),
      filters.totals !== false && mayPurchases && seesOwedByUs ? owedToCompanies(this.database) : Promise.resolve(null),
    ]);

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

    return {
      items,
      total: Number(count.rows[0]?.total ?? 0),
      totals:
        filters.totals === false
          ? undefined
          : {
              ...(saleTotals
                ? {
                    sales: {
                      count: saleTotals.orders,
                      total_iqd: saleTotals.total_iqd,
                      total_usd_cents: saleTotals.total_usd_cents,
                    },
                  }
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

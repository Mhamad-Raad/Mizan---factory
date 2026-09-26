import { Controller, Get, Req } from '@nestjs/common';
import { RequirePermission } from '../common/decorators.js';
import { can, contextOf } from '../common/request-context.js';
import type { RequestWithContext } from '../common/request-context.js';
import { SensitiveFields } from '../common/sensitive-field.interceptor.js';
import { Database } from '../database/pool.js';
import { RatesService } from '../rates/rates.service.js';
import { PeriodService } from '../settings/period.service.js';

export interface DashboardTile {
  key: string;
  count?: number;
  /** Sale prices, which anyone who may see the records may see (FR-602). */
  amount_iqd?: number;
  amount_usd_cents?: number;
  /** Bought prices, which travel under `cost` so one flag hides them (D-022). */
  cost?: { amount_iqd: number; amount_usd_cents: number } | null;
  /** Customer balances: their own key, their own flag, and always a pair (D-022, rule 1). */
  balance?: { amount_iqd: number; amount_usd_cents: number } | null;
  /** What we owe suppliers — a *company* balance, so not the bought-price flag's business. */
  owed?: { amount_iqd: number; amount_usd_cents: number } | null;
}

/**
 * The dashboard (FR-1309, **Proposed — not requested**): today's numbers, one tile per
 * question an owner asks on waking up.
 *
 * Each tile is computed only for a caller who may see its subject — a sales employee gets
 * today's sales and their own recent actions, not what the factory owes its suppliers — and the
 * money on every tile travels under `cost`, so a user without bought prices still sees the
 * counts. The stale-rate prompt of FR-1106 rides along, because the dashboard is where somebody
 * would notice it.
 *
 * The tiles are independent questions, so they are asked **together** and the answers are
 * assembled in the order the screen reads them. This is the first screen after signing in on a
 * phone: asked one after another, the request cost the sum of every tile (I4 review).
 */
@Controller('dashboard')
@SensitiveFields({
  cost: 'fields.see_bought_price',
  balance: 'fields.see_customer_balances',
  owed: 'fields.see_company_balances',
})
export class DashboardController {
  constructor(
    private readonly database: Database,
    private readonly period: PeriodService,
    private readonly rates: RatesService,
  ) {}

  @Get()
  @RequirePermission('dashboard.view')
  async tiles(@Req() request: RequestWithContext): Promise<{
    date: string;
    tiles: DashboardTile[];
    rate: { rate_iqd_per_usd: string } | null;
  }> {
    const context = contextOf(request);
    const today = this.period.today();
    const asking: Promise<DashboardTile[]>[] = [];

    if (can(context, 'orders.view')) {
      // A sales employee's dashboard is their own work (spec 2.6.4); an owner's is the factory's.
      const scoped = can(context, 'customers.view_all') ? null : context.userId;
      asking.push(this.sellingTiles(today, scoped));
    }
    if (can(context, 'purchases.view')) asking.push(this.purchaseTile(today));
    if (can(context, 'companies.view') && can(context, 'fields.see_company_balances')) {
      asking.push(this.supplierTile());
    }
    if (can(context, 'materials.view')) asking.push(this.lowStockTile());
    if (can(context, 'damages.view')) asking.push(this.pendingReturnsTile());
    // Everyone's own recent actions, which needs no permission: it is their own trail (1.5.2).
    asking.push(this.myActionsTile(context.userId, today));

    const [groups, current] = await Promise.all([Promise.all(asking), this.rates.current()]);
    const tiles = groups.flat();

    return {
      date: today,
      tiles,
      rate: current ? { rate_iqd_per_usd: current.rate_iqd_per_usd } : null,
    };
  }

  /** Today's sales and what is still owed — two questions about the same records. */
  private async sellingTiles(today: string, scoped: string | null): Promise<DashboardTile[]> {
    const [sold, unpaid] = await Promise.all([
      this.database.query<{ count: string; iqd: string; usd_cents: string }>(
        `SELECT count(*)::text AS count,
                coalesce(sum(o.total_iqd), 0)::text AS iqd,
                coalesce(sum(o.total_usd_cents), 0)::text AS usd_cents
           FROM orders o JOIN customers c ON c.id = o.customer_id
          WHERE o.status = 'active' AND o.deleted_at IS NULL AND o.order_date = $1::date
            AND ($2::uuid IS NULL OR c.assigned_user_id = $2::uuid OR o.acting_user_id = $2::uuid
                 OR c.is_system = true)`,
        [today, scoped],
      ),
      // One grouped pass over the ledger rather than the `order_balances` view, which groups
      // every order ever placed and cannot be narrowed from outside (I1 and I4 reviews).
      //
      // "Is this order still owed?" is asked in the customer's **settlement** currency, because
      // that is the side the debt is agreed in; what is *summed* is each currency on its own,
      // because dinars and cents are not addable — the worst defect of the I1 review, and it
      // had come back here as one mixed number labelled dinars on the tile.
      this.database.query<{ count: string; iqd: string; usd_cents: string }>(
        // From the maintained sum of migration 0015 rather than from a pass over the whole
        // ledger: 1.0 s → 20 ms at the design point of NFR-13, and the figure is still a sum
        // over the ledger — `check-integrity.mjs` proves it on every restore drill (2.2.6).
        `SELECT count(*)::text AS count,
                coalesce(sum(r.remaining_iqd), 0)::text AS iqd,
                coalesce(sum(r.remaining_usd_cents), 0)::text AS usd_cents
           FROM order_remaining r
           JOIN orders o ON o.id = r.order_id
           JOIN customers c ON c.id = o.customer_id
          WHERE o.status = 'active' AND o.deleted_at IS NULL
            AND ($1::uuid IS NULL OR c.assigned_user_id = $1::uuid OR o.acting_user_id = $1::uuid
                 OR c.is_system = true)
            AND (CASE WHEN c.settlement_currency = 'IQD' THEN r.remaining_iqd
                      ELSE r.remaining_usd_cents END) > 0`,
        [scoped],
      ),
    ]);

    const row = sold.rows[0];
    return [
      {
        key: 'sales_today',
        count: Number(row?.count ?? 0),
        amount_iqd: Number(row?.iqd ?? 0),
        amount_usd_cents: Number(row?.usd_cents ?? 0),
      },
      {
        key: 'unpaid_orders',
        count: Number(unpaid.rows[0]?.count ?? 0),
        balance: {
          amount_iqd: Number(unpaid.rows[0]?.iqd ?? 0),
          amount_usd_cents: Number(unpaid.rows[0]?.usd_cents ?? 0),
        },
      },
    ];
  }

  private async purchaseTile(today: string): Promise<DashboardTile[]> {
    const { rows } = await this.database.query<{ count: string; iqd: string; usd_cents: string }>(
      `SELECT count(*)::text AS count,
              coalesce(sum(total_iqd), 0)::text AS iqd,
              coalesce(sum(total_usd_cents), 0)::text AS usd_cents
         FROM purchases
        WHERE status = 'active' AND deleted_at IS NULL AND purchase_date = $1::date`,
      [today],
    );
    return [
      {
        key: 'purchases_today',
        count: Number(rows[0]?.count ?? 0),
        cost: {
          amount_iqd: Number(rows[0]?.iqd ?? 0),
          amount_usd_cents: Number(rows[0]?.usd_cents ?? 0),
        },
      },
    ];
  }

  private async supplierTile(): Promise<DashboardTile[]> {
    const { rows } = await this.database.query<{
      iqd: string;
      usd_cents: string;
      companies: string;
    }>(
      `SELECT coalesce(sum(l.amount_iqd), 0)::text AS iqd,
              coalesce(sum(l.amount_usd_cents), 0)::text AS usd_cents,
              count(DISTINCT l.company_id)::text AS companies
         FROM company_ledger l`,
    );
    return [
      {
        key: 'we_owe_companies',
        count: Number(rows[0]?.companies ?? 0),
        // Under `owed`, not `cost`: what we owe a supplier is a balance, and hiding it from
        // somebody who may see supplier balances but not bought prices was the wrong flag
        // answering the wrong question (D-022).
        owed: {
          amount_iqd: Number(rows[0]?.iqd ?? 0),
          amount_usd_cents: Number(rows[0]?.usd_cents ?? 0),
        },
      },
    ];
  }

  private async lowStockTile(): Promise<DashboardTile[]> {
    const { rows } = await this.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM items i
         JOIN item_stock s ON s.item_id = i.id
        WHERE i.deleted_at IS NULL AND i.is_active = true
          AND ((i.pricing_unit = 'per_piece' AND i.min_stock_count IS NOT NULL
                AND s.stock_count <= i.min_stock_count)
            OR (i.pricing_unit = 'per_kg' AND i.min_stock_kg IS NOT NULL
                AND s.stock_kg <= i.min_stock_kg))`,
    );
    return [{ key: 'low_stock', count: Number(rows[0]?.count ?? 0) }];
  }

  private async pendingReturnsTile(): Promise<DashboardTile[]> {
    const { rows } = await this.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM damages
        WHERE status = 'active' AND deleted_at IS NULL AND return_status = 'pending'`,
    );
    return [{ key: 'pending_returns', count: Number(rows[0]?.count ?? 0) }];
  }

  private async myActionsTile(userId: string, today: string): Promise<DashboardTile[]> {
    const { rows } = await this.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log
        WHERE actor_user_id = $1
          AND occurred_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Baghdad')`,
      [userId, today],
    );
    return [{ key: 'my_actions_today', count: Number(rows[0]?.count ?? 0) }];
  }
}

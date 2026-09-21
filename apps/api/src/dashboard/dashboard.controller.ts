import { Controller, Get, Req } from '@nestjs/common';
import { RequirePermission } from '../common/decorators.js';
import { can, contextOf } from '../common/request-context.js';
import type { RequestWithContext } from '../common/request-context.js';
import { SensitiveFields } from '../common/sensitive-field.interceptor.js';
import { Database } from '../database/pool.js';
import { RatesService } from '../rates/rates.service.js';
import { PeriodService } from '../settings/period.service.js';
import { SettingsService } from '../settings/settings.service.js';

export interface DashboardTile {
  key: string;
  count?: number;
  /** Sale prices, which anyone who may see the records may see (FR-602). */
  amount_iqd?: number;
  amount_usd_cents?: number;
  /** Bought prices and balances, which travel under `cost` so one flag hides them (D-022). */
  cost?: { amount_iqd: number; amount_usd_cents: number } | null;
  detail?: string | null;
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
 */
@Controller('dashboard')
@SensitiveFields({ cost: 'fields.see_bought_price' })
export class DashboardController {
  constructor(
    private readonly database: Database,
    private readonly period: PeriodService,
    private readonly rates: RatesService,
    private readonly settings: SettingsService,
  ) {}

  @Get()
  @RequirePermission('dashboard.view')
  async tiles(@Req() request: RequestWithContext): Promise<{
    date: string;
    tiles: DashboardTile[];
    rate: { rate_iqd_per_usd: string; is_stale: boolean } | null;
  }> {
    const context = contextOf(request);
    const today = this.period.today();
    const tiles: DashboardTile[] = [];

    if (can(context, 'orders.view')) {
      const scoped = can(context, 'customers.view_all') ? null : context.userId;
      const { rows } = await this.database.query<{ count: string; iqd: string; usd_cents: string }>(
        `SELECT count(*)::text AS count,
                coalesce(sum(o.total_iqd), 0)::text AS iqd,
                coalesce(sum(o.total_usd_cents), 0)::text AS usd_cents
           FROM orders o JOIN customers c ON c.id = o.customer_id
          WHERE o.status = 'active' AND o.deleted_at IS NULL AND o.order_date = $1::date
            AND ($2::uuid IS NULL OR c.assigned_user_id = $2::uuid OR o.acting_user_id = $2::uuid
                 OR c.is_system = true)`,
        [today, scoped],
      );
      const row = rows[0];
      tiles.push({
        key: 'sales_today',
        count: Number(row?.count ?? 0),
        amount_iqd: Number(row?.iqd ?? 0),
        amount_usd_cents: Number(row?.usd_cents ?? 0),
      });

      const unpaid = await this.database.query<{ count: string; remaining: string }>(
        `SELECT count(*)::text AS count, coalesce(sum(b.remaining), 0)::text AS remaining
           FROM order_balances b
           JOIN orders o ON o.id = b.order_id
           JOIN customers c ON c.id = o.customer_id
          WHERE b.status <> 'paid' AND o.status = 'active' AND o.deleted_at IS NULL
            AND ($1::uuid IS NULL OR c.assigned_user_id = $1::uuid OR o.acting_user_id = $1::uuid
                 OR c.is_system = true)`,
        [scoped],
      );
      tiles.push({
        key: 'unpaid_orders',
        count: Number(unpaid.rows[0]?.count ?? 0),
        detail: can(context, 'fields.see_customer_balances') ? unpaid.rows[0]?.remaining ?? '0' : null,
      });
    }

    if (can(context, 'purchases.view')) {
      const { rows } = await this.database.query<{ count: string; iqd: string; usd_cents: string }>(
        `SELECT count(*)::text AS count,
                coalesce(sum(total_iqd), 0)::text AS iqd,
                coalesce(sum(total_usd_cents), 0)::text AS usd_cents
           FROM purchases
          WHERE status = 'active' AND deleted_at IS NULL AND purchase_date = $1::date`,
        [today],
      );
      tiles.push({
        key: 'purchases_today',
        count: Number(rows[0]?.count ?? 0),
        cost: {
          amount_iqd: Number(rows[0]?.iqd ?? 0),
          amount_usd_cents: Number(rows[0]?.usd_cents ?? 0),
        },
      });
    }

    if (can(context, 'companies.view') && can(context, 'fields.see_company_balances')) {
      const { rows } = await this.database.query<{ iqd: string; usd_cents: string; companies: string }>(
        `SELECT coalesce(sum(l.amount_iqd), 0)::text AS iqd,
                coalesce(sum(l.amount_usd_cents), 0)::text AS usd_cents,
                count(DISTINCT l.company_id)::text AS companies
           FROM company_ledger l`,
      );
      tiles.push({
        key: 'we_owe_companies',
        count: Number(rows[0]?.companies ?? 0),
        cost: {
          amount_iqd: Number(rows[0]?.iqd ?? 0),
          amount_usd_cents: Number(rows[0]?.usd_cents ?? 0),
        },
      });
    }

    if (can(context, 'materials.view')) {
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
      tiles.push({ key: 'low_stock', count: Number(rows[0]?.count ?? 0) });
    }

    if (can(context, 'damages.view')) {
      const { rows } = await this.database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM damages
          WHERE status = 'active' AND deleted_at IS NULL AND return_status = 'pending'`,
      );
      tiles.push({ key: 'pending_returns', count: Number(rows[0]?.count ?? 0) });
    }

    // Everyone's own recent actions, which needs no permission: it is their own trail (1.5.2).
    const mine = await this.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log
        WHERE actor_user_id = $1
          AND occurred_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Baghdad')`,
      [context.userId, today],
    );
    tiles.push({ key: 'my_actions_today', count: Number(mine.rows[0]?.count ?? 0) });

    const current = await this.rates.current();
    const staleDays = await this.settings.get('rate_stale_days');
    return {
      date: today,
      tiles,
      rate: current
        ? {
            rate_iqd_per_usd: current.rate_iqd_per_usd,
            // Proposed — not requested (FR-1106): a forgotten rate skews every dollar figure.
            is_stale: daysSince(current.effective_from) > staleDays,
          }
        : null,
    };
  }
}

function daysSince(isoDate: string): number {
  return (Date.now() - Date.parse(isoDate)) / 86_400_000;
}

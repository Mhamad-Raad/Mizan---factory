import { Injectable } from '@nestjs/common';
import { Decimal, marginTotals } from '@mizan/money';
import type { Currency, MarginLine } from '@mizan/money';
import { can } from '../common/request-context.js';
import type { RequestContext } from '../common/request-context.js';
import { PeriodService } from '../settings/period.service.js';
import { ReportsRepository } from './reports.repository.js';
import type { DamageGroupBy, GroupBy, ReportFilters } from './reports.repository.js';

export interface ReportRequest {
  from?: string;
  to?: string;
  done_by?: string;
  assigned_to?: string;
  group_by?: GroupBy;
  company_id?: string;
  item_id?: string;
}

export interface ReportMeta {
  from: string;
  to: string;
  group_by: string;
  /** Which user filter the report was pinned to, so the screen can say so rather than lie. */
  pinned?: { filter: 'done_by' | 'assigned_to'; user_id: string };
}

/**
 * The reports (FR-1001 to FR-1013, spec 2.11).
 *
 * Two rules live here rather than in the SQL, because both are about *who is asking*:
 *
 *   · **the pinned filter.** Without `reports.view_all` a report is pinned to the caller —
 *     `done_by` for the ones about what somebody did, `assigned_to` for the ones about whose
 *     customers and suppliers they are (2.11). The pin is applied over the query and echoed in
 *     the response, so the screen can show "your figures" instead of pretending to be the
 *     factory's;
 *   · **the field flags.** A column the caller may not see is *omitted*, not zeroed: every
 *     amount that is a bought price travels under `cost`, and the interceptor removes the whole
 *     group (D-022).
 *
 * Everything else is a sum of stored values, per currency, over a range of business days.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly reports: ReportsRepository,
    private readonly period: PeriodService,
  ) {}

  // ───────────────────────────────── sales (FR-1003) ─────────────────────────────────

  async sales(context: RequestContext, request: ReportRequest) {
    const { filters, meta } = this.resolve(context, request, 'done_by');
    const [groups, collected] = await Promise.all([
      this.reports.sales(filters),
      this.reports.collected(filters),
    ]);

    return {
      ...meta,
      groups: groups.map((group) => ({
        key: group.key,
        label: group.label,
        count_orders: group.count_orders,
        qty_count: group.qty_count,
        qty_kg: group.qty_kg,
        total_iqd: Number(group.total_iqd),
        total_usd_cents: Number(group.total_usd_cents),
        cash_iqd: Number(group.cash_iqd),
        cash_usd_cents: Number(group.cash_usd_cents),
        borrowed_iqd: Number(group.borrowed_iqd),
        borrowed_usd_cents: Number(group.borrowed_usd_cents),
        discount_iqd: Number(group.discount_iqd),
        discount_usd_cents: Number(group.discount_usd_cents),
      })),
      totals: {
        count_orders: sum(groups.map((group) => group.count_orders)),
        total_iqd: sum(groups.map((group) => Number(group.total_iqd))),
        total_usd_cents: sum(groups.map((group) => Number(group.total_usd_cents))),
        cash_iqd: sum(groups.map((group) => Number(group.cash_iqd))),
        cash_usd_cents: sum(groups.map((group) => Number(group.cash_usd_cents))),
        borrowed_iqd: sum(groups.map((group) => Number(group.borrowed_iqd))),
        borrowed_usd_cents: sum(groups.map((group) => Number(group.borrowed_usd_cents))),
        collected_iqd: collected.iqd,
        collected_usd_cents: collected.usd_cents,
      },
    };
  }

  // ───────────────────────────────── purchases (FR-1004) ─────────────────────────────────

  async purchases(context: RequestContext, request: ReportRequest) {
    const { filters, meta } = this.resolve(context, request, 'done_by');
    const [groups, paid] = await Promise.all([
      this.reports.purchases(filters),
      this.reports.paidToCompanies(filters),
    ]);

    return {
      ...meta,
      groups: groups.map((group) => ({
        key: group.key,
        label: group.label,
        count_purchases: group.count_purchases,
        qty_count: group.qty_count,
        qty_kg: group.qty_kg,
        // The amounts of a purchase are bought prices (FR-1004): one flag hides them all.
        cost: {
          total_iqd: Number(group.total_iqd),
          total_usd_cents: Number(group.total_usd_cents),
        },
      })),
      totals: {
        count_purchases: sum(groups.map((group) => group.count_purchases)),
        cost: {
          total_iqd: sum(groups.map((group) => Number(group.total_iqd))),
          total_usd_cents: sum(groups.map((group) => Number(group.total_usd_cents))),
          paid_iqd: paid.iqd,
          paid_usd_cents: paid.usd_cents,
        },
      },
    };
  }

  // ───────────────────────────────── profit (FR-1005) ─────────────────────────────────

  /**
   * "Margin vs. month price". The margin of every line is computed by the kernel — once, in the
   * line's entered currency, from the cost snapshot stored on it — and the report sums those
   * figures per group. Lines with no cost snapshot are counted and named, never included.
   */
  async profit(context: RequestContext, request: ReportRequest) {
    const { filters, meta } = this.resolve(context, request, 'done_by');
    const lines = await this.reports.marginLines(filters);

    const byGroup = new Map<string, { label: string | null; lines: MarginLine[]; revenue_iqd: number; revenue_usd_cents: number }>();
    for (const line of lines) {
      const group = byGroup.get(line.group_key) ?? {
        label: line.group_label,
        lines: [],
        revenue_iqd: 0,
        revenue_usd_cents: 0,
      };
      group.lines.push({
        priced_measure: line.priced_measure,
        qty_count: line.qty_count,
        qty_kg: line.qty_kg,
        unit_price_iqd: Number(line.unit_price_iqd),
        unit_price_usd_cents: Number(line.unit_price_usd_cents),
        price_entered_currency: line.price_entered_currency,
        rate_iqd_per_usd: line.rate_iqd_per_usd,
        cost_unit_iqd: line.cost_unit_iqd === null ? null : Number(line.cost_unit_iqd),
        cost_unit_usd_cents: line.cost_unit_usd_cents === null ? null : Number(line.cost_unit_usd_cents),
        cost_source: line.cost_source,
      });
      group.revenue_iqd += Number(line.line_total_iqd);
      group.revenue_usd_cents += Number(line.line_total_usd_cents);
      byGroup.set(line.group_key, group);
    }

    const groups = [...byGroup].map(([key, group]) => {
      const totals = marginTotals(group.lines);
      return {
        key,
        label: group.label,
        lines: totals.lines,
        cost: {
          revenue_iqd: group.revenue_iqd,
          revenue_usd_cents: group.revenue_usd_cents,
          margin_iqd: totals.margin_iqd,
          margin_usd_cents: totals.margin_usd_cents,
        },
        lines_without_cost: totals.lines_without_cost,
        /** Flagged per row, as 2.11 asks: the cost came from an earlier month. */
        price_fallback: totals.lines_with_fallback > 0,
        lines_with_fallback: totals.lines_with_fallback,
      };
    });

    return {
      ...meta,
      /** The report is a **list-price** margin and says so on the screen (FR-1005). */
      basis: 'month_price',
      groups: groups.sort((left, right) => (left.key < right.key ? 1 : -1)),
      totals: {
        lines: sum(groups.map((group) => group.lines)),
        lines_without_cost: sum(groups.map((group) => group.lines_without_cost)),
        lines_with_fallback: sum(groups.map((group) => group.lines_with_fallback)),
        cost: {
          revenue_iqd: sum(groups.map((group) => group.cost.revenue_iqd)),
          revenue_usd_cents: sum(groups.map((group) => group.cost.revenue_usd_cents)),
          margin_iqd: sum(groups.map((group) => group.cost.margin_iqd)),
          margin_usd_cents: sum(groups.map((group) => group.cost.margin_usd_cents)),
        },
      },
    };
  }

  // ───────────────────────────────── stock (FR-1006) ─────────────────────────────────

  async stock(context: RequestContext, request: ReportRequest) {
    // The stock report has no user filter at all (2.11), so nothing is pinned.
    const filters = this.range(request);
    const rows = await this.reports.stock(filters);
    const month = `${filters.to.slice(0, 7)}-01`;

    const groups = rows.map((row) => {
      const pricedMeasure = row.pricing_unit === 'per_piece' ? 'count' : 'kg';
      const quantity = pricedMeasure === 'count' ? Number(row.stock_count) : Number(row.stock_kg);
      const boughtIqd = row.bought_iqd === null ? null : Number(row.bought_iqd);
      const boughtUsd = row.bought_usd_cents === null ? null : Number(row.bought_usd_cents);

      return {
        key: row.key,
        label: row.label,
        priced_measure: pricedMeasure as 'count' | 'kg',
        stock_count: Number(row.stock_count),
        stock_kg: row.stock_kg,
        count_complete: row.count_complete,
        kg_complete: row.kg_complete,
        first_bought_on: row.first_bought_on,
        last_sold_on: row.last_sold_on,
        moved_in_count: Number(row.in_count),
        moved_in_kg: row.in_kg,
        moved_out_count: Number(row.out_count),
        moved_out_kg: row.out_kg,
        /** The month price the value was taken at, flagged when it is not this month's. */
        price_month: row.price_month,
        price_fallback: Boolean(row.price_month && row.price_month !== month),
        cost: {
          // Stock × the bought price of the period's month, both currencies from the stored
          // pair — never one converted from the other (2.11).
          value_iqd: boughtIqd === null ? null : Math.round(new Decimal(boughtIqd).times(quantity).toNumber()),
          value_usd_cents: boughtUsd === null ? null : Math.round(new Decimal(boughtUsd).times(quantity).toNumber()),
          bought_iqd: boughtIqd,
          bought_usd_cents: boughtUsd,
        },
      };
    });

    return {
      from: filters.from,
      to: filters.to,
      group_by: 'item',
      groups,
      totals: {
        materials: groups.length,
        cost: {
          value_iqd: sum(groups.map((group) => group.cost.value_iqd ?? 0)),
          value_usd_cents: sum(groups.map((group) => group.cost.value_usd_cents ?? 0)),
        },
        unvalued: groups.filter((group) => group.cost.value_iqd === null).length,
      },
    };
  }

  // ─────────────────────── receivables and payables (FR-1007, FR-1008) ───────────────────────

  async receivables(context: RequestContext, request: ReportRequest) {
    const { filters, meta } = this.resolve(context, request, 'assigned_to');
    const rows = await this.reports.receivables(filters);

    const groups = rows.map((row) => ({
      key: row.key,
      label: row.label,
      settlement_currency: row.settlement_currency,
      assigned_user_name: row.assigned_user_name,
      unpaid_orders: Number(row.unpaid_orders),
      balance: {
        amount: Number(row.balance),
        amount_iqd: Number(row.balance_iqd),
        amount_usd_cents: Number(row.balance_usd_cents),
        currency: row.settlement_currency,
        received_iqd: Number(row.received_iqd),
        received_usd_cents: Number(row.received_usd_cents),
      },
    }));

    return {
      ...meta,
      group_by: 'customer',
      groups,
      totals: {
        customers: groups.length,
        balance: {
          amount_iqd: sum(groups.map((group) => group.balance.amount_iqd)),
          amount_usd_cents: sum(groups.map((group) => group.balance.amount_usd_cents)),
          received_iqd: sum(groups.map((group) => group.balance.received_iqd)),
          received_usd_cents: sum(groups.map((group) => group.balance.received_usd_cents)),
        },
      },
    };
  }

  async payables(context: RequestContext, request: ReportRequest) {
    const { filters, meta } = this.resolve(context, request, 'assigned_to');
    const rows = await this.reports.payables(filters);

    const groups = rows.map((row) => ({
      key: row.key,
      label: row.label,
      settlement_currency: row.settlement_currency,
      balance: {
        amount: Number(row.balance),
        amount_iqd: Number(row.balance_iqd),
        amount_usd_cents: Number(row.balance_usd_cents),
        currency: row.settlement_currency,
        purchased_iqd: Number(row.purchased_iqd),
        purchased_usd_cents: Number(row.purchased_usd_cents),
        paid_iqd: Number(row.paid_iqd),
        paid_usd_cents: Number(row.paid_usd_cents),
        credits_iqd: Number(row.credits_iqd),
        credits_usd_cents: Number(row.credits_usd_cents),
        adjustments_iqd: Number(row.adjustments_iqd),
        adjustments_usd_cents: Number(row.adjustments_usd_cents),
      },
    }));

    return {
      ...meta,
      group_by: 'company',
      groups,
      totals: {
        companies: groups.length,
        balance: {
          amount_iqd: sum(groups.map((group) => group.balance.amount_iqd)),
          amount_usd_cents: sum(groups.map((group) => group.balance.amount_usd_cents)),
          purchased_iqd: sum(groups.map((group) => group.balance.purchased_iqd)),
          purchased_usd_cents: sum(groups.map((group) => group.balance.purchased_usd_cents)),
          paid_iqd: sum(groups.map((group) => group.balance.paid_iqd)),
          paid_usd_cents: sum(groups.map((group) => group.balance.paid_usd_cents)),
        },
      },
    };
  }

  // ───────────────────────────────── damage (FR-1009) ─────────────────────────────────

  async damage(context: RequestContext, request: Omit<ReportRequest, 'group_by'> & { group_by?: DamageGroupBy }) {
    const { filters, meta } = this.resolve(context, { ...request, group_by: undefined }, 'done_by');
    const rows = await this.reports.damage({ ...filters, group_by: request.group_by ?? 'month' });

    const groups = rows.map((row) => ({
      key: row.key,
      label: row.label,
      records: Number(row.records),
      qty_count: Number(row.qty_count),
      qty_kg: Number(row.qty_kg).toFixed(3),
      unvalued: Number(row.unvalued),
      cost: {
        est_value_iqd: Number(row.est_value_iqd),
        est_value_usd_cents: Number(row.est_value_usd_cents),
        credited_iqd: Number(row.credited_iqd),
        credited_usd_cents: Number(row.credited_usd_cents),
      },
    }));

    return {
      ...meta,
      group_by: request.group_by ?? 'month',
      groups,
      totals: {
        records: sum(groups.map((group) => group.records)),
        qty_count: sum(groups.map((group) => group.qty_count)),
        qty_kg: groups.reduce((total, group) => total.plus(group.qty_kg), new Decimal(0)).toFixed(3),
        unvalued: sum(groups.map((group) => group.unvalued)),
        cost: {
          est_value_iqd: sum(groups.map((group) => group.cost.est_value_iqd)),
          est_value_usd_cents: sum(groups.map((group) => group.cost.est_value_usd_cents)),
          credited_iqd: sum(groups.map((group) => group.cost.credited_iqd)),
          credited_usd_cents: sum(groups.map((group) => group.cost.credited_usd_cents)),
        },
      },
    };
  }

  // ──────────────────────── employee activity and the cash-up ────────────────────────

  async employeeActivity(context: RequestContext, request: ReportRequest) {
    const { filters, meta } = this.resolve(context, request, 'done_by');
    const rows = await this.reports.employeeActivity(filters);

    return {
      ...meta,
      group_by: 'employee',
      groups: rows.map((row) => ({
        key: row.key,
        label: row.label,
        orders: Number(row.orders),
        orders_iqd: Number(row.orders_iqd),
        orders_usd_cents: Number(row.orders_usd_cents),
        purchases: Number(row.purchases),
        payments_in: Number(row.payments_in),
        payments_in_iqd: Number(row.payments_in_iqd),
        payments_out: Number(row.payments_out),
        payments_out_iqd: Number(row.payments_out_iqd),
        damages: Number(row.damages),
        adjustments: Number(row.adjustments),
        voids: Number(row.voids),
        sign_ins: Number(row.sign_ins),
        cost: {
          purchases_iqd: Number(row.purchases_iqd),
          purchases_usd_cents: Number(row.purchases_usd_cents),
        },
      })),
    };
  }

  /** The daily cash-up (FR-1013, Proposed — not requested). */
  async cashUp(context: RequestContext, request: ReportRequest) {
    const { filters, meta } = this.resolve(context, request, 'done_by');
    const rows = await this.reports.cashUp(filters);

    const groups = rows.map((row) => ({
      key: row.key,
      label: row.label,
      received_iqd: Number(row.received_iqd),
      received_usd_cents: Number(row.received_usd_cents),
      paid_out_iqd: Number(row.paid_out_iqd),
      paid_out_usd_cents: Number(row.paid_out_usd_cents),
      // Net per **physical** currency: what should be in the drawer, in the notes it is in.
      net_iqd: Number(row.received_iqd) - Number(row.paid_out_iqd),
      net_usd_cents: Number(row.received_usd_cents) - Number(row.paid_out_usd_cents),
    }));

    return {
      ...meta,
      group_by: 'employee',
      groups,
      totals: {
        received_iqd: sum(groups.map((group) => group.received_iqd)),
        received_usd_cents: sum(groups.map((group) => group.received_usd_cents)),
        paid_out_iqd: sum(groups.map((group) => group.paid_out_iqd)),
        paid_out_usd_cents: sum(groups.map((group) => group.paid_out_usd_cents)),
        net_iqd: sum(groups.map((group) => group.net_iqd)),
        net_usd_cents: sum(groups.map((group) => group.net_usd_cents)),
      },
    };
  }

  // ───────────────────────────── the pieces they share ─────────────────────────────

  /** The range, defaulting to this month — the period a price-based report belongs to. */
  private range(request: ReportRequest): ReportFilters {
    const today = this.period.today();
    return {
      from: request.from ?? `${today.slice(0, 7)}-01`,
      to: request.to ?? today,
      group_by: request.group_by,
      company_id: request.company_id,
      item_id: request.item_id,
    };
  }

  /**
   * The range plus the user filter, pinned to the caller when they may not see everyone's
   * figures (2.11, FR-1002). The pin is echoed so the screen can label the report honestly.
   */
  private resolve(
    context: RequestContext,
    request: ReportRequest,
    pin: 'done_by' | 'assigned_to',
  ): { filters: ReportFilters; meta: ReportMeta } {
    const filters = this.range(request);
    const maySeeEveryone = can(context, 'reports.view_all');

    if (maySeeEveryone) {
      const resolved = { ...filters, done_by: request.done_by, assigned_to: request.assigned_to };
      return {
        filters: resolved,
        meta: { from: filters.from, to: filters.to, group_by: request.group_by ?? 'month' },
      };
    }

    const resolved = { ...filters, [pin]: context.userId } as ReportFilters;
    return {
      filters: resolved,
      meta: {
        from: filters.from,
        to: filters.to,
        group_by: request.group_by ?? 'month',
        pinned: { filter: pin, user_id: context.userId },
      },
    };
  }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

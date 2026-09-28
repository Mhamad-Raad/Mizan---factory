import { Injectable } from '@nestjs/common';
import { Decimal, roundHalfAwayFromZero } from '@mizan/money';
import { can } from '../common/request-context.js';
import type { RequestContext } from '../common/request-context.js';
import { PeriodService } from '../settings/period.service.js';
import { ReportsRepository } from './reports.repository.js';
import type { DamageGroupBy, GroupBy, ReportFilters } from './reports.repository.js';
import { pageOfArray, pagingOf } from '../common/paging.js';
import type { Paging } from '../common/paging.js';

export interface ReportRequest {
  from?: string;
  to?: string;
  done_by?: string;
  group_by?: GroupBy;
  company_id?: string;
  item_id?: string;
  /** Which page of groups to send (D-058); the totals are always the whole period's. */
  page?: number;
  page_size?: number;
  /**
   * The file export's one-pass mode (D-075): every group up to `EXPORT_GROUPS` in one answer,
   * with the same permission, the same pin and the same field stripping. The export used to ask
   * page after page, and the server recomputed the whole report for each one.
   */
  all?: 'true' | 'false';
}

/** The most groups one `all=true` answer carries; `has_more` says when a period had more. */
export const EXPORT_GROUPS = 10_000;

/** A request's page of groups — or, for an export, the first `EXPORT_GROUPS` of them. */
function reportPaging(request: { page?: number; page_size?: number; all?: 'true' | 'false' }): Paging {
  if (request.all === 'true') return { page: 1, page_size: EXPORT_GROUPS, offset: 0 };
  return pagingOf(request);
}

export interface ReportMeta {
  from: string;
  to: string;
  group_by: string;
  /** Which user filter the report was pinned to, so the screen can say so rather than lie. */
  pinned?: { filter: 'done_by'; user_id: string };
}

/**
 * The reports (FR-1001 to FR-1013, spec 2.11).
 *
 * Two rules live here rather than in the SQL, because both are about *who is asking*:
 *
 *   · **the pinned filter.** Without `reports.view_all` a report about what somebody did is
 *     pinned to the caller (`done_by`, 2.11). The pin is applied over the query and echoed in
 *     the response, so the screen can show "your figures" instead of pretending to be the
 *     factory's. Accounts are not assigned (D-056), so Receivables is not pinned to anybody;
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
      ...paged(request, 
        groups.map((group) => ({
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
      ),
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
      ...paged(request, 
        groups.map((group) => ({
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
      ),
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
   * "Margin vs. month price" (FR-1005, 2.11).
   *
   * The margin of a line is computed **once, by the kernel, when the line is saved** — in the
   * line's entered currency, from the cost snapshot stored on it, converted at that line's own
   * rate — and stored beside that snapshot (D-039). This report sums those stored integers,
   * which is what 2.11 says every report does.
   *
   * Until I6 it folded the lines through the kernel on every request instead. That kept the
   * rule in one place, which was right, and cost **436 seconds** for a year at the design point
   * of NFR-13, which was not. The rule is still in one place; it simply runs at save time.
   * Lines with no cost snapshot have no margin: they are counted and named, never summed.
   */
  async profit(context: RequestContext, request: ReportRequest) {
    const { filters, meta } = this.resolve(context, request, 'done_by');
    const [rows, adjustments] = await Promise.all([
      this.reports.margins(filters),
      this.reports.orderAdjustments(filters),
    ]);

    const byGroup = new Map<
      string,
      {
        label: string | null;
        revenue_iqd: number;
        revenue_usd_cents: number;
        margin_iqd: number;
        margin_usd_cents: number;
        lines: number;
        lines_without_cost: number;
        lines_with_fallback: number;
      }
    >();

    for (const row of rows) {
      byGroup.set(row.group_key, {
        label: row.group_label,
        revenue_iqd: Number(row.revenue_iqd),
        revenue_usd_cents: Number(row.revenue_usd_cents),
        margin_iqd: Number(row.margin_iqd),
        margin_usd_cents: Number(row.margin_usd_cents),
        lines: row.lines,
        lines_without_cost: row.lines_without_cost,
        lines_with_fallback: row.lines_with_fallback,
      });
    }

    // The round-up less the order discount is money the order took or gave up with no line
    // behind it: it moves what was sold and the margin alike, as on the Accounts page (D-077).
    // A group the order decides takes its own share; a figure no group can hold (grouped by
    // material) stays out of the rows and is carried into the totals below.
    const unassigned = { iqd: 0, usd_cents: 0 };
    for (const adjustment of adjustments) {
      const iqd = Number(adjustment.adjustment_iqd);
      const usdCents = Number(adjustment.adjustment_usd_cents);
      // Keys match the margins' own, a null one included (an order with no acting employee).
      const group = byGroup.get(adjustment.group_key as string);
      if (group) {
        group.revenue_iqd += iqd;
        group.revenue_usd_cents += usdCents;
        group.margin_iqd += iqd;
        group.margin_usd_cents += usdCents;
      } else {
        unassigned.iqd += iqd;
        unassigned.usd_cents += usdCents;
      }
    }

    const groups = [...byGroup].map(([key, group]) => ({
      key,
      label: group.label,
      lines: group.lines,
      cost: {
        revenue_iqd: group.revenue_iqd,
        revenue_usd_cents: group.revenue_usd_cents,
        margin_iqd: group.margin_iqd,
        margin_usd_cents: group.margin_usd_cents,
      },
      lines_without_cost: group.lines_without_cost,
      /** Flagged per row, as 2.11 asks: the cost came from an earlier month. */
      price_fallback: group.lines_with_fallback > 0,
      lines_with_fallback: group.lines_with_fallback,
    }));

    return {
      ...meta,
      /** The margin is against what the stock sold actually cost, from its buys (D-062). */
      basis: 'bought',
      ...paged(request, sortGroups(groups, filters.group_by ?? 'month', (group) => group.cost.margin_iqd)),
      totals: {
        lines: sum(groups.map((group) => group.lines)),
        lines_without_cost: sum(groups.map((group) => group.lines_without_cost)),
        lines_with_fallback: sum(groups.map((group) => group.lines_with_fallback)),
        cost: {
          revenue_iqd: sum(groups.map((group) => group.cost.revenue_iqd)) + unassigned.iqd,
          revenue_usd_cents: sum(groups.map((group) => group.cost.revenue_usd_cents)) + unassigned.usd_cents,
          margin_iqd: sum(groups.map((group) => group.cost.margin_iqd)) + unassigned.iqd,
          margin_usd_cents: sum(groups.map((group) => group.cost.margin_usd_cents)) + unassigned.usd_cents,
          /** Rounding less order discounts that no row holds (grouped by material); 0 otherwise. */
          order_adjustment_iqd: unassigned.iqd,
          order_adjustment_usd_cents: unassigned.usd_cents,
        },
      },
    };
  }

  // ───────────────────────────────── stock (FR-1006) ─────────────────────────────────

  async stock(context: RequestContext, request: ReportRequest) {
    // The stock report has no user filter at all (2.11), so nothing is pinned.
    const filters = this.range(request);
    // Every material is valued, so the totals are the whole stock's; only a page is sent.
    const rows = await this.reports.stock(filters, null);
    const month = `${filters.to.slice(0, 7)}-01`;

    const groups = rows.map((row) => {
      const pricedMeasure = row.pricing_unit === 'per_piece' ? 'count' : 'kg';
      const quantity = pricedMeasure === 'count' ? Number(row.stock_count) : Number(row.stock_kg);
      const boughtIqd = row.bought_iqd === null ? null : Number(row.bought_iqd);
      const boughtUsd = row.bought_usd_cents === null ? null : Number(row.bought_usd_cents);
      // Stock the buys do not account for: all of it for a material never bought.
      const unbought = row.lots_remaining === null ? new Decimal(quantity) : Decimal.max(new Decimal(quantity).minus(row.lots_remaining), 0);
      const usesMonthPrice = !unbought.isZero();

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
        price_fallback: usesMonthPrice && Boolean(row.price_month && row.price_month !== month),
        cost: {
          // What the stock on hand cost us: what is left of each buy, as its share of what the
          // buy cost (D-062); stock with no buy behind it — opening stock, a material never
          // bought — at the month's bought price. Both currencies from stored pairs, never one
          // converted from the other (2.11).
          value_iqd: stockValue(row.lots_value_iqd, boughtIqd, unbought),
          value_usd_cents: stockValue(row.lots_value_usd_cents, boughtUsd, unbought),
          bought_iqd: boughtIqd,
          bought_usd_cents: boughtUsd,
        },
      };
    });

    return {
      from: filters.from,
      to: filters.to,
      group_by: 'item',
      ...paged(request, groups),
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

  /**
   * Receivables (FR-1007). The page and the totals come back from one query — the cap of D-032
   * is applied *in the database*, because grouping every customer's ledger only to throw away
   * all but two hundred rows is what cost 2.3 seconds at the design point (REVIEW-I6).
   */
  async receivables(context: RequestContext, request: ReportRequest) {
    // Not pinned: accounts are nobody's in particular any more (D-056).
    const { filters, meta } = this.resolve(context, request, null);
    const paging = reportPaging(request);
    const rows = await this.reports.receivables(filters, paging);

    const groups = rows.map((row) => ({
      key: row.key,
      label: row.label,
      settlement_currency: row.settlement_currency,
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

    // The totals are the period's, over every customer — the window functions computed them
    // before the page was taken, so every page carries the period's totals (D-058). A page past
    // the end has no row to carry them; the first row is read for them instead, so it never
    // answers "nobody owes anything" (review).
    const first = rows[0] ?? (paging.offset > 0 ? (await this.reports.receivables(filters, firstRowOnly))[0] : undefined);
    return {
      ...meta,
      group_by: 'customer',
      groups,
      group_count: Number(first?.group_count ?? 0),
      has_more: Number(first?.group_count ?? 0) > paging.offset + groups.length,
      page: paging.page,
      page_size: paging.page_size,
      totals: {
        customers: Number(first?.group_count ?? 0),
        balance: {
          amount_iqd: Number(first?.total_balance_iqd ?? 0),
          amount_usd_cents: Number(first?.total_balance_usd_cents ?? 0),
          received_iqd: Number(first?.total_received_iqd ?? 0),
          received_usd_cents: Number(first?.total_received_usd_cents ?? 0),
        },
      },
    };
  }

  async payables(context: RequestContext, request: ReportRequest) {
    const { filters, meta } = this.resolve(context, request, null);
    const paging = reportPaging(request);
    const rows = await this.reports.payables(filters, paging);

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

    // The totals are over every company, computed before the page was taken (D-058, D-075); past
    // the last page they are read from the first row, as for Receivables (review).
    const first = rows[0] ?? (paging.offset > 0 ? (await this.reports.payables(filters, firstRowOnly))[0] : undefined);
    const groupCount = Number(first?.group_count ?? 0);
    return {
      ...meta,
      group_by: 'company',
      groups,
      group_count: groupCount,
      has_more: groupCount > paging.offset + groups.length,
      page: paging.page,
      page_size: paging.page_size,
      totals: {
        companies: groupCount,
        balance: {
          amount_iqd: Number(first?.total_balance_iqd ?? 0),
          amount_usd_cents: Number(first?.total_balance_usd_cents ?? 0),
          purchased_iqd: Number(first?.total_purchased_iqd ?? 0),
          purchased_usd_cents: Number(first?.total_purchased_usd_cents ?? 0),
          paid_iqd: Number(first?.total_paid_iqd ?? 0),
          paid_usd_cents: Number(first?.total_paid_usd_cents ?? 0),
        },
      },
    };
  }

  // ───────────────────────────────── damage (FR-1009) ─────────────────────────────────

  async damage(
    context: RequestContext,
    request: Omit<ReportRequest, 'group_by'> & { group_by?: DamageGroupBy },
  ) {
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
      ...paged(request, groups),
      totals: {
        records: sum(groups.map((group) => group.records)),
        qty_count: sum(groups.map((group) => group.qty_count)),
        qty_kg: groups
          .reduce((total, group) => total.plus(group.qty_kg), new Decimal(0))
          .toFixed(3),
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
      ...paged(request, 
        rows.map((row) => ({
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
      ),
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
      ...paged(request, groups),
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
  /**
   * The range, the grouping and — for the reports that have a user dimension — the pin of 2.11.
   *
   * `pin: null` is not an oversight: **Payables has no pin**. Companies are deliberately
   * unscoped (FR-711) and their `assigned_user_id` is optional and usually empty, so pinning
   * that report to "assigned to me" answered *we owe nothing* to the very accountant whose job
   * it is — an empty state that reads as a fact rather than as a filter (D-031). Section 2.11's
   * own table lists no pinned filter for Payables; the sentence under it does, and this is the
   * reading that agrees with FR-711.
   */
  private resolve(
    context: RequestContext,
    request: ReportRequest,
    pin: 'done_by' | null,
  ): { filters: ReportFilters; meta: ReportMeta } {
    const filters = this.range(request);
    const maySeeEveryone = can(context, 'reports.view_all');

    if (maySeeEveryone || pin === null) {
      // Without `reports.view_all` there is nobody else's figures to ask for, so an unpinned
      // report ignores the user filters rather than letting them in by the back door.
      const resolved = maySeeEveryone
        ? { ...filters, done_by: request.done_by }
        : filters;
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

/**
 * One page of groups, with the truth about how many there were (D-058; it replaces D-032's cap
 * of 200). At the volumes of NFR-13 "sales by customer for the year" is ten thousand rows, which
 * a phone on NFR-03's connection cannot take in one answer; a page of them it can.
 *
 * The totals are **not** computed from this page: every report sums all of its groups first and
 * pages afterwards, so any page's totals are the period's (asserted). The order the rows arrive
 * in decides what the first page shows, which is why a report grouped by a dimension is ordered
 * by its own money, largest first, rather than alphabetically.
 */
/**
 * A date grouping reads newest first, because that is the order a period is read in; a
 * dimension — material, customer, employee — reads largest first, because that is what the
 * question "where did the margin come from?" means, and because it is what makes a cap keep
 * the rows worth keeping.
 */
function sortGroups<T extends { key: string }>(
  groups: readonly T[],
  groupBy: string,
  measure: (group: T) => number,
): T[] {
  if (groupBy === 'month' || groupBy === 'day') {
    return [...groups].sort((left, right) => (left.key < right.key ? 1 : -1));
  }
  return [...groups].sort((left, right) => measure(right) - measure(left));
}

function paged<T>(
  request: { page?: number; page_size?: number; all?: 'true' | 'false' },
  groups: readonly T[],
): { groups: T[]; group_count: number; has_more: boolean; page: number; page_size: number } {
  const paging = reportPaging(request);
  const page = pageOfArray(groups, paging);
  return {
    groups: page,
    group_count: groups.length,
    has_more: paging.offset + page.length < groups.length,
    page: paging.page,
    page_size: paging.page_size,
  };
}

/** The value of a material's stock in one currency: its buys, plus any stock no buy explains. */
function stockValue(fromLots: string | null, monthPrice: number | null, unbought: Decimal): number | null {
  if (unbought.isZero()) return fromLots === null ? 0 : Number(fromLots);
  if (monthPrice === null) return fromLots === null ? null : Number(fromLots);
  return (fromLots === null ? 0 : Number(fromLots)) + roundHalfAwayFromZero(new Decimal(monthPrice).times(unbought));
}

/** The first row alone: enough to read the totals every row of these reports carries. */
const firstRowOnly = { page: 1, page_size: 1, offset: 0 };

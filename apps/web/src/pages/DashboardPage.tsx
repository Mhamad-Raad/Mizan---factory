import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Button, Card } from '@mizan/ui';
import type { IconName } from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { apiRequest } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { DualAmount } from '../components/DualAmount.js';
import { KpiHead } from '../components/KpiHead.js';
import { OrderTable } from '../components/OrderTable.js';
import { QueryStates } from '../components/states.js';
import { ColumnChart } from '../components/charts/ColumnChart.js';
import type { ChartSeries } from '../components/charts/ColumnChart.js';
import { BarList } from '../components/charts/BarList.js';
import { useFormatter, usePermission } from '../lib/store.js';
import type { OrderRow } from './OrdersPage.js';

type Pair = { amount_iqd: number; amount_usd_cents: number };

interface Tile {
  key: string;
  count?: number;
  amount_iqd?: number;
  amount_usd_cents?: number;
  cost?: Pair | null;
  balance?: (Pair & { count?: number }) | null;
  owed?: Pair | null;
}

interface Day {
  date: string;
  sales: Pair & { count: number };
  /** Absent for a caller without bought prices (D-022). */
  cost?: (Pair & { count: number }) | null;
}

interface Debtor {
  id: string;
  name: string;
  settlement_currency: Currency;
  balance?: (Pair & { amount: number; net: boolean }) | null;
}

interface Dashboard {
  date: string;
  tiles: Tile[];
  rate: { rate_iqd_per_usd: string } | null;
  days: Day[] | null;
  debtors: Debtor[] | null;
}

/** Where each tile leads, so a number is never a dead end (spec 3.3). */
const LINKS: Record<string, string> = {
  sales_today: '/orders',
  unpaid_orders: '/orders',
  purchases_today: '/accounts',
  we_owe_companies: '/customers',
  low_stock: '/materials',
  pending_returns: '/damages',
  my_actions_today: '/history',
};

const ICONS: Record<string, IconName> = {
  sales_today: 'orders',
  unpaid_orders: 'clock',
  purchases_today: 'purchases',
  we_owe_companies: 'companies',
  low_stock: 'materials',
  pending_returns: 'warning',
  my_actions_today: 'history',
};

const SALES: ChartSeries = { key: 'sales', label: '', color: 'var(--color-chart-sales)' };
const PURCHASES: ChartSeries = { key: 'purchases', label: '', color: 'var(--color-chart-purchases)' };

/**
 * Today (FR-1309, client review): the day at a glance, then the two weeks behind it.
 *
 * The headline numbers first, as stat tiles that each open the list they count; then sales and
 * purchases over the last fourteen days — one axis, in dinars, a legend for the two series, a
 * tooltip with both currencies, and the same figures as a table for whoever would rather read
 * them; then who owes us most; then the most recent orders, exactly as the Orders page lists
 * them. Everything the caller may not see never arrives from the API, so nothing is hidden here.
 */
export function DashboardPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const maySeeOrders = usePermission('orders.view');
  const [asTable, setAsTable] = useState(false);

  const dashboard = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => apiRequest<Dashboard>('/dashboard'),
  });

  const recent = useQuery({
    queryKey: ['orders', 'recent'],
    queryFn: () => apiRequest<{ items: OrderRow[] }>('/orders?page_size=8'),
    enabled: maySeeOrders,
  });

  const data = dashboard.data;
  const tiles = data?.tiles ?? [];
  const days = data?.days ?? null;
  const withPurchases = Boolean(days?.some((day) => day.cost));
  const series = withPurchases
    ? [
        { ...SALES, label: t('dashboard:series_sales') },
        { ...PURCHASES, label: t('dashboard:series_purchases') },
      ]
    : [{ ...SALES, label: t('dashboard:series_sales') }];
  const quiet = (days ?? []).every((day) => day.sales.amount_iqd === 0 && (day.cost?.amount_iqd ?? 0) === 0);
  const debtors = (data?.debtors ?? []).filter((row) => row.balance);

  const shortDate = (iso: string) => {
    const [, month, day] = iso.split('-');
    return `${formatter.number(Number(day))}/${formatter.number(Number(month))}`;
  };

  usePageTitle(t('dashboard:title'));

  return (
    <div className="mz-stack mz-dashboard">
      <QueryStates query={dashboard} isEmpty={tiles.length === 0} emptyTitle={t('dashboard:empty')}>
        <div className="mz-kpis">
          {tiles.map((tile) => {
            const money = tile.amount_iqd !== undefined ? (tile as Pair) : (tile.cost ?? tile.owed ?? tile.balance);
            // "Unpaid orders" carries its count inside `balance`, so the balances flag hides both.
            const count = tile.count ?? tile.balance?.count;
            // A tile whose every figure was withheld says nothing, so it is not shown.
            if (count === undefined && !money) return null;
            return (
              <Link key={tile.key} to={LINKS[tile.key] ?? '/'} className="mz-kpi">
                <KpiHead icon={ICONS[tile.key] ?? 'clock'} label={t(`dashboard:tile.${tile.key}`)} />
                {count !== undefined ? (
                  <span className="mz-kpi__count" data-tabular>
                    {formatter.number(count)}
                  </span>
                ) : null}
                {/* A balance or a total is a pair: dinars and dollars, never a sum of the two. */}
                {money ? (
                  <DualAmount amount_iqd={money.amount_iqd} amount_usd_cents={money.amount_usd_cents} />
                ) : null}
              </Link>
            );
          })}
        </div>

        <div className="mz-dashboard__grid">
          {days ? (
            <Card className="mz-dashboard__trend">
              <div className="mz-chart-head">
                <div>
                  <h2 className="mz-heading">
                    {withPurchases ? t('dashboard:trend_title') : t('dashboard:sales_title')}
                  </h2>
                  <p className="mz-caption">{t('dashboard:trend_subtitle')}</p>
                </div>
                <Button variant="ghost" onClick={() => setAsTable(!asTable)}>
                  {asTable ? t('dashboard:show_chart') : t('dashboard:show_table')}
                </Button>
              </div>

              {/* Two series always carry a legend: identity is never colour alone. */}
              {series.length > 1 ? (
                <ul className="mz-legend">
                  {series.map((one) => (
                    <li key={one.key}>
                      <span className="mz-legend__swatch" style={{ background: one.color }} aria-hidden="true" />
                      {one.label}
                    </li>
                  ))}
                </ul>
              ) : null}

              {quiet ? (
                <p className="mz-muted mz-chart-empty">{t('dashboard:no_activity')}</p>
              ) : asTable ? (
                <TrendTable days={days} withPurchases={withPurchases} />
              ) : (
                <ColumnChart
                  label={withPurchases ? t('dashboard:trend_title') : t('dashboard:sales_title')}
                  series={series}
                  points={days.map((day) => ({
                    label: shortDate(day.date),
                    values: { sales: day.sales.amount_iqd, purchases: day.cost?.amount_iqd ?? 0 },
                  }))}
                  tooltip={(index) => {
                    const day = days[index] as Day;
                    return (
                      <div className="mz-stack" style={{ gap: 'var(--space-1)' }}>
                        <strong data-tabular>{formatter.date(day.date)}</strong>
                        <TooltipRow
                          color={SALES.color}
                          label={t('dashboard:orders_count', { count: day.sales.count })}
                          pair={day.sales}
                        />
                        {day.cost ? (
                          <TooltipRow
                            color={PURCHASES.color}
                            label={t('dashboard:purchases_count', { count: day.cost.count })}
                            pair={day.cost}
                          />
                        ) : null}
                      </div>
                    );
                  }}
                />
              )}
            </Card>
          ) : null}

          {data?.debtors ? (
            <Card className="mz-dashboard__debtors">
              <div>
                <h2 className="mz-heading">{t('dashboard:debtors_title')}</h2>
                <p className="mz-caption">
                  {debtors[0]?.balance?.net === false ? t('dashboard:debtors_sales') : t('dashboard:debtors_net')}
                </p>
              </div>
              {debtors.length === 0 ? (
                <p className="mz-muted mz-chart-empty">{t('dashboard:no_debtors')}</p>
              ) : (
                <BarList
                  color="var(--color-primary)"
                  rows={debtors.map((row) => ({
                    key: row.id,
                    label: row.name,
                    href: `/customers/${row.id}`,
                    // Scaled in dinars: every account's bar in the same unit as the ranking.
                    value: row.balance?.amount_iqd ?? 0,
                    display: (
                      <DualAmount
                        amount_iqd={row.balance?.amount_iqd ?? 0}
                        amount_usd_cents={row.balance?.amount_usd_cents ?? 0}
                        primary={row.settlement_currency}
                        kind="derived"
                      />
                    ),
                  }))}
                />
              )}
            </Card>
          ) : null}
        </div>

        {maySeeOrders ? (
          <Card>
            <div className="mz-chart-head">
              <h2 className="mz-heading">{t('dashboard:recent_orders')}</h2>
              <Link to="/orders" className="mz-button mz-button--ghost">
                {t('dashboard:all_orders')}
              </Link>
            </div>
            <QueryStates query={recent} isEmpty={(recent.data?.items.length ?? 0) === 0} emptyTitle={t('orders:empty')} skeletonLines={4}>
              <OrderTable rows={recent.data?.items ?? []} />
            </QueryStates>
          </Card>
        ) : null}
      </QueryStates>
    </div>
  );
}

function TooltipRow({ color, label, pair }: { color: string; label: string; pair: Pair }) {
  return (
    <span className="mz-tooltip-row">
      <span className="mz-legend__swatch" style={{ background: color }} aria-hidden="true" />
      <span className="mz-caption">{label}</span>
      <DualAmount amount_iqd={pair.amount_iqd} amount_usd_cents={pair.amount_usd_cents} />
    </span>
  );
}

/** The chart's figures as a table — the view for whoever reads numbers rather than shapes. */
function TrendTable({ days, withPurchases }: { days: readonly Day[]; withPurchases: boolean }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  return (
    <div className="mz-table-wrap">
      <table className="mz-table">
        <thead>
          <tr>
            <th scope="col">{t('common:date')}</th>
            <th scope="col" data-numeric="true">
              {t('dashboard:series_sales')}
            </th>
            {withPurchases ? (
              <th scope="col" data-numeric="true">
                {t('dashboard:series_purchases')}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {[...days].reverse().map((day) => (
            <tr key={day.date}>
              <td data-tabular>{formatter.date(day.date)}</td>
              <td data-numeric="true">
                <DualAmount amount_iqd={day.sales.amount_iqd} amount_usd_cents={day.sales.amount_usd_cents} />
                <span className="mz-caption" style={{ display: 'block' }}>
                  {t('dashboard:orders_count', { count: day.sales.count })}
                </span>
              </td>
              {withPurchases ? (
                <td data-numeric="true">
                  {day.cost ? (
                    <>
                      <DualAmount amount_iqd={day.cost.amount_iqd} amount_usd_cents={day.cost.amount_usd_cents} />
                      <span className="mz-caption" style={{ display: 'block' }}>
                        {t('dashboard:purchases_count', { count: day.cost.count })}
                      </span>
                    </>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

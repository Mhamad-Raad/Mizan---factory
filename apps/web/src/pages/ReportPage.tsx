import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { BottomSheet, Button, Card, Chip, DateField } from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { apiRequest } from '../lib/api.js';
import { AppShell } from '../components/AppShell.js';
import { DualAmount } from '../components/DualAmount.js';
import { QueryStates } from '../components/states.js';
import { FilterChip } from './MaterialsPage.js';
import { useApp, useFormatter } from '../lib/store.js';

type ReportName =
  | 'sales'
  | 'purchases'
  | 'profit'
  | 'stock'
  | 'receivables'
  | 'payables'
  | 'damage'
  | 'employee-activity'
  | 'cash-up';

type DatePreset = 'month' | 'today' | 'week' | 'quarter' | 'custom';

interface ReportGroup {
  key: string;
  label: string | null;
  [field: string]: unknown;
}

interface ReportResponse {
  from: string;
  to: string;
  group_by: string;
  pinned?: { filter: 'done_by' | 'assigned_to'; user_id: string };
  basis?: string;
  groups: ReportGroup[];
  /** How many groups the period had, and whether the response was capped (I4 review, D-032). */
  group_count: number;
  has_more: boolean;
  totals?: Record<string, unknown>;
}

/** Which groupings each report offers (2.11), and which figures its rows and tiles show. */
const SHAPES: Record<
  ReportName,
  {
    titleKey: string;
    groupings: string[];
    /** Money pairs to render through `DualAmount`, as [label, iqd field, usd field]. */
    amounts: [string, string, string][];
    /** Plain numeric columns, as [label, field]. */
    counts: [string, string][];
    /** Quantities that carry three decimals. */
    quantities?: [string, string][];
    /** Reads money out of the row's `cost` group instead of the row itself. */
    costGroup?: boolean;
    balanceGroup?: boolean;
  }
> = {
  sales: {
    titleKey: 'reports:sales',
    groupings: ['month', 'day', 'customer', 'item', 'employee', 'assigned'],
    amounts: [
      ['reports:revenue', 'total_iqd', 'total_usd_cents'],
      ['reports:cash', 'cash_iqd', 'cash_usd_cents'],
      ['reports:borrowed', 'borrowed_iqd', 'borrowed_usd_cents'],
    ],
    counts: [['reports:count_orders', 'count_orders']],
    quantities: [['glossary:weight_kg', 'qty_kg']],
  },
  purchases: {
    titleKey: 'reports:purchases',
    groupings: ['month', 'day', 'company', 'item', 'employee'],
    amounts: [['glossary:total', 'total_iqd', 'total_usd_cents']],
    counts: [['reports:count_purchases', 'count_purchases']],
    quantities: [['glossary:weight_kg', 'qty_kg']],
    costGroup: true,
  },
  profit: {
    titleKey: 'reports:profit',
    groupings: ['month', 'day', 'customer', 'item', 'employee'],
    amounts: [
      ['reports:revenue', 'revenue_iqd', 'revenue_usd_cents'],
      ['reports:margin', 'margin_iqd', 'margin_usd_cents'],
    ],
    counts: [],
    costGroup: true,
  },
  stock: {
    titleKey: 'reports:stock',
    groupings: [],
    amounts: [['reports:value', 'value_iqd', 'value_usd_cents']],
    counts: [],
    quantities: [
      ['reports:stock_now', 'stock_kg'],
      ['reports:moved_in', 'moved_in_kg'],
      ['reports:moved_out', 'moved_out_kg'],
    ],
    costGroup: true,
  },
  receivables: {
    titleKey: 'reports:receivables',
    groupings: [],
    amounts: [
      ['reports:balance', 'amount_iqd', 'amount_usd_cents'],
      ['reports:received', 'received_iqd', 'received_usd_cents'],
    ],
    counts: [],
    balanceGroup: true,
  },
  payables: {
    titleKey: 'reports:payables',
    groupings: [],
    amounts: [
      ['reports:balance', 'amount_iqd', 'amount_usd_cents'],
      ['reports:purchased', 'purchased_iqd', 'purchased_usd_cents'],
      ['reports:paid', 'paid_iqd', 'paid_usd_cents'],
    ],
    counts: [],
    balanceGroup: true,
  },
  damage: {
    titleKey: 'reports:damage',
    groupings: ['month', 'day', 'item', 'attribution', 'return_status'],
    amounts: [
      ['reports:value', 'est_value_iqd', 'est_value_usd_cents'],
      ['reports:credited', 'credited_iqd', 'credited_usd_cents'],
    ],
    counts: [['reports:records', 'records']],
    quantities: [['glossary:weight_kg', 'qty_kg']],
    costGroup: true,
  },
  'employee-activity': {
    titleKey: 'reports:employee_activity',
    groupings: [],
    amounts: [['reports:orders_made', 'orders_iqd', 'orders_usd_cents']],
    counts: [
      ['reports:orders_made', 'orders'],
      ['reports:count_purchases', 'purchases'],
      ['reports:payments_in', 'payments_in'],
      ['reports:payments_out', 'payments_out'],
      ['reports:damages_recorded', 'damages'],
      ['reports:voids', 'voids'],
      ['reports:sign_ins', 'sign_ins'],
    ],
  },
  'cash-up': {
    titleKey: 'reports:cash_up',
    groupings: [],
    amounts: [
      ['reports:received', 'received_iqd', 'received_usd_cents'],
      ['reports:paid_out', 'paid_out_iqd', 'paid_out_usd_cents'],
      ['reports:net', 'net_iqd', 'net_usd_cents'],
    ],
    counts: [],
  },
};

function rangeFor(preset: DatePreset, today: string, custom: { from: string; to: string }) {
  if (preset === 'custom') return { from: custom.from || `${today.slice(0, 7)}-01`, to: custom.to || today };
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (preset === 'week' ? 6 : 89));
  return { from: date.toISOString().slice(0, 10), to: today };
}

/**
 * One report page for all nine (FR-1001, spec 3.3): filters, summary tiles, then a row per
 * group that expands into its figures.
 *
 * They share a page because they share a shape — a range, a grouping, sums in both currencies —
 * and nine files that differ only in their column lists would drift apart the first time a
 * label changed. What each report actually shows is the table above, which is the only place to
 * look when the specification's 2.11 changes.
 */
export function ReportPage({ name }: { name?: ReportName }) {
  const params = useParams();
  const reportName = (name ?? (params.name as ReportName)) satisfies ReportName;
  const { t } = useTranslation();
  const formatter = useFormatter();
  const user = useApp((state) => state.user);
  const permissions = useApp((state) => state.permissions);
  const canSeeEveryone = user?.role === 'admin' || permissions.has('reports.view_all');

  const shape = SHAPES[reportName];
  const [preset, setPreset] = useState<DatePreset>('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [groupBy, setGroupBy] = useState(shape.groupings[0] ?? '');
  const [doneBy, setDoneBy] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filters, setFilters] = useState(false);

  const range = rangeFor(preset, formatter.today(), custom);

  const directory = useQuery({
    queryKey: ['users', 'directory'],
    queryFn: () => apiRequest<{ id: string; display_name: string; is_active: boolean }[]>('/users/directory'),
    enabled: canSeeEveryone && filters,
  });

  const report = useQuery({
    queryKey: ['reports', reportName, range.from, range.to, groupBy, doneBy],
    queryFn: () => {
      const search = new URLSearchParams({ from: range.from, to: range.to });
      if (groupBy) search.set('group_by', groupBy);
      if (doneBy) search.set('done_by', doneBy);
      return apiRequest<ReportResponse>(`/reports/${reportName}?${search.toString()}`);
    },
  });

  const data = report.data;
  const totals = data?.totals ?? {};

  /** A figure lives either on the row or inside its `cost`/`balance` group (D-022). */
  const figures = (row: Record<string, unknown>): Record<string, unknown> => {
    if (shape.costGroup) return (row.cost as Record<string, unknown>) ?? {};
    if (shape.balanceGroup) return (row.balance as Record<string, unknown>) ?? {};
    return row;
  };

  const label = (group: ReportGroup): string => {
    if (group.label) return group.label;
    // A month or a day group carries its date as the key; everything else labels itself.
    if (/^\d{4}-\d{2}-01$/.test(group.key) && data?.group_by === 'month') return formatter.month(group.key.slice(0, 7));
    if (/^\d{4}-\d{2}-\d{2}$/.test(group.key)) return formatter.date(group.key);
    if (data?.group_by === 'attribution') return t(`damages:attribution.${group.key}`, { defaultValue: group.key });
    if (data?.group_by === 'return_status') return t(`damages:status.${group.key}`, { defaultValue: group.key });
    return group.key;
  };

  return (
    <AppShell title={t(shape.titleKey)}>
      <div className="mz-stack">
        <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {(['today', 'week', 'month', 'quarter'] as DatePreset[]).map((option) => (
            <FilterChip key={option} active={option === preset} onClick={() => setPreset(option)}>
              {option === 'today'
                ? t('common:today')
                : option === 'week'
                  ? t('common:this_week')
                  : option === 'month'
                    ? t('common:this_month')
                    : t('reports:last_quarter')}
            </FilterChip>
          ))}
          <FilterChip active={filters} onClick={() => setFilters(true)}>
            {t('orders:more_filters')}
          </FilterChip>
        </div>

        {shape.groupings.length > 0 ? (
          <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }} role="group" aria-label={t('reports:group_by')}>
            {shape.groupings.map((option) => (
              <FilterChip key={option} active={option === groupBy} onClick={() => setGroupBy(option)}>
                {t(`reports:group.${option}`)}
              </FilterChip>
            ))}
          </div>
        ) : null}

        {/* The report says when it is only the reader's own figures (FR-1002). */}
        {data?.pinned ? <Chip tone="warning">{t('reports:pinned_to_you')}</Chip> : null}
        {data?.basis === 'month_price' ? <p className="mz-caption">{t('reports:profit_basis')}</p> : null}
        {data ? (
          <p className="mz-caption">
            {formatter.date(data.from)} — {formatter.date(data.to)}
          </p>
        ) : null}

        <QueryStates query={report} isEmpty={(data?.groups.length ?? 0) === 0} emptyTitle={t('reports:empty')}>
          {/* The summary tiles: the totals of the whole filter, above the table (spec 3.3). */}
          <Card>
            <h3 className="mz-heading">{t('reports:total_row')}</h3>
            <div className="mz-stack" style={{ gap: 'var(--space-2)' }}>
              {shape.counts.map(([labelKey, field]) =>
                totals[field] === undefined ? null : (
                  <div key={field} className="mz-row mz-row--between">
                    <span className="mz-caption">{t(labelKey)}</span>
                    <span data-tabular>{formatter.number(Number(totals[field]))}</span>
                  </div>
                ),
              )}
              {(shape.quantities ?? []).map(([labelKey, field]) =>
                totals[field] === undefined ? null : (
                  <div key={field} className="mz-row mz-row--between">
                    <span className="mz-caption">{t(labelKey)}</span>
                    <span data-tabular>
                      {formatter.number(String(totals[field]), 3)} {t('common:kg_symbol')}
                    </span>
                  </div>
                ),
              )}
              {shape.amounts.map(([labelKey, iqdField, usdField]) => {
                const group = figures(totals);
                if (group[iqdField] === undefined) return null;
                return (
                  <div key={iqdField} className="mz-row mz-row--between">
                    <span className="mz-caption">{t(labelKey)}</span>
                    <DualAmount
                      amount_iqd={Number(group[iqdField] ?? 0)}
                      amount_usd_cents={Number(group[usdField] ?? 0)}
                    />
                  </div>
                );
              })}
              {reportName === 'sales' && totals.collected_iqd !== undefined ? (
                <div className="mz-row mz-row--between">
                  <span className="mz-caption">{t('reports:collected')}</span>
                  <DualAmount
                    amount_iqd={Number(totals.collected_iqd)}
                    amount_usd_cents={Number(totals.collected_usd_cents ?? 0)}
                  />
                </div>
              ) : null}
              {reportName === 'purchases' && (totals.cost as Record<string, unknown>)?.paid_iqd !== undefined ? (
                <div className="mz-row mz-row--between">
                  <span className="mz-caption">{t('reports:paid')}</span>
                  <DualAmount
                    amount_iqd={Number((totals.cost as Record<string, unknown>).paid_iqd)}
                    amount_usd_cents={Number((totals.cost as Record<string, unknown>).paid_usd_cents ?? 0)}
                  />
                </div>
              ) : null}
              {reportName === 'profit' && Number(totals.lines_without_cost ?? 0) > 0 ? (
                <p className="mz-caption">
                  {t('reports:no_cost_price', { count: Number(totals.lines_without_cost) })}
                </p>
              ) : null}
            </div>
          </Card>

          <ul className="mz-list">
            {(data?.groups ?? []).map((group) => {
              const values = figures(group as Record<string, unknown>);
              const primary = shape.amounts[0];
              return (
                <li key={group.key}>
                  <button
                    type="button"
                    className="mz-list__item mz-list__item--interactive"
                    style={{ inlineSize: '100%', background: 'none', border: 0, textAlign: 'start' }}
                    aria-expanded={expanded === group.key}
                    onClick={() => setExpanded(expanded === group.key ? null : group.key)}
                  >
                    <span className="mz-list__body">
                      <span className="mz-list__title" style={{ display: 'block' }}>
                        {label(group)}
                      </span>
                      {group.price_fallback ? <Chip tone="warning">{t('reports:fallback_flag')}</Chip> : null}
                      {primary && values[primary[1]] !== undefined ? (
                        <DualAmount
                          amount_iqd={Number(values[primary[1]] ?? 0)}
                          amount_usd_cents={Number(values[primary[2]] ?? 0)}
                          primary={(group.settlement_currency as Currency) ?? 'IQD'}
                        />
                      ) : null}
                    </span>
                  </button>

                  {expanded === group.key ? (
                    <Card>
                      <div className="mz-stack" style={{ gap: 'var(--space-2)' }}>
                        {shape.counts.map(([labelKey, field]) =>
                          group[field] === undefined ? null : (
                            <div key={field} className="mz-row mz-row--between">
                              <span className="mz-caption">{t(labelKey)}</span>
                              <span data-tabular>{formatter.number(Number(group[field]))}</span>
                            </div>
                          ),
                        )}
                        {(shape.quantities ?? []).map(([labelKey, field]) =>
                          group[field] === undefined || group[field] === null ? null : (
                            <div key={field} className="mz-row mz-row--between">
                              <span className="mz-caption">{t(labelKey)}</span>
                              <span data-tabular>
                                {formatter.number(String(group[field]), 3)} {t('common:kg_symbol')}
                              </span>
                            </div>
                          ),
                        )}
                        {shape.amounts.map(([labelKey, iqdField, usdField]) =>
                          values[iqdField] === undefined || values[iqdField] === null ? null : (
                            <div key={iqdField} className="mz-row mz-row--between">
                              <span className="mz-caption">{t(labelKey)}</span>
                              <DualAmount
                                amount_iqd={Number(values[iqdField] ?? 0)}
                                amount_usd_cents={Number(values[usdField] ?? 0)}
                                primary={(group.settlement_currency as Currency) ?? 'IQD'}
                              />
                            </div>
                          ),
                        )}
                        {reportName === 'receivables' && group.unpaid_orders !== undefined ? (
                          <span className="mz-caption">
                            {t('reports:unpaid_orders', { count: Number(group.unpaid_orders) })}
                          </span>
                        ) : null}
                        {reportName === 'employee-activity' ? (
                          <Link
                            to={`/history?done_by=${group.key}&from=${range.from}&to=${range.to}&preset=custom`}
                            className="mz-button mz-button--ghost"
                          >
                            {t('reports:in_history')}
                          </Link>
                        ) : null}
                      </div>
                    </Card>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {data?.has_more ? (
            // Said out loud: a report that quietly stops at two hundred rows lies about the period.
            <p className="mz-caption">
              {t('reports:capped', { shown: (data.groups ?? []).length, total: data.group_count })}
            </p>
          ) : null}
        </QueryStates>

        {filters ? (
          <BottomSheet
            title={t('orders:more_filters')}
            open
            onClose={() => setFilters(false)}
            closeLabel={t('common:close')}
          >
            <div className="mz-stack">
              <DateField
                label={t('common:date_from')}
                value={custom.from || range.from}
                max={formatter.today()}
                onChange={(event) => {
                  setCustom((current) => ({ ...current, from: event.target.value }));
                  setPreset('custom');
                }}
              />
              <DateField
                label={t('common:date_to')}
                value={custom.to || range.to}
                max={formatter.today()}
                onChange={(event) => {
                  setCustom((current) => ({ ...current, to: event.target.value }));
                  setPreset('custom');
                }}
              />
              {canSeeEveryone ? (
                <label className="mz-field">
                  <span className="mz-field__label">{t('common:done_by')}</span>
                  <select
                    className="mz-field__control"
                    value={doneBy}
                    onChange={(event) => setDoneBy(event.target.value)}
                  >
                    <option value="">{t('history:everyone')}</option>
                    {(directory.data ?? [])
                      .filter((entry) => entry.is_active)
                      .map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          <bdi>{entry.display_name}</bdi>
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}
              <Button block onClick={() => setFilters(false)}>
                {t('common:close')}
              </Button>
            </div>
          </BottomSheet>
        ) : null}
      </div>
    </AppShell>
  );
}

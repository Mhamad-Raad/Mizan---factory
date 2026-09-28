import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Button, Chip, DateField, Icon, Tabs } from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { apiRequest } from '../lib/api.js';
import { errorMessage } from '../lib/errors.js';
import { usePageTitle } from '../lib/page-title.js';
import { DualAmount } from '../components/DualAmount.js';
import { KpiHead } from '../components/KpiHead.js';
import { QueryStates } from '../components/states.js';
import { Pager } from '../components/Pager.js';
import { ColumnChart } from '../components/charts/ColumnChart.js';
import { useKeepPageInRange, usePaging } from '../lib/paging.js';
import { presetPeriod, thisMonth } from '../lib/periods.js';
import { useIsWide } from '../lib/wide.js';
import { downloadXlsx } from '../lib/xlsx.js';
import type { Cell, Sheet, SheetColumn } from '../lib/xlsx.js';
import { useApp, useFormatter, usePermission } from '../lib/store.js';

/**
 * Reports (FR-1001 to FR-1013; rebuilt at the client's request): one page, one period, a tab per
 * report — each with its totals as tiles, a chart when it is grouped by day or month, the table,
 * and "Download Excel". "Download everything" writes one workbook with a sheet per report the
 * reader may see, so the whole period leaves the system in one file.
 *
 * Every figure is a sum of stored integers in both currencies (the API's); the page only lays
 * them out. A report the caller's flags do not reach is not offered — the API would refuse it.
 */

type ReportKey =
  | 'sales'
  | 'profit'
  | 'purchases'
  | 'stock'
  | 'receivables'
  | 'damage'
  | 'expenses'
  | 'employee-activity'
  | 'cash-up';

type Preset = 'today' | 'week' | 'month' | 'last_month' | 'quarter' | 'year' | 'custom';

interface ReportGroup {
  key: string;
  label: string | null;
  [field: string]: unknown;
}

interface ReportResponse {
  from: string;
  to: string;
  group_by: string;
  pinned?: { filter: 'done_by'; user_id: string };
  groups: ReportGroup[];
  group_count: number;
  has_more: boolean;
  totals?: Record<string, unknown>;
}

interface Shape {
  titleKey: string;
  hintKey: string;
  /** Which permission flag the API asks for beyond `reports.view`. */
  flag?: string;
  groupings: string[];
  /** Money pairs as [label, iqd field, usd field]; the first is the headline and the chart. */
  amounts: [string, string, string][];
  counts: [string, string][];
  /** Quantities as [label, kg field, pieces field?]: a material sold by the piece reads in pieces. */
  quantities?: [string, string, string?][];
  /** Money lives inside the row's `cost` / `balance` group (D-022). */
  costGroup?: boolean;
  balanceGroup?: boolean;
  /** Extra money tiles read from the totals: [label, path to iqd, path to usd]. */
  extras?: [string, string, string][];
}

/** What each report offers (2.11): its groupings and the figures its tiles and columns show. */
const SHAPES: Record<Exclude<ReportKey, 'expenses'>, Shape> = {
  sales: {
    titleKey: 'reports:sales',
    hintKey: 'reports:sales_hint',
    groupings: ['month', 'day', 'customer', 'item', 'employee'],
    amounts: [
      ['reports:revenue', 'total_iqd', 'total_usd_cents'],
      ['reports:cash', 'cash_iqd', 'cash_usd_cents'],
      ['reports:borrowed', 'borrowed_iqd', 'borrowed_usd_cents'],
    ],
    counts: [['reports:count_orders', 'count_orders']],
    quantities: [['glossary:weight_kg', 'qty_kg']],
    extras: [['reports:collected', 'collected_iqd', 'collected_usd_cents']],
  },
  profit: {
    titleKey: 'reports:profit',
    hintKey: 'reports:profit_hint',
    flag: 'fields.see_profit',
    groupings: ['month', 'day', 'customer', 'item', 'employee'],
    amounts: [
      ['reports:margin', 'margin_iqd', 'margin_usd_cents'],
      ['reports:revenue', 'revenue_iqd', 'revenue_usd_cents'],
    ],
    counts: [],
    costGroup: true,
  },
  purchases: {
    titleKey: 'reports:purchases',
    hintKey: 'reports:purchases_hint',
    groupings: ['month', 'day', 'item', 'employee'],
    amounts: [['glossary:total', 'total_iqd', 'total_usd_cents']],
    counts: [['reports:count_purchases', 'count_purchases']],
    quantities: [['glossary:weight_kg', 'qty_kg']],
    costGroup: true,
  },
  stock: {
    titleKey: 'reports:stock',
    hintKey: 'reports:stock_hint',
    groupings: [],
    amounts: [['reports:value', 'value_iqd', 'value_usd_cents']],
    counts: [],
    quantities: [
      ['reports:stock_now', 'stock_kg', 'stock_count'],
      ['reports:moved_in', 'moved_in_kg', 'moved_in_count'],
      ['reports:moved_out', 'moved_out_kg', 'moved_out_count'],
    ],
    costGroup: true,
  },
  receivables: {
    titleKey: 'reports:receivables',
    hintKey: 'reports:receivables_hint',
    flag: 'fields.see_customer_balances',
    groupings: [],
    amounts: [
      ['reports:balance', 'amount_iqd', 'amount_usd_cents'],
      ['reports:received', 'received_iqd', 'received_usd_cents'],
    ],
    counts: [],
    balanceGroup: true,
  },
  damage: {
    titleKey: 'reports:damage',
    hintKey: 'reports:damage_hint',
    groupings: ['month', 'day', 'item', 'attribution'],
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
    hintKey: 'reports:employee_activity_hint',
    groupings: [],
    amounts: [['reports:orders_made', 'orders_iqd', 'orders_usd_cents']],
    counts: [
      ['reports:orders_made', 'orders'],
      ['reports:count_purchases', 'purchases'],
      ['reports:payments_in', 'payments_in'],
      ['reports:damages_recorded', 'damages'],
      ['reports:voids', 'voids'],
      ['reports:sign_ins', 'sign_ins'],
    ],
  },
  'cash-up': {
    titleKey: 'reports:cash_up',
    hintKey: 'reports:cash_up_hint',
    groupings: [],
    amounts: [
      ['reports:net', 'net_iqd', 'net_usd_cents'],
      ['reports:received', 'received_iqd', 'received_usd_cents'],
      ['reports:paid_out', 'paid_out_iqd', 'paid_out_usd_cents'],
    ],
    counts: [],
  },
};

const ORDER: ReportKey[] = [
  'sales',
  'profit',
  'purchases',
  'stock',
  'receivables',
  'damage',
  'expenses',
  'employee-activity',
  'cash-up',
];

/** The period of a preset, from today's Baghdad day. */
export function periodOf(preset: Preset, today: string, custom: { from: string; to: string }): { from: string; to: string } {
  if (preset === 'custom') return { from: custom.from || thisMonth(today).from, to: custom.to || today };
  return presetPeriod(preset === 'quarter' ? 'last_90_days' : preset, today);
}

/** A figure lives on the row or inside its `cost` / `balance` group (D-022). */
function figuresOf(shape: Shape, row: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!row) return {};
  if (shape.costGroup) return (row.cost as Record<string, unknown>) ?? {};
  if (shape.balanceGroup) return (row.balance as Record<string, unknown>) ?? {};
  return row;
}

/** A row's quantity in the measure its material is sold in: pieces, or kilograms. */
function quantityValue(row: Record<string, unknown>, kgField: string, countField?: string): { value: number; pieces: boolean } | null {
  if (countField && row.priced_measure === 'count' && row[countField] !== undefined && row[countField] !== null) {
    return { value: Number(row[countField]), pieces: true };
  }
  const kg = row[kgField];
  if (kg === undefined || kg === null) return null;
  return { value: Number(kg), pieces: false };
}

/** The quantity columns worth showing: a report whose rows carry no kilos gets no kilo column. */
function usefulQuantities(shape: Shape, rows: readonly Record<string, unknown>[]): [string, string, string?][] {
  return (shape.quantities ?? []).filter(([, kg, count]) =>
    rows.some((row) => {
      const quantity = quantityValue(row, kg, count);
      return quantity !== null && (quantity.pieces || quantity.value !== 0);
    }),
  );
}

function readPath(row: Record<string, unknown> | undefined, field: string): unknown {
  if (!row) return undefined;
  if (row[field] !== undefined) return row[field];
  return (row.cost as Record<string, unknown> | undefined)?.[field];
}

export function ReportsPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [params, setParams] = useSearchParams();
  const maySeeProfit = usePermission('fields.see_profit');
  const maySeeBalances = usePermission('fields.see_customer_balances');
  const maySeeAccounts = usePermission('accounts.view');
  const lang = useApp((state) => state.preferences.lang);

  const allowed = ORDER.filter((key) => {
    if (key === 'expenses') return maySeeAccounts;
    const flag = SHAPES[key].flag;
    if (flag === 'fields.see_profit') return maySeeProfit;
    if (flag === 'fields.see_customer_balances') return maySeeBalances;
    return true;
  });
  const requested = params.get('tab') as ReportKey | null;
  const tab: ReportKey = requested && allowed.includes(requested) ? requested : (allowed[0] ?? 'sales');
  const preset = (params.get('period') as Preset | null) ?? 'month';
  const range = periodOf(preset, formatter.today(), { from: params.get('from') ?? '', to: params.get('to') ?? '' });
  const exporter = useExport();

  const set = (patch: Record<string, string | null>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );

  usePageTitle(t('reports:title'));

  const titleOf = (key: ReportKey) => (key === 'expenses' ? t('reports:expenses') : t(SHAPES[key].titleKey));
  const period = `${formatter.date(range.from)} — ${formatter.date(range.to)}`;

  const downloadAll = () =>
    exporter.run(async () => {
      const sheets: ExportedSheet[] = [];
      for (const key of allowed) {
        sheets.push(
          key === 'expenses'
            ? await expensesSheet(range, t, formatter, period)
            : await reportSheet(key, SHAPES[key], defaultGrouping(SHAPES[key], range), range, t, formatter, period),
        );
      }
      downloadXlsx(
        `jiyan-reports-${range.from}-${range.to}`,
        sheets.map((exported) => exported.sheet),
        { rtl: lang !== 'en' },
      );
      return sheets.some((exported) => exported.truncated);
    });

  return (
    <div className="mz-stack">
      <div className="mz-reports__head">
        <p className="mz-muted">{t('reports:hub_hint')}</p>
        <Button variant="secondary" icon="download" loading={exporter.exporting} onClick={() => void downloadAll()}>
          {t('reports:download_all')}
        </Button>
      </div>
      <ExportNotice notice={exporter.notice} />

      {/* The period: one for every tab, kept in the address so a report can be bookmarked. */}
      <div className="mz-accounts__period">
        <label className="mz-field">
          <span className="mz-field__label">{t('reports:period')}</span>
          <select
            className="mz-select mz-select--field"
            value={preset}
            onChange={(event) => set({ period: event.target.value, from: null, to: null })}
          >
            <option value="today">{t('common:today')}</option>
            <option value="week">{t('common:this_week')}</option>
            <option value="month">{t('common:this_month')}</option>
            <option value="last_month">{t('reports:last_month')}</option>
            <option value="quarter">{t('reports:last_quarter', { days: formatter.number(90) })}</option>
            <option value="year">{t('reports:this_year')}</option>
            <option value="custom">{t('common:custom_range')}</option>
          </select>
        </label>
        <DateField
          label={t('common:date_from')}
          value={range.from}
          max={range.to}
          onChange={(event) => set({ period: 'custom', from: event.target.value, to: range.to })}
        />
        <DateField
          label={t('common:date_to')}
          value={range.to}
          min={range.from}
          max={formatter.today()}
          onChange={(event) => set({ period: 'custom', from: range.from, to: event.target.value })}
        />
      </div>

      <Tabs
        label={t('reports:title')}
        value={tab}
        onChange={(next) => set({ tab: next })}
        tabs={allowed.map((key) => ({ value: key, label: titleOf(key) }))}
      />

      {tab === 'expenses' ? (
        <ExpensesTab range={range} period={period} />
      ) : (
        <ReportTab key={tab} reportKey={tab} shape={SHAPES[tab]} range={range} period={period} />
      )}
    </div>
  );
}

/**
 * How a report opens: by day for a period of two months or less (a month grouped by month is one
 * row and no trend), by month for anything longer; the reader can change it.
 */
function defaultGrouping(shape: Shape, range?: { from: string; to: string }): string {
  if (range && shape.groupings.includes('day')) {
    const days = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000;
    if (days <= 62) return 'day';
  }
  return shape.groupings[0] ?? '';
}

type Formatter = ReturnType<typeof useFormatter>;
type Translate = ReturnType<typeof useTranslation>['t'];

/** A group's name: a month or a day reads as one; a dimension names itself. */
function labelOf(group: ReportGroup, groupBy: string, formatter: Formatter, t: Translate): string {
  if (group.label) return group.label;
  if (groupBy === 'month' && /^\d{4}-\d{2}/.test(group.key)) return formatter.month(group.key.slice(0, 7));
  if (/^\d{4}-\d{2}-\d{2}$/.test(group.key)) return formatter.date(group.key);
  if (groupBy === 'attribution') return t(`damages:who.${group.key}`, { defaultValue: group.key });
  return group.key;
}

/**
 * How far a file export reads: the API's one-pass export (`all=true`) carries up to 10,000 groups.
 * A period with more than that is not silently cut short — the export says the file holds only
 * the first rows (see `useExport`). The expenses list still pages: 100 pages of 100 rows.
 */
const EXPORT_PAGES = 100;
const EXPORT_ROWS = EXPORT_PAGES * 100;

/** A sheet for the file, and whether the period had more rows than the export reads. */
interface ExportedSheet {
  sheet: Sheet;
  truncated: boolean;
}

async function fetchAll(
  key: ReportKey,
  groupBy: string,
  range: { from: string; to: string },
): Promise<{ data: ReportResponse; truncated: boolean }> {
  // Every group in one answer (D-075): the report is computed once for the file. It used to be
  // asked page after page, and the server recomputed the whole report for each page — 22.9 s
  // for a year of Receivables at ten years of data.
  const search = new URLSearchParams({ from: range.from, to: range.to, all: 'true' });
  if (groupBy) search.set('group_by', groupBy);
  const data = await apiRequest<ReportResponse>(`/reports/${key}?${search.toString()}`);
  return { data, truncated: data.has_more };
}

/** One report as a sheet: its groups, a column per figure (dinars and dollars apart), totals. */
async function reportSheet(
  key: ReportKey,
  shape: Shape,
  groupBy: string,
  range: { from: string; to: string },
  t: Translate,
  formatter: Formatter,
  period: string,
): Promise<ExportedSheet> {
  const { data, truncated } = await fetchAll(key, groupBy, range);
  const firstFigures = figuresOf(shape, (data.groups[0] ?? data.totals) as Record<string, unknown> | undefined);
  const amounts = shape.amounts.filter(([, iqd]) => data.groups.length === 0 || firstFigures[iqd] !== undefined);
  const quantities = usefulQuantities(shape, data.groups as Record<string, unknown>[]);
  const unit = (label: string, symbol: string) => (t(label).includes(symbol) ? t(label) : `${t(label)} (${symbol})`);
  const columns: SheetColumn[] = [
    { header: groupBy ? t(`reports:group.${groupBy}`) : t('reports:name_column'), format: 'text', width: 28 },
    ...shape.counts.map(([label]) => ({ header: t(label), format: 'integer' as const })),
    ...quantities.flatMap(([label, , count]) => [
      ...(count ? [{ header: unit(label, t('common:count_symbol')), format: 'integer' as const }] : []),
      { header: unit(label, t('common:kg_symbol')), format: 'kg' as const },
    ]),
    ...amounts.flatMap(([label]) => [
      { header: `${t(label)} (IQD)`, format: 'integer' as const },
      { header: `${t(label)} ($)`, format: 'usd' as const },
    ]),
  ];
  const rowOf = (row: Record<string, unknown>, name: string): Cell[] => {
    const figures = figuresOf(shape, row);
    return [
      name,
      ...shape.counts.map(([, field]) => (row[field] === undefined ? null : Number(row[field]))),
      ...quantities.flatMap(([, kg, count]) => {
        const quantity = quantityValue(row, kg, count);
        const pieces = quantity?.pieces ? quantity.value : null;
        const kilos = quantity && !quantity.pieces ? quantity.value : null;
        return count ? [pieces, kilos] : [kilos];
      }),
      ...amounts.flatMap(([, iqd, usd]) => [
        figures[iqd] === undefined || figures[iqd] === null ? null : Number(figures[iqd]),
        figures[usd] === undefined || figures[usd] === null ? null : Number(figures[usd]) / 100,
      ]),
    ];
  };
  return {
    sheet: {
      name: t(shape.titleKey),
      title: t(shape.titleKey),
      subtitle: period,
      columns,
      rows: data.groups.map((group) => rowOf(group as Record<string, unknown>, labelOf(group, data.group_by, formatter, t))),
      totals: data.totals ? rowOf(data.totals, t('reports:total_row')) : undefined,
    },
    truncated,
  };
}

interface ExpenseRow {
  id: string;
  number: number;
  expense_date: string;
  title: string;
  note: string | null;
  amount_iqd: number;
  amount_usd_cents: number;
  created_by_name: string | null;
}

async function expensesSheet(
  range: { from: string; to: string },
  t: Translate,
  formatter: Formatter,
  period: string,
): Promise<ExportedSheet> {
  const rows: ExpenseRow[] = [];
  let total = 0;
  for (let page = 1; page <= EXPORT_PAGES; page += 1) {
    const response = await apiRequest<{ items: ExpenseRow[]; total: number }>(
      `/expenses?from=${range.from}&to=${range.to}&page=${page}&page_size=100`,
    );
    total = response.total;
    rows.push(...response.items);
    if (rows.length >= response.total || response.items.length === 0) break;
  }
  return { sheet: expensesSheetOf(rows, t, formatter, period), truncated: rows.length < total };
}

function expensesSheetOf(rows: ExpenseRow[], t: Translate, formatter: Formatter, period: string): Sheet {
  return {
    name: t('reports:expenses'),
    title: t('reports:expenses'),
    subtitle: period,
    columns: [
      { header: t('common:date'), format: 'text', width: 14 },
      { header: t('reports:expense_title'), format: 'text', width: 30 },
      { header: `${t('reports:amount')} (IQD)`, format: 'integer' },
      { header: `${t('reports:amount')} ($)`, format: 'usd' },
      { header: t('glossary:done_by'), format: 'text' },
      { header: t('reports:note'), format: 'text', width: 36 },
    ],
    rows: rows.map((row) => [
      formatter.date(row.expense_date),
      row.title,
      row.amount_iqd,
      row.amount_usd_cents / 100,
      row.created_by_name,
      row.note,
    ]),
    totals: [
      t('reports:total_row'),
      null,
      rows.reduce((sum, row) => sum + row.amount_iqd, 0),
      rows.reduce((sum, row) => sum + row.amount_usd_cents, 0) / 100,
      null,
      null,
    ],
  };
}

/**
 * A file export's state. A failure is said, not swallowed — the old `try … finally` left the
 * button spinning back to idle with nothing downloaded and nothing on screen — and a period
 * longer than the export reads says the file holds only its first rows.
 */
function useExport() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const run = async (work: () => Promise<boolean>) => {
    setExporting(true);
    setNotice(null);
    try {
      const truncated = await work();
      if (truncated) setNotice(t('common:export_truncated', { count: formatter.number(EXPORT_ROWS) }));
    } catch (caught) {
      setNotice(errorMessage(t, caught));
    } finally {
      setExporting(false);
    }
  };
  return { exporting, notice, run };
}

function ExportNotice({ notice }: { notice: string | null }) {
  if (!notice) return null;
  return (
    <div className="mz-warning" role="alert">
      {notice}
    </div>
  );
}

function Tile({ icon, label, children }: { icon: Parameters<typeof Icon>[0]['name']; label: string; children: ReactNode }) {
  return (
    <div className="mz-kpi">
      <KpiHead icon={icon} label={label} />
      {children}
    </div>
  );
}

function ReportTab({
  reportKey,
  shape,
  range,
  period,
}: {
  reportKey: Exclude<ReportKey, 'expenses'>;
  shape: Shape;
  range: { from: string; to: string };
  period: string;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const wide = useIsWide();
  const lang = useApp((state) => state.preferences.lang);
  const [groupBy, setGroupBy] = useState(() => defaultGrouping(shape, range));
  const exporter = useExport();
  const paging = usePaging({ storageKey: 'reports', prefix: 'r_', resetOn: [reportKey, range.from, range.to, groupBy] });

  const report = useQuery({
    queryKey: ['reports', reportKey, range.from, range.to, groupBy, paging.page, paging.pageSize],
    queryFn: () => {
      const search = new URLSearchParams({ from: range.from, to: range.to });
      if (groupBy) search.set('group_by', groupBy);
      return apiRequest<ReportResponse>(`/reports/${reportKey}?${search.toString()}&${paging.query}`);
    },
    placeholderData: keepPreviousData,
  });
  useKeepPageInRange(paging, {
    data: report.data ? { total: report.data.group_count } : undefined,
    isPlaceholderData: report.isPlaceholderData,
  });

  const data = report.data;
  const groups = data?.groups ?? [];
  const totals = data?.totals ?? {};
  const totalFigures = figuresOf(shape, totals);
  const amounts = shape.amounts.filter(([, iqd]) => totalFigures[iqd] !== undefined || groups.some((g) => figuresOf(shape, g)[iqd] !== undefined));
  const headline = amounts[0];

  const download = () =>
    exporter.run(async () => {
      const { sheet, truncated } = await reportSheet(reportKey, shape, groupBy, range, t, formatter, period);
      downloadXlsx(`jiyan-${reportKey}-${range.from}-${range.to}`, [sheet], { rtl: lang !== 'en' });
      return truncated;
    });

  // A trend when the groups are days or months: oldest on the reading start, the headline figure.
  const chronological = (groupBy === 'month' || groupBy === 'day') && headline && groups.length > 1;
  const chartPoints = chronological
    ? [...groups]
        .sort((left, right) => (left.key < right.key ? -1 : 1))
        .map((group) => ({
          // A day reads "26/9" under a column: the full date is in the tooltip and the table.
          label:
            groupBy === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(group.key)
              ? `${formatter.number(Number(group.key.slice(8, 10)))}/${formatter.number(Number(group.key.slice(5, 7)))}`
              : labelOf(group, groupBy, formatter, t),
          full: labelOf(group, groupBy, formatter, t),
          values: { main: Math.max(0, Number(figuresOf(shape, group)[headline[1]] ?? 0)) },
        }))
    : [];

  const money = (row: Record<string, unknown>, [, iqd, usd]: [string, string, string]) => {
    const figures = figuresOf(shape, row);
    if (figures[iqd] === undefined || figures[iqd] === null) return <span className="mz-muted">—</span>;
    return (
      <DualAmount
        amount_iqd={Number(figures[iqd])}
        amount_usd_cents={Number(figures[usd] ?? 0)}
        primary={(row.settlement_currency as Currency | undefined) ?? 'IQD'}
      />
    );
  };
  const kilos = (value: unknown) =>
    value === undefined || value === null ? '—' : `${formatter.quantity(String(value))} ${t('common:kg_symbol')}`;
  const quantityText = (row: Record<string, unknown>, kg: string, count?: string) => {
    const quantity = quantityValue(row, kg, count);
    if (!quantity) return '—';
    return quantity.pieces
      ? `${formatter.number(quantity.value)} ${t('common:count_symbol')}`
      : `${formatter.quantity(String(quantity.value))} ${t('common:kg_symbol')}`;
  };
  const quantities = usefulQuantities(shape, groups as Record<string, unknown>[]);

  return (
    <div className="mz-stack">
      <div className="mz-reports__bar">
        <div>
          <h2 className="mz-heading">{t(shape.titleKey)}</h2>
          <p className="mz-caption">{t(shape.hintKey)}</p>
        </div>
        <div className="mz-reports__actions">
          {shape.groupings.length > 0 ? (
            <select className="mz-select" aria-label={t('reports:group_by')} value={groupBy} onChange={(event) => setGroupBy(event.target.value)}>
              {shape.groupings.map((option) => (
                <option key={option} value={option}>
                  {t('reports:group_by')}: {t(`reports:group.${option}`)}
                </option>
              ))}
            </select>
          ) : null}
          <Button icon="download" loading={exporter.exporting} onClick={() => void download()}>
            {t('reports:download_excel')}
          </Button>
        </div>
      </div>
      <ExportNotice notice={exporter.notice} />

      {data?.pinned ? <Chip tone="warning">{t('reports:pinned_to_you')}</Chip> : null}

      <QueryStates query={report} isEmpty={groups.length === 0} emptyTitle={t('reports:empty')}>
        {/* The totals of the whole period, as tiles — never just the page's. */}
        <div className="mz-kpis">
          {amounts.map((amount) =>
            totalFigures[amount[1]] === undefined ? null : (
              <Tile key={amount[1]} icon="chart" label={t(amount[0])}>
                {money(totals, amount)}
              </Tile>
            ),
          )}
          {(shape.extras ?? []).map(([label, iqd, usd]) =>
            readPath(totals, iqd) === undefined ? null : (
              <Tile key={iqd} icon="check" label={t(label)}>
                <DualAmount amount_iqd={Number(readPath(totals, iqd))} amount_usd_cents={Number(readPath(totals, usd) ?? 0)} />
              </Tile>
            ),
          )}
          {shape.counts.map(([label, field]) =>
            totals[field] === undefined ? null : (
              <Tile key={field} icon="orders" label={t(label)}>
                <span className="mz-kpi__count" data-tabular>
                  {formatter.number(Number(totals[field]))}
                </span>
              </Tile>
            ),
          )}
          {(shape.quantities ?? []).map(([label, field]) =>
            totals[field] === undefined || Number(totals[field]) === 0 ? null : (
              <Tile key={field} icon="materials" label={t(label)}>
                <span className="mz-kpi__count" data-tabular>
                  {kilos(totals[field])}
                </span>
              </Tile>
            ),
          )}
        </div>
        {reportKey === 'profit' && Number(totals.lines_without_cost ?? 0) > 0 ? (
          <p className="mz-caption">{t('reports:no_cost_price', { count: Number(totals.lines_without_cost) })}</p>
        ) : null}
        {/* Grouped by material, the rounding less order discounts has no row of its own (D-077). */}
        {reportKey === 'profit' && Number(readPath(totals, 'order_adjustment_iqd') ?? 0) !== 0 ? (
          <p className="mz-caption">
            {t('reports:order_adjustment_in_totals')}{' '}
            <DualAmount
              amount_iqd={Number(readPath(totals, 'order_adjustment_iqd'))}
              amount_usd_cents={Number(readPath(totals, 'order_adjustment_usd_cents') ?? 0)}
            />
          </p>
        ) : null}

        {chronological && headline ? (
          <div className="mz-card">
            <h3 className="mz-heading">{t(headline[0])}</h3>
            <p className="mz-caption">{t('reports:chart_in_dinars')}</p>
            <ColumnChart
              label={t(headline[0])}
              series={[{ key: 'main', label: t(headline[0]), color: 'var(--color-primary)' }]}
              points={chartPoints}
              tooltip={(index) => {
                const point = chartPoints[index];
                return point ? (
                  <span className="mz-stack" style={{ gap: 'var(--space-1)' }}>
                    <strong>{point.full}</strong>
                    <span data-tabular>{formatter.money(point.values.main, 'IQD')}</span>
                  </span>
                ) : null;
              }}
            />
          </div>
        ) : null}

        {wide ? (
          <div className="mz-table-wrap">
            <table className="mz-table mz-table--static">
              <thead>
                <tr>
                  <th scope="col">{groupBy ? t(`reports:group.${groupBy}`) : t('reports:name_column')}</th>
                  {shape.counts.map(([label, field]) => (
                    <th key={field} scope="col" data-numeric="true">
                      {t(label)}
                    </th>
                  ))}
                  {quantities.map(([label, field]) => (
                    <th key={field} scope="col" data-numeric="true">
                      {t(label)}
                    </th>
                  ))}
                  {amounts.map(([label, iqd]) => (
                    <th key={iqd} scope="col" data-numeric="true">
                      {t(label)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.key}>
                    <td>
                      <GroupName reportKey={reportKey} group={group} groupBy={data?.group_by ?? groupBy} range={range} />
                    </td>
                    {shape.counts.map(([, field]) => (
                      <td key={field} data-numeric="true" data-tabular>
                        {group[field] === undefined ? '—' : formatter.number(Number(group[field]))}
                      </td>
                    ))}
                    {quantities.map(([, field, count]) => (
                      <td key={field} data-numeric="true" data-tabular>
                        {quantityText(group as Record<string, unknown>, field, count)}
                      </td>
                    ))}
                    {amounts.map((amount) => (
                      <td key={amount[1]} data-numeric="true">
                        {money(group as Record<string, unknown>, amount)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ul className="mz-list">
            {groups.map((group) => (
              <li key={group.key} className="mz-list__item">
                <span className="mz-rowcard">
                  <span className="mz-rowcard__head">
                    <span className="mz-list__title">
                      <GroupName reportKey={reportKey} group={group} groupBy={data?.group_by ?? groupBy} range={range} />
                    </span>
                    {headline ? money(group as Record<string, unknown>, headline) : null}
                  </span>
                  <span className="mz-caption" data-tabular>
                    {[
                      ...shape.counts
                        .filter(([, field]) => group[field] !== undefined)
                        .map(([label, field]) => `${t(label)}: ${formatter.number(Number(group[field]))}`),
                      ...quantities.map(
                        ([label, field, count]) => `${t(label)}: ${quantityText(group as Record<string, unknown>, field, count)}`,
                      ),
                    ].join(' · ')}
                  </span>
                  {amounts.slice(1).map((amount) => (
                    <span key={amount[1]} className="mz-rowcard__foot">
                      <span className="mz-caption">{t(amount[0])}</span>
                      {money(group as Record<string, unknown>, amount)}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}

        <Pager
          page={paging.page}
          pageSize={paging.pageSize}
          total={data?.group_count ?? 0}
          onPage={paging.setPage}
          onPageSize={paging.setPageSize}
        />
      </QueryStates>
    </div>
  );
}

/** A group's name, and where it leads: the company, the material, the employee's History. */
function GroupName({
  reportKey,
  group,
  groupBy,
  range,
}: {
  reportKey: ReportKey;
  group: ReportGroup;
  groupBy: string;
  range: { from: string; to: string };
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const name = labelOf(group, groupBy, formatter, t);
  const isId = /^[0-9a-f-]{36}$/i.test(group.key);
  if (isId && (groupBy === 'customer' || reportKey === 'receivables')) {
    return (
      <Link to={`/customers/${group.key}`} className="mz-quiet-link">
        <bdi>{name}</bdi>
      </Link>
    );
  }
  if (isId && (groupBy === 'item' || reportKey === 'stock')) {
    return (
      <Link to={`/materials/${group.key}`} className="mz-quiet-link">
        <bdi>{name}</bdi>
      </Link>
    );
  }
  if (isId && (groupBy === 'employee' || reportKey === 'employee-activity' || reportKey === 'cash-up')) {
    return (
      <Link to={`/history?done_by=${group.key}&from=${range.from}&to=${range.to}&preset=custom`} className="mz-quiet-link">
        <bdi>{name}</bdi>
      </Link>
    );
  }
  return <bdi>{name}</bdi>;
}

function ExpensesTab({ range, period }: { range: { from: string; to: string }; period: string }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const lang = useApp((state) => state.preferences.lang);
  const exporter = useExport();
  const paging = usePaging({ storageKey: 'reports', prefix: 'e_', resetOn: [range.from, range.to] });

  const list = useQuery({
    queryKey: ['expenses', 'report', range.from, range.to, paging.page, paging.pageSize],
    queryFn: () =>
      apiRequest<{ items: ExpenseRow[]; total: number }>(`/expenses?from=${range.from}&to=${range.to}&${paging.query}`),
    placeholderData: keepPreviousData,
  });
  useKeepPageInRange(paging, list);
  const summary = useQuery({
    queryKey: ['accounts', 'summary', range.from, range.to],
    queryFn: () =>
      apiRequest<{ expenses: { amount_iqd: number; amount_usd_cents: number; count: number } }>(
        `/accounts/summary?from=${range.from}&to=${range.to}`,
      ),
  });
  const rows = list.data?.items ?? [];

  const download = () =>
    exporter.run(async () => {
      const { sheet, truncated } = await expensesSheet(range, t, formatter, period);
      downloadXlsx(`jiyan-expenses-${range.from}-${range.to}`, [sheet], { rtl: lang !== 'en' });
      return truncated;
    });

  return (
    <div className="mz-stack">
      <div className="mz-reports__bar">
        <div>
          <h2 className="mz-heading">{t('reports:expenses')}</h2>
          <p className="mz-caption">{t('reports:expenses_hint')}</p>
        </div>
        <div className="mz-reports__actions">
          <Link to="/accounts?tab=expenses" className="mz-button mz-button--ghost">
            {t('reports:manage_expenses')}
          </Link>
          <Button icon="download" loading={exporter.exporting} onClick={() => void download()}>
            {t('reports:download_excel')}
          </Button>
        </div>
      </div>
      <ExportNotice notice={exporter.notice} />

      {summary.data ? (
        <div className="mz-kpis">
          <Tile icon="chart" label={t('reports:expenses')}>
            <DualAmount amount_iqd={summary.data.expenses.amount_iqd} amount_usd_cents={summary.data.expenses.amount_usd_cents} />
          </Tile>
          <Tile icon="orders" label={t('reports:records')}>
            <span className="mz-kpi__count" data-tabular>
              {formatter.number(summary.data.expenses.count)}
            </span>
          </Tile>
        </div>
      ) : null}

      <QueryStates query={list} isEmpty={rows.length === 0} emptyTitle={t('reports:empty')}>
        <div className="mz-table-wrap">
          <table className="mz-table mz-table--static">
            <thead>
              <tr>
                <th scope="col">{t('common:date')}</th>
                <th scope="col">{t('reports:expense_title')}</th>
                <th scope="col">{t('glossary:done_by')}</th>
                <th scope="col" data-numeric="true">
                  {t('reports:amount')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td data-tabular>{formatter.date(row.expense_date)}</td>
                  <td>
                    <bdi>{row.title}</bdi>
                    {row.note ? (
                      <span className="mz-caption" style={{ display: 'block' }}>
                        <bdi>{row.note}</bdi>
                      </span>
                    ) : null}
                  </td>
                  <td>{row.created_by_name ? <bdi>{row.created_by_name}</bdi> : '—'}</td>
                  <td data-numeric="true">
                    <DualAmount amount_iqd={row.amount_iqd} amount_usd_cents={row.amount_usd_cents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager
          page={paging.page}
          pageSize={paging.pageSize}
          total={list.data?.total ?? 0}
          onPage={paging.setPage}
          onPageSize={paging.setPageSize}
        />
      </QueryStates>
    </div>
  );
}

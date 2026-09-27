import { useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet, Button, DateField, SegmentedControl, TextField, Toast } from '@mizan/ui';
import type { IconName } from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { apiRequest, newIdempotencyKey } from '../lib/api.js';
import { errorMessage } from '../lib/errors.js';
import { invalidateMoneyViews } from '../lib/invalidate.js';
import { useGlobalRate } from '../lib/rates.js';
import { usePageTitle } from '../lib/page-title.js';
import { Can } from '../components/Can.js';
import { DataList } from '../components/DataList.js';
import type { Column } from '../components/DataList.js';
import { DualAmount } from '../components/DualAmount.js';
import { KpiHead } from '../components/KpiHead.js';
import { MoneyInput } from '../components/MoneyInput.js';
import type { MoneyValue } from '../components/MoneyInput.js';
import { Pager } from '../components/Pager.js';
import { QueryStates } from '../components/states.js';
import { customerName } from '../lib/customers.js';
import { useKeepPageInRange, usePaging } from '../lib/paging.js';
import { useDebouncedValue } from '../lib/debounce.js';
import { lastMonth, thisMonth, thisYear } from '../lib/periods.js';
import { useFormatter, usePermission } from '../lib/store.js';
import { useIsWide } from '../lib/wide.js';
import type { PurchaseRow } from '../lib/purchases.js';

interface Pair {
  amount_iqd: number;
  amount_usd_cents: number;
}

interface Summary {
  from: string;
  to: string;
  sold: Pair & { count: number };
  cost_of_sold: Pair;
  profit: Pair;
  lines_without_cost: number;
  bought: Pair & { count: number };
  expenses: Pair & { count: number };
  damage_loss: Pair & { count: number };
  damage_recovered: Pair & { count: number };
  net: Pair;
}

interface SaleRow {
  id: string;
  number: number;
  order_date: string;
  customer_id: string;
  customer_name: string;
  customer_is_system: boolean;
  settlement_currency: Currency;
  total: Pair;
  cost: Pair;
  profit: Pair;
  lines_without_cost: number;
}

interface MaterialRow {
  id: string;
  name: string;
  pricing_unit: 'per_piece' | 'per_kg';
  sold_qty: string;
  sold: Pair;
  cost: Pair;
  profit: Pair;
  bought_qty: string;
  bought: Pair;
  stock: string;
}

interface ExpenseRow {
  id: string;
  number: number;
  expense_date: string;
  title: string;
  note: string | null;
  amount_iqd: number;
  amount_usd_cents: number;
  entered_currency: Currency;
  created_by_name: string | null;
  version: number;
}

type Tab = 'sales' | 'bought' | 'materials' | 'expenses';
type Preset = 'this_month' | 'last_month' | 'this_year' | 'custom';

const TABS: readonly Tab[] = ['sales', 'bought', 'materials', 'expenses'];

/** The first and last day of a preset, from today's Baghdad date (2.10.4). */
function presetRange(preset: Exclude<Preset, 'custom'>, today: string): { from: string; to: string } {
  if (preset === 'this_year') return thisYear(today);
  if (preset === 'this_month') return thisMonth(today);
  return lastMonth(today);
}

/**
 * The accountant page (client review, D-062). It took the Purchases page's place: what the
 * factory sold in a period and what that cost us, the profit, what it bought and spent, the damage
 * that is still a loss — and what is left. The period is the first of this month to today unless
 * somebody moves it, and it lives in the address, so a reload or a shared link keeps it.
 *
 * Every figure is the server's sum of stored integers in both currencies; this page only lays
 * them out. The tabs underneath are the rows behind the figures, each searchable and paged.
 */
export function AccountsPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [params, setParams] = useSearchParams();
  const today = formatter.today();
  const defaults = presetRange('this_month', today);
  const from = params.get('from') ?? defaults.from;
  const to = params.get('to') ?? defaults.to;
  const tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'sales';

  const setParam = (changes: Record<string, string | null>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(changes)) {
          if (value === null) next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );

  const preset: Preset =
    (['this_month', 'last_month', 'this_year'] as const).find((name) => {
      const range = presetRange(name, today);
      return range.from === from && range.to === to;
    }) ?? 'custom';

  const summary = useQuery({
    queryKey: ['accounts', 'summary', from, to],
    queryFn: () => apiRequest<Summary>(`/accounts/summary?from=${from}&to=${to}`),
    placeholderData: keepPreviousData,
  });

  usePageTitle(t('purchases:accounts_title'));

  const data = summary.data;

  return (
    <div className="mz-stack mz-accounts">
      <p className="mz-muted">{t('purchases:accounts_hint')}</p>

      {/* The period: a quick choice, and the two dates it resolves to, either one movable. */}
      <div className="mz-accounts__period">
        <label className="mz-field">
          <span className="mz-field__label">{t('purchases:period')}</span>
          <select
            className="mz-select mz-select--field"
            value={preset}
            onChange={(event) => {
              const value = event.target.value as Preset;
              if (value !== 'custom') setParam(presetRange(value, today));
            }}
          >
            <option value="this_month">{t('purchases:period_this_month')}</option>
            <option value="last_month">{t('purchases:period_last_month')}</option>
            <option value="this_year">{t('purchases:period_this_year')}</option>
            <option value="custom">{t('purchases:period_custom')}</option>
          </select>
        </label>
        <DateField
          label={t('common:date_from')}
          value={from}
          max={to}
          onChange={(event) => event.target.value && setParam({ from: event.target.value })}
        />
        <DateField
          label={t('common:date_to')}
          value={to}
          min={from}
          max={today}
          onChange={(event) => event.target.value && setParam({ to: event.target.value })}
        />
      </div>

      <QueryStates query={summary} skeletonLines={4}>
        {data ? (
          <>
            <div className="mz-accounts__net" data-sign={Math.sign(data.net.amount_iqd)}>
              <span className="mz-accounts__net-label">{t('purchases:tile_net')}</span>
              <DualAmount amount_iqd={data.net.amount_iqd} amount_usd_cents={data.net.amount_usd_cents} size="large" />
              <span className="mz-caption">{t('purchases:net_hint')}</span>
            </div>

            <div className="mz-kpis mz-accounts__tiles">
              <Figure
                icon="orders"
                label={t('purchases:tile_sold')}
                pair={data.sold}
                caption={t('purchases:count_orders', { count: formatter.number(data.sold.count) })}
              />
              <Figure icon="materials" label={t('purchases:tile_cost')} pair={data.cost_of_sold} />
              <Figure icon="chart" label={t('purchases:tile_profit')} pair={data.profit} signed />
              <Figure
                icon="purchases"
                label={t('purchases:tile_bought')}
                pair={data.bought}
                caption={t('purchases:count_buys', { count: formatter.number(data.bought.count) })}
              />
              <Figure
                icon="history"
                label={t('purchases:tile_expenses')}
                pair={data.expenses}
                caption={t('purchases:count_entries', { count: formatter.number(data.expenses.count) })}
              />
              <Figure
                icon="warning"
                label={t('purchases:tile_damage_loss')}
                pair={data.damage_loss}
                caption={t('purchases:count_records', { count: formatter.number(data.damage_loss.count) })}
              />
              <Figure
                icon="check"
                label={t('purchases:tile_damage_back')}
                pair={data.damage_recovered}
                caption={t('purchases:count_records', { count: formatter.number(data.damage_recovered.count) })}
              />
            </div>

            {data.lines_without_cost > 0 ? (
              <p className="mz-warning" role="status">
                {t('purchases:uncosted_warning', { count: formatter.number(data.lines_without_cost) })}
              </p>
            ) : null}
          </>
        ) : null}
      </QueryStates>

      <SegmentedControl
        label={t('purchases:tabs_label')}
        value={tab}
        onChange={(value) => setParam({ tab: value })}
        options={TABS.map((value) => ({ value, label: t(`purchases:tab_${value}`) }))}
      />

      {tab === 'sales' ? <SalesTab from={from} to={to} /> : null}
      {tab === 'bought' ? <BoughtTab from={from} to={to} /> : null}
      {tab === 'materials' ? <MaterialsTab from={from} to={to} /> : null}
      {tab === 'expenses' ? <ExpensesTab from={from} to={to} /> : null}
    </div>
  );
}

/** One figure of the period, drawn as the Today tiles are; `signed` colours a loss and a gain. */
function Figure({
  icon,
  label,
  pair,
  caption,
  signed,
}: {
  icon: IconName;
  label: string;
  pair: Pair;
  caption?: string;
  signed?: boolean;
}) {
  const sign = Math.sign(pair.amount_iqd);
  return (
    <div className="mz-kpi mz-accounts__tile" data-sign={signed ? sign : undefined}>
      <KpiHead icon={icon} label={label} />
      <DualAmount amount_iqd={pair.amount_iqd} amount_usd_cents={pair.amount_usd_cents} />
      {caption ? <span className="mz-caption">{caption}</span> : null}
    </div>
  );
}

/** The search box and the list and pager of one tab, the same for all four. */
function TabFrame({
  search,
  onSearch,
  placeholder,
  children,
  action,
}: {
  search: string;
  onSearch: (value: string) => void;
  placeholder: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="mz-stack">
      <div className="mz-toolbar">
        <div className="mz-toolbar__filters">
          <div className="mz-toolbar__search">
            <TextField
              label={t('common:search')}
              placeholder={placeholder}
              value={search}
              type="search"
              inputMode="search"
              onChange={(event) => onSearch(event.target.value)}
            />
          </div>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Signed({ pair, primary }: { pair: Pair; primary?: Currency }) {
  return (
    <span className="mz-accounts__signed" data-sign={Math.sign(pair.amount_iqd)}>
      <DualAmount amount_iqd={pair.amount_iqd} amount_usd_cents={pair.amount_usd_cents} primary={primary} />
    </span>
  );
}

function SalesTab({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search);
  const paging = usePaging({ storageKey: 'accounts-sales', prefix: 'sales_', resetOn: [q, from, to] });
  const list = useQuery({
    queryKey: ['accounts', 'sales', from, to, q, paging.page, paging.pageSize],
    queryFn: () =>
      apiRequest<{ items: SaleRow[]; total: number }>(
        `/accounts/sales?from=${from}&to=${to}&q=${encodeURIComponent(q)}&${paging.query}`,
      ),
    placeholderData: keepPreviousData,
  });
  useKeepPageInRange(paging, list);
  const rows = list.data?.items ?? [];

  const columns: Column<SaleRow>[] = [
    {
      header: t('purchases:col_order'),
      cell: (row) => (
        <span className="mz-cell__body">
          <strong>{t('orders:number', { number: formatter.identifier(row.number) })}</strong>
          <span className="mz-caption">{formatter.date(row.order_date)}</span>
        </span>
      ),
    },
    {
      header: t('glossary:company'),
      cell: (row) => <bdi>{customerName({ name: row.customer_name, is_system: row.customer_is_system }, t)}</bdi>,
    },
    {
      header: t('glossary:total'),
      numeric: true,
      cell: (row) => (
        <DualAmount amount_iqd={row.total.amount_iqd} amount_usd_cents={row.total.amount_usd_cents} primary={row.settlement_currency} />
      ),
    },
    {
      header: t('purchases:col_cost'),
      numeric: true,
      secondary: true,
      cell: (row) => (
        <DualAmount amount_iqd={row.cost.amount_iqd} amount_usd_cents={row.cost.amount_usd_cents} primary={row.settlement_currency} />
      ),
    },
    { header: t('purchases:col_profit'), numeric: true, cell: (row) => <Signed pair={row.profit} primary={row.settlement_currency} /> },
  ];

  return (
    <TabFrame search={search} onSearch={setSearch} placeholder={t('purchases:search_sales')}>
      <QueryStates query={list} isEmpty={rows.length === 0} emptyTitle={t('purchases:empty_sales')} skeletonLines={4}>
        <DataList
          rows={rows}
          rowKey={(row) => row.id}
          href={(row) => `/orders/${row.id}`}
          columns={columns}
          card={(row) => (
            <span className="mz-rowcard">
              <span className="mz-rowcard__head">
                <span className="mz-list__title">{t('orders:number', { number: formatter.identifier(row.number) })}</span>
                <Signed pair={row.profit} primary={row.settlement_currency} />
              </span>
              <span className="mz-caption">
                <bdi>{customerName({ name: row.customer_name, is_system: row.customer_is_system }, t)}</bdi>
                {' · '}
                {formatter.date(row.order_date)}
              </span>
              <span className="mz-rowcard__foot">
                <DualAmount amount_iqd={row.total.amount_iqd} amount_usd_cents={row.total.amount_usd_cents} primary={row.settlement_currency} />
                <span className="mz-caption">
                  {t('purchases:col_cost')}: {formatter.money(row.cost.amount_iqd, 'IQD')}
                </span>
              </span>
            </span>
          )}
        />
        <Pager
          page={paging.page}
          pageSize={paging.pageSize}
          total={list.data?.total ?? 0}
          onPage={paging.setPage}
          onPageSize={paging.setPageSize}
        />
      </QueryStates>
    </TabFrame>
  );
}

function BoughtTab({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search);
  const paging = usePaging({ storageKey: 'accounts-bought', prefix: 'buys_', resetOn: [q, from, to] });
  const list = useQuery({
    queryKey: ['purchases', 'accounts', from, to, q, paging.page, paging.pageSize],
    queryFn: () =>
      apiRequest<{ items: PurchaseRow[]; total: number }>(
        `/purchases?from=${from}&to=${to}&q=${encodeURIComponent(q)}&${paging.query}`,
      ),
    placeholderData: keepPreviousData,
  });
  useKeepPageInRange(paging, list);
  const rows = list.data?.items ?? [];

  const total = (row: PurchaseRow) =>
    row.cost ? (
      <DualAmount amount_iqd={row.cost.total_iqd} amount_usd_cents={row.cost.total_usd_cents} />
    ) : (
      <span className="mz-muted">—</span>
    );

  const columns: Column<PurchaseRow>[] = [
    {
      header: t('purchases:col_buy'),
      cell: (row) => (
        <span className="mz-cell__body">
          <strong>{t('purchases:number', { number: formatter.identifier(row.number) })}</strong>
          <span className="mz-caption">{formatter.date(row.purchase_date)}</span>
        </span>
      ),
    },
    {
      header: t('glossary:done_by'),
      cell: (row) => (row.acting_user_name ? <bdi>{row.acting_user_name}</bdi> : <span className="mz-muted">—</span>),
    },
    {
      // What was bought, by name — a buy is read by its material, not by a count of lines.
      header: t('purchases:materials_column'),
      cell: (row) =>
        row.item_names ? <bdi>{row.item_names}</bdi> : <span data-tabular>{formatter.number(row.line_count)}</span>,
    },
    { header: t('glossary:total'), numeric: true, cell: total },
  ];

  return (
    <TabFrame search={search} onSearch={setSearch} placeholder={t('purchases:search_bought')}>
      <QueryStates query={list} isEmpty={rows.length === 0} emptyTitle={t('purchases:empty_bought')} skeletonLines={4}>
        <DataList
          rows={rows}
          rowKey={(row) => row.id}
          href={(row) => `/purchases/${row.id}`}
          columns={columns}
          card={(row) => (
            <span className="mz-rowcard">
              <span className="mz-rowcard__head">
                <span className="mz-list__title">{t('purchases:number', { number: formatter.identifier(row.number) })}</span>
                {total(row)}
              </span>
              <span className="mz-caption">
                {formatter.date(row.purchase_date)}
                {row.acting_user_name ? (
                  <>
                    {' · '}
                    <bdi>{row.acting_user_name}</bdi>
                  </>
                ) : null}
                {' · '}
                {row.item_names ? (
                  <bdi>{row.item_names}</bdi>
                ) : (
                  t('purchases:lines_count', { count: formatter.number(row.line_count) })
                )}
              </span>
            </span>
          )}
        />
        <Pager
          page={paging.page}
          pageSize={paging.pageSize}
          total={list.data?.total ?? 0}
          onPage={paging.setPage}
          onPageSize={paging.setPageSize}
        />
      </QueryStates>
    </TabFrame>
  );
}

function MaterialsTab({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search);
  const paging = usePaging({ storageKey: 'accounts-materials', prefix: 'mats_', resetOn: [q, from, to] });
  const list = useQuery({
    queryKey: ['accounts', 'materials', from, to, q, paging.page, paging.pageSize],
    queryFn: () =>
      apiRequest<{ items: MaterialRow[]; total: number }>(
        `/accounts/materials?from=${from}&to=${to}&q=${encodeURIComponent(q)}&${paging.query}`,
      ),
    placeholderData: keepPreviousData,
  });
  useKeepPageInRange(paging, list);
  const rows = list.data?.items ?? [];

  /** A quantity in the material's own measure: whole pieces, or kilograms to three places. */
  const quantity = (row: MaterialRow, value: string) =>
    row.pricing_unit === 'per_piece'
      ? `${formatter.number(Number(value))} ${t('common:count_symbol')}`
      : `${formatter.quantity(value)} ${t('common:kg_symbol')}`;

  const columns: Column<MaterialRow>[] = [
    { header: t('purchases:col_material'), cell: (row) => <strong><bdi>{row.name}</bdi></strong> },
    { header: t('purchases:col_sold_qty'), numeric: true, cell: (row) => <span data-tabular>{quantity(row, row.sold_qty)}</span> },
    {
      header: t('purchases:col_sold'),
      numeric: true,
      secondary: true,
      cell: (row) => <DualAmount amount_iqd={row.sold.amount_iqd} amount_usd_cents={row.sold.amount_usd_cents} />,
    },
    { header: t('purchases:col_profit'), numeric: true, cell: (row) => <Signed pair={row.profit} /> },
    {
      header: t('purchases:col_bought_qty'),
      numeric: true,
      secondary: true,
      cell: (row) => <span data-tabular>{quantity(row, row.bought_qty)}</span>,
    },
    {
      header: t('purchases:col_bought'),
      numeric: true,
      cell: (row) => <DualAmount amount_iqd={row.bought.amount_iqd} amount_usd_cents={row.bought.amount_usd_cents} />,
    },
    { header: t('purchases:col_stock'), numeric: true, cell: (row) => <span data-tabular>{quantity(row, row.stock)}</span> },
  ];

  return (
    <TabFrame search={search} onSearch={setSearch} placeholder={t('purchases:search_materials')}>
      <QueryStates query={list} isEmpty={rows.length === 0} emptyTitle={t('purchases:empty_materials')} skeletonLines={4}>
        <DataList
          rows={rows}
          rowKey={(row) => row.id}
          href={(row) => `/materials/${row.id}`}
          columns={columns}
          card={(row) => (
            <span className="mz-rowcard">
              <span className="mz-rowcard__head">
                <span className="mz-list__title">
                  <bdi>{row.name}</bdi>
                </span>
                <Signed pair={row.profit} />
              </span>
              <span className="mz-caption" data-tabular>
                {t('purchases:col_sold_qty')}: {quantity(row, row.sold_qty)} · {t('purchases:col_bought_qty')}:{' '}
                {quantity(row, row.bought_qty)} · {t('purchases:col_stock')}: {quantity(row, row.stock)}
              </span>
              <span className="mz-rowcard__foot">
                <DualAmount amount_iqd={row.sold.amount_iqd} amount_usd_cents={row.sold.amount_usd_cents} />
              </span>
            </span>
          )}
        />
        <Pager
          page={paging.page}
          pageSize={paging.pageSize}
          total={list.data?.total ?? 0}
          onPage={paging.setPage}
          onPageSize={paging.setPageSize}
        />
      </QueryStates>
    </TabFrame>
  );
}

function ExpensesTab({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const wide = useIsWide();
  const queryClient = useQueryClient();
  const mayVoid = usePermission('expenses.void');
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search);
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<ExpenseRow | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const paging = usePaging({ storageKey: 'accounts-expenses', prefix: 'exp_', resetOn: [q, from, to] });
  const list = useQuery({
    queryKey: ['expenses', from, to, q, paging.page, paging.pageSize],
    queryFn: () =>
      apiRequest<{ items: ExpenseRow[]; total: number }>(
        `/expenses?from=${from}&to=${to}&q=${encodeURIComponent(q)}&${paging.query}`,
      ),
    placeholderData: keepPreviousData,
  });
  useKeepPageInRange(paging, list);
  const rows = list.data?.items ?? [];

  const refresh = async (message: string) => {
    setToast(message);
    await invalidateMoneyViews(queryClient);
  };

  const amount = (row: ExpenseRow) => (
    <DualAmount amount_iqd={row.amount_iqd} amount_usd_cents={row.amount_usd_cents} primary={row.entered_currency} />
  );
  const voidButton = (row: ExpenseRow) =>
    mayVoid ? (
      <Button variant="ghost" icon="trash" onClick={() => setVoiding(row)}>
        {t('purchases:void_expense')}
      </Button>
    ) : null;

  return (
    <TabFrame
      search={search}
      onSearch={setSearch}
      placeholder={t('purchases:search_expenses')}
      action={
        <Can permission="expenses.create">
          <Button icon="plus" onClick={() => setAdding(true)}>
            {t('purchases:add_expense')}
          </Button>
        </Can>
      }
    >
      <QueryStates query={list} isEmpty={rows.length === 0} emptyTitle={t('purchases:empty_expenses')} skeletonLines={4}>
        {/* Not a DataList: a row carries its own Void button, which a whole-row link would swallow. */}
        {wide ? (
          <div className="mz-table-wrap">
            <table className="mz-table mz-accounts__plain-table">
              <thead>
                <tr>
                  <th scope="col">{t('common:date')}</th>
                  <th scope="col">{t('purchases:col_expense')}</th>
                  <th scope="col">{t('glossary:done_by')}</th>
                  <th scope="col" data-numeric="true">
                    {t('purchases:col_amount')}
                  </th>
                  {mayVoid ? <th scope="col" aria-label={t('purchases:void_expense')} /> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td data-tabular>{formatter.date(row.expense_date)}</td>
                    <td>
                      <span className="mz-cell__body">
                        <strong>
                          <bdi>{row.title}</bdi>
                        </strong>
                        {row.note ? (
                          <span className="mz-caption">
                            <bdi>{row.note}</bdi>
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td>{row.created_by_name ? <bdi>{row.created_by_name}</bdi> : <span className="mz-muted">—</span>}</td>
                    <td data-numeric="true">{amount(row)}</td>
                    {mayVoid ? <td data-numeric="true">{voidButton(row)}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ul className="mz-list">
            {rows.map((row) => (
              <li key={row.id} className="mz-list__item">
                <span className="mz-rowcard">
                  <span className="mz-rowcard__head">
                    <span className="mz-list__title">
                      <bdi>{row.title}</bdi>
                    </span>
                    {amount(row)}
                  </span>
                  <span className="mz-caption">
                    {formatter.date(row.expense_date)}
                    {row.created_by_name ? (
                      <>
                        {' · '}
                        <bdi>{row.created_by_name}</bdi>
                      </>
                    ) : null}
                  </span>
                  {row.note ? (
                    <span className="mz-caption">
                      <bdi>{row.note}</bdi>
                    </span>
                  ) : null}
                  {voidButton(row)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Pager
          page={paging.page}
          pageSize={paging.pageSize}
          total={list.data?.total ?? 0}
          onPage={paging.setPage}
          onPageSize={paging.setPageSize}
        />
      </QueryStates>

      {adding ? (
        <AddExpenseSheet
          onClose={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false);
            await refresh(t('purchases:expense_saved'));
          }}
        />
      ) : null}
      {voiding ? (
        <VoidExpenseSheet
          expense={voiding}
          onClose={() => setVoiding(null)}
          onVoided={async () => {
            setVoiding(null);
            await refresh(t('purchases:expense_voided'));
          }}
        />
      ) : null}
      {toast ? <Toast message={toast} actionLabel={t('common:close')} onAction={() => setToast(null)} /> : null}
    </TabFrame>
  );
}

function AddExpenseSheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [date, setDate] = useState(formatter.today());
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [money, setMoney] = useState<MoneyValue>({ amount: null, currency: 'IQD', other_amount: null });

  // An expense is stored in both currencies at today's rate, so it waits for one to be set —
  // and says so under the amount, rather than leaving a Save button that silently never wakes.
  const { query: rateQuery, rate } = useGlobalRate();
  // Also when the rate could not be read (offline): the hint says why Save is waiting.
  const noRate = !rateQuery.isPending && rate === null;

  const save = useMutation({
    mutationFn: () =>
      apiRequest('/expenses', {
        method: 'POST',
        body: {
          expense_date: date,
          title: title.trim(),
          amount: { amount: money.amount, currency: money.currency, other_amount: money.other_amount ?? null },
          note: note.trim() || null,
        },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: onSaved,
  });

  const ready = rate !== null && title.trim() !== '' && money.amount !== null && money.amount > 0 && date !== '';

  return (
    <BottomSheet title={t('purchases:add_expense')} open onClose={onClose} closeLabel={t('common:close')}>
      <div className="mz-stack">
        <TextField
          label={t('purchases:expense_title')}
          placeholder={t('purchases:expense_title_hint')}
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
        />
        <MoneyInput
          label={t('purchases:expense_amount')}
          value={money}
          rate={rate}
          onChange={setMoney}
          hint={noRate ? t('common:rate_needed_first') : undefined}
        />
        <DateField
          label={t('purchases:expense_date')}
          value={date}
          max={formatter.today()}
          onChange={(event) => setDate(event.target.value)}
        />
        <TextField
          label={t('purchases:expense_note')}
          value={note}
          maxLength={2000}
          onChange={(event) => setNote(event.target.value)}
        />
        {save.error ? (
          <div className="mz-warning" role="alert">
            {errorMessage(t, save.error)}
          </div>
        ) : null}
        <Button block loading={save.isPending} disabled={!ready} onClick={() => save.mutate()}>
          {t('purchases:add_expense')}
        </Button>
      </div>
    </BottomSheet>
  );
}

function VoidExpenseSheet({
  expense,
  onClose,
  onVoided,
}: {
  expense: ExpenseRow;
  onClose: () => void;
  onVoided: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const voidIt = useMutation({
    mutationFn: () =>
      apiRequest(`/expenses/${expense.id}/void`, {
        method: 'POST',
        body: { reason: reason.trim(), version: expense.version },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: onVoided,
  });

  return (
    <BottomSheet title={t('purchases:void_expense_title')} open onClose={onClose} closeLabel={t('common:close')}>
      <div className="mz-stack">
        <p>
          <strong>
            <bdi>{expense.title}</bdi>
          </strong>
          {' — '}
          <DualAmount amount_iqd={expense.amount_iqd} amount_usd_cents={expense.amount_usd_cents} primary={expense.entered_currency} />
        </p>
        <p className="mz-muted">{t('purchases:void_expense_hint')}</p>
        <TextField
          label={t('glossary:reason')}
          value={reason}
          maxLength={2000}
          onChange={(event) => setReason(event.target.value)}
        />
        {voidIt.error ? (
          <div className="mz-warning" role="alert">
            {errorMessage(t, voidIt.error)}
          </div>
        ) : null}
        <Button
          block
          variant="danger"
          loading={voidIt.isPending}
          disabled={reason.trim() === ''}
          onClick={() => voidIt.mutate()}
        >
          {t('purchases:void_expense')}
        </Button>
      </div>
    </BottomSheet>
  );
}


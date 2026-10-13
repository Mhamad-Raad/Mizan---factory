import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, DateField, Icon, SegmentedControl, TextField, Toast } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { useIdempotencyKey } from '../lib/idempotency.js';
import { usePageTitle } from '../lib/page-title.js';
import { useDebouncedValue } from '../lib/debounce.js';
import { presetPeriod } from '../lib/periods.js';
import type { PeriodPreset } from '../lib/periods.js';
import { usePrint } from '../lib/print.js';
import { useApp, useFormatter } from '../lib/store.js';
import { errorMessage } from '../lib/errors.js';
import { invalidateMoneyViews } from '../lib/invalidate.js';
import { useKeepPageInRange, usePaging } from '../lib/paging.js';
import { Can } from '../components/Can.js';
import { QueryStates } from '../components/states.js';
import { DualAmount } from '../components/DualAmount.js';
import { KpiHead } from '../components/KpiHead.js';
import { OwedAmounts } from '../components/OwedAmounts.js';
import { Pager } from '../components/Pager.js';
import { PickerSheet } from '../components/PickerSheet.js';
import { PrintButton, usePrintSelection } from '../components/PrintSelection.js';
import { TradeTable } from '../components/TradeTable.js';
import type { TradeRow } from '../components/TradeTable.js';
import { OrderSaveWarningsNotice } from '../components/OrderSaveWarnings.js';
import type { OrderSaveWarnings } from '../components/OrderSaveWarnings.js';
import type { CustomerRow } from './CustomersPage.js';

type Kind = 'all' | 'sale' | 'purchase';
type DatePreset = 'all' | 'since_yesterday' | 'today' | 'week' | 'month' | 'last_month' | 'year' | 'custom';

/** Where the list opens: today and yesterday, as the orders list always has (FR-611). */
const OPENING_PERIOD: DatePreset = 'since_yesterday';
type Status = '' | 'owing' | 'unpaid' | 'partially_paid' | 'paid' | 'void';

interface Owed {
  companies: number;
  owed_iqd: number;
  owed_usd_cents: number;
}

/** The figures of the list; each is absent when the reader may not see it. */
interface TradeTotals {
  sales?: { count: number; total_iqd: number; total_usd_cents: number };
  purchases?: { count: number; cost?: { total_iqd: number; total_usd_cents: number } };
  owed_to_us?: Owed;
  owed_by_us?: Owed;
}

const KINDS: readonly Kind[] = ['all', 'sale', 'purchase'];

/**
 * Buying & selling (D-089): every sale and purchase on one page, newest first.
 *
 * A search box, and one Filters button that opens everything else under it — the period (with
 * dates of one's own), the company, who recorded it, the status, the payment type — so the page
 * reads calm until somebody narrows it; All · Sales · Purchases above the list switches the side.
 * Four small figures over the filter (how many sales and what they came to, how many purchases and
 * what they came to — never added together), then two large ones for the business as it stands:
 * what the companies owe us and what we owe them. A tick box on every row and one Print button.
 */
export function TradePage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const print = usePrint();
  const [params, setParams] = useSearchParams();
  const isAdmin = useApp((state) => state.user?.role === 'admin');
  const permissions = useApp((state) => state.permissions);
  const maySales = isAdmin || permissions.has('orders.view');
  // The company filter's picker reads the accounts with whichever key the reader holds: the
  // warehouse preset has `companies.view` and not `customers.view` (review).
  const companiesPath =
    isAdmin || permissions.has('customers.view') ? '/customers' : permissions.has('companies.view') ? '/companies' : null;
  const mayPurchases = isAdmin || permissions.has('purchases.view');

  // The side is in the address, so /orders and /purchases open this page on theirs.
  const asked = params.get('kind') as Kind | null;
  const kind: Kind = asked && KINDS.includes(asked) ? asked : 'all';
  const setKind = (next: Kind) =>
    setParams(
      (current) => {
        const copy = new URLSearchParams(current);
        if (next === 'all') copy.delete('kind');
        else copy.set('kind', next);
        return copy;
      },
      { replace: true },
    );

  // ── an order just saved (see OrderFormPage): its undo, and its receipt ──
  const savedOrder = (
    location.state as { savedOrder?: { id: string; number: number; warnings?: OrderSaveWarnings } } | null
  )?.savedOrder;
  const [saveWarnings] = useState(() => savedOrder?.warnings ?? null);
  const [toast, setToast] = useState<{ message: string; orderId: string } | null>(() =>
    savedOrder
      ? { message: t('orders:saved', { number: formatter.identifier(savedOrder.number) }), orderId: savedOrder.id }
      : null,
  );
  useEffect(() => {
    if (savedOrder) navigate(location.pathname + location.search, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 8000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const undoKey = useIdempotencyKey(`undo:${toast?.orderId ?? ''}`);
  const undo = useMutation({
    mutationFn: (orderId: string) =>
      apiRequest(`/orders/${orderId}/undo`, { method: 'POST', body: {}, idempotencyKey: undoKey.key }),
    onSuccess: async () => {
      undoKey.renew();
      setToast(null);
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
      await queryClient.invalidateQueries({ queryKey: ['trade'] });
      await queryClient.invalidateQueries({ queryKey: ['items'] });
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
      await invalidateMoneyViews(queryClient);
    },
  });

  // ── the filters ──
  const [search, setSearch] = useState('');
  const query = useDebouncedValue(search);
  const [open, setOpen] = useState(false);
  const [datePreset, setDatePreset] = useState<DatePreset>(OPENING_PERIOD);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [pickingCompany, setPickingCompany] = useState(false);
  const [doneBy, setDoneBy] = useState('');
  const [status, setStatus] = useState<Status>('');
  const [paymentType, setPaymentType] = useState<'' | 'cash' | 'borrowed'>('');

  const today = formatter.today();
  const range =
    datePreset === 'custom'
      ? { from: customFrom || undefined, to: customTo || undefined }
      : presetPeriod(datePreset as PeriodPreset, today);
  // How many of the panel's filters are set, on its button, so a narrowed list says so.
  const activeFilters = [
    datePreset !== OPENING_PERIOD,
    companyId !== '',
    doneBy !== '',
    status !== '',
    paymentType !== '',
  ].filter(Boolean).length;
  const clearFilters = () => {
    setDatePreset(OPENING_PERIOD);
    setCustomFrom('');
    setCustomTo('');
    setCompanyId('');
    setCompanyName('');
    setDoneBy('');
    setStatus('');
    setPaymentType('');
  };

  const filters = new URLSearchParams();
  if (kind !== 'all') filters.set('kind', kind);
  if (range.from) filters.set('from', range.from);
  if (range.to) filters.set('to', range.to);
  if (query) filters.set('q', query);
  if (companyId) filters.set('company_id', companyId);
  if (doneBy) filters.set('done_by', doneBy);
  if (status) filters.set('status', status);
  if (paymentType) filters.set('payment_type', paymentType);
  const filterQuery = filters.toString();

  const paging = usePaging({ storageKey: 'trade', resetOn: [filterQuery] });
  const list = useQuery({
    queryKey: ['trade', filterQuery, paging.page, paging.pageSize],
    queryFn: () =>
      apiRequest<{ items: TradeRow[]; total: number; totals?: TradeTotals }>(
        `/trade?${filterQuery}${filterQuery ? '&' : ''}${paging.query}`,
      ),
    placeholderData: keepPreviousData,
  });
  useKeepPageInRange(paging, list);
  const refreshing = list.isFetching && list.isPlaceholderData;

  const directory = useQuery({
    queryKey: ['users', 'directory'],
    queryFn: () => apiRequest<{ id: string; display_name: string; is_active: boolean }[]>('/users/directory'),
  });

  const selecting = usePrintSelection<TradeRow>(
    (row) => (row.kind === 'sale' ? { kind: 'order', id: row.id } : { kind: 'purchase', id: row.id }),
    (row) => `${row.kind}:${row.id}`,
  );

  const rows = list.data?.items ?? [];
  const totals = list.data?.totals;
  // A paid state or a payment type asks about sales alone (D-089): said, so an empty purchases
  // side does not read as "no purchases".
  const saleOnlyFilter = status !== '' && status !== 'void' ? true : paymentType !== '';

  usePageTitle(t('trade:title'));

  const newButtons = (
    <span className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
      <Can permission="purchases.create">
        <Link to="/purchases/new" className="mz-button mz-button--money-out">
          <Icon name="money-out" />
          {t('purchases:new_purchase')}
        </Link>
      </Can>
      <Can permission="orders.create">
        <Link to="/orders/new" className="mz-button mz-button--money-in">
          <Icon name="money-in" />
          {t('trade:new_sale')}
        </Link>
      </Can>
    </span>
  );

  return (
    <>
      <div className="mz-stack">
        <OrderSaveWarningsNotice warnings={saveWarnings} />
        {errorMessage(t, undo.error) ? (
          <div className="mz-warning" role="alert">
            {errorMessage(t, undo.error)}
          </div>
        ) : null}

        {/* The search, the Filters button, and the two ways to start a document. */}
        <div className="mz-toolbar">
          <div className="mz-toolbar__filters">
            <div className="mz-toolbar__search">
              <TextField
                label={t('common:search')}
                placeholder={t('trade:search_hint')}
                value={search}
                type="search"
                inputMode="search"
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <Button
              variant="secondary"
              icon="filter"
              aria-expanded={open}
              aria-controls="trade-filters"
              onClick={() => setOpen(!open)}
            >
              {activeFilters > 0 ? t('trade:filters_count', { count: activeFilters }) : t('trade:filters')}
            </Button>
          </div>
          {newButtons}
        </div>

        {/* Everything that narrows the list, under the search, opened by its button. */}
        {open ? (
          <div id="trade-filters" className="mz-filter-panel" role="region" aria-label={t('trade:filters')}>
            <div className="mz-filter-panel__grid">
              <label className="mz-field">
                <span className="mz-field__label">{t('trade:period')}</span>
                <select
                  className="mz-select mz-select--field"
                  value={datePreset}
                  onChange={(event) => setDatePreset(event.target.value as DatePreset)}
                >
                  <option value="since_yesterday">{t('trade:period_since_yesterday')}</option>
                  <option value="today">{t('common:today')}</option>
                  <option value="week">{t('common:this_week')}</option>
                  <option value="month">{t('common:this_month')}</option>
                  <option value="last_month">{t('purchases:period_last_month')}</option>
                  <option value="year">{t('purchases:period_this_year')}</option>
                  <option value="all">{t('orders:any_date')}</option>
                  <option value="custom">{t('purchases:period_custom')}</option>
                </select>
              </label>
              {datePreset === 'custom' ? (
                <>
                  <DateField
                    label={t('print:statement_from')}
                    value={customFrom}
                    max={customTo || today}
                    onChange={(event) => setCustomFrom(event.target.value)}
                  />
                  <DateField
                    label={t('print:statement_to')}
                    value={customTo}
                    min={customFrom || undefined}
                    max={today}
                    onChange={(event) => setCustomTo(event.target.value)}
                  />
                </>
              ) : null}
              {companiesPath ? (
                <div className="mz-field">
                  <span className="mz-field__label">{t('glossary:company')}</span>
                  <span className="mz-filter-panel__company">
                    <Button variant="secondary" icon="companies" onClick={() => setPickingCompany(true)}>
                      <bdi>{companyId ? companyName : t('trade:any_company')}</bdi>
                    </Button>
                    {companyId ? (
                      <Button variant="ghost" onClick={() => setCompanyId('')}>
                        {t('trade:remove_company')}
                      </Button>
                  ) : null}
                </span>
              </div>
              ) : null}
              <label className="mz-field">
                <span className="mz-field__label">{t('trade:recorded_by')}</span>
                <select className="mz-select mz-select--field" value={doneBy} onChange={(event) => setDoneBy(event.target.value)}>
                  <option value="">{t('orders:anyone')}</option>
                  {(directory.data ?? [])
                    .filter((user) => user.is_active)
                    .map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.display_name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="mz-field">
                <span className="mz-field__label">{t('common:status')}</span>
                <select className="mz-select mz-select--field" value={status} onChange={(event) => setStatus(event.target.value as Status)}>
                  <option value="">{t('trade:any_status')}</option>
                  {/* The paid states are a sale's: not offered to whoever cannot see sales. */}
                  {maySales ? (
                    <>
                      <option value="owing">{t('trade:status_owing')}</option>
                      <option value="unpaid">{t('glossary:unpaid')}</option>
                      <option value="partially_paid">{t('glossary:partially_paid')}</option>
                      <option value="paid">{t('glossary:paid')}</option>
                    </>
                  ) : null}
                  <option value="void">{t('glossary:void')}</option>
                </select>
              </label>
              {maySales ? (
                <label className="mz-field">
                  <span className="mz-field__label">{t('glossary:payment_type')}</span>
                  <select
                    className="mz-select mz-select--field"
                    value={paymentType}
                    onChange={(event) => setPaymentType(event.target.value as typeof paymentType)}
                  >
                    <option value="">{t('orders:all_payments')}</option>
                    <option value="cash">{t('glossary:cash')}</option>
                    <option value="borrowed">{t('glossary:borrowed')}</option>
                  </select>
                </label>
              ) : null}
            </div>
            <div className="mz-filter-panel__foot">
              {saleOnlyFilter && kind !== 'sale' ? (
                <span className="mz-caption">{t('trade:sales_only_hint')}</span>
              ) : (
                <span />
              )}
              {activeFilters > 0 ? (
                <Button variant="ghost" onClick={clearFilters}>
                  {t('trade:clear_filters')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* All · Sales · Purchases — offered only to someone who may see both sides. */}
        {maySales && mayPurchases ? (
          <SegmentedControl
            label={t('trade:show')}
            hideLabel
            value={kind}
            onChange={setKind}
            options={[
              { value: 'all', label: t('trade:kind_all') },
              { value: 'sale', label: t('trade:kind_sales') },
              { value: 'purchase', label: t('trade:kind_purchases') },
            ]}
          />
        ) : null}

        {/* Four figures over the filter — the two sides never added together — and two for the
            business as it stands. */}
        {totals ? (
          <>
            <div className="mz-kpis">
              {totals.sales ? (
                <>
                  <div className="mz-kpi">
                    <KpiHead icon="orders" label={t('trade:tile_sales')} />
                    <span className="mz-kpi__count" data-tabular>
                      {formatter.number(totals.sales.count)}
                    </span>
                  </div>
                  <div className="mz-kpi">
                    <KpiHead icon="money-in" label={t('trade:tile_sold')} />
                    <DualAmount amount_iqd={totals.sales.total_iqd} amount_usd_cents={totals.sales.total_usd_cents} />
                  </div>
                </>
              ) : null}
              {totals.purchases ? (
                <>
                  <div className="mz-kpi">
                    <KpiHead icon="purchases" label={t('trade:tile_purchases')} />
                    <span className="mz-kpi__count" data-tabular>
                      {formatter.number(totals.purchases.count)}
                    </span>
                  </div>
                  {totals.purchases.cost ? (
                    <div className="mz-kpi">
                      <KpiHead icon="money-out" label={t('trade:tile_bought')} />
                      <DualAmount
                        amount_iqd={totals.purchases.cost.total_iqd}
                        amount_usd_cents={totals.purchases.cost.total_usd_cents}
                      />
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
            {totals.owed_to_us || totals.owed_by_us ? (
              <div className="mz-kpis mz-kpis--two">
                {totals.owed_to_us ? (
                  <Link to="/customers?balance=owes&inactive=1" className="mz-kpi mz-kpi--big mz-kpi--in mz-card-link">
                    <KpiHead icon="money-in" label={t('trade:tile_owed_to_us')} />
                    <span className="mz-caption">
                      {t('purchases:tile_we_owe_count', { count: totals.owed_to_us.companies })}
                    </span>
                    <OwedAmounts
                      size="large"
                      owed={{ amount_iqd: totals.owed_to_us.owed_iqd, amount_usd_cents: totals.owed_to_us.owed_usd_cents }}
                    />
                  </Link>
                ) : null}
                {totals.owed_by_us ? (
                  <Link to="/customers?balance=we_owe&inactive=1" className="mz-kpi mz-kpi--big mz-kpi--out mz-card-link">
                    <KpiHead icon="money-out" label={t('purchases:tile_we_owe')} />
                    <span className="mz-caption">
                      {t('purchases:tile_we_owe_count', { count: totals.owed_by_us.companies })}
                    </span>
                    <OwedAmounts
                      size="large"
                      owed={{ amount_iqd: totals.owed_by_us.owed_iqd, amount_usd_cents: totals.owed_by_us.owed_usd_cents }}
                    />
                  </Link>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}

        {rows.length > 0 ? (
          <PrintButton state={selecting} />
        ) : null}

        <QueryStates
          query={list}
          isEmpty={rows.length === 0}
          emptyTitle={query.trim() ? t('orders:empty_search', { query: query.trim() }) : t('trade:empty')}
          emptyAction={newButtons}
        >
          <div className="mz-refreshable" data-busy={refreshing ? 'true' : undefined} aria-busy={refreshing}>
            <TradeTable rows={rows} selection={selecting.selection} />
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

      {pickingCompany ? (
        <PickerSheet
          title={t('trade:choose_company')}
          open
          onClose={() => setPickingCompany(false)}
          path={companiesPath ?? '/customers'}
          icon="companies"
          searchLabel={t('customers:search_placeholder')}
          emptyTitle={t('customers:empty')}
          toItem={(row: never) => {
            const account = row as unknown as CustomerRow;
            return { id: account.id, title: account.name, subtitle: account.phone ?? undefined };
          }}
          onPick={(id, row) => {
            setPickingCompany(false);
            setCompanyId(id);
            setCompanyName((row as unknown as CustomerRow).name);
          }}
        />
      ) : null}

      {toast ? (
        <Toast
          message={toast.message}
          actionLabel={t('common:undo')}
          onAction={() => undo.mutate(toast.orderId)}
          secondaryLabel={t('print:print_receipt')}
          onSecondary={() => print([{ kind: 'order', id: toast.orderId }])}
        />
      ) : null}
    </>
  );
}

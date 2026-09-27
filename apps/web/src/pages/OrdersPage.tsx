import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon, TextField, Toast } from '@mizan/ui';
import type { Currency, Rate, RateSource } from '@mizan/money';
import { apiRequest, newIdempotencyKey } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { Can } from '../components/Can.js';
import { QueryStates } from '../components/states.js';
import { DualAmount } from '../components/DualAmount.js';
import { FilterChip } from './MaterialsPage.js';
import { useFormatter } from '../lib/store.js';
import { OrderTable } from '../components/OrderTable.js';
import { Pager } from '../components/Pager.js';
import { usePaging } from '../lib/paging.js';

export interface OrderRow {
  id: string;
  number: number;
  customer_id: string;
  customer_name: string;
  customer_is_system: boolean;
  settlement_currency: Currency;
  order_date: string;
  payment_type: 'cash' | 'borrowed';
  acting_user_name: string | null;
  notes: string | null;
  rate_iqd_per_usd: Rate;
  rate_source: RateSource;
  discount_iqd: number;
  discount_usd_cents: number;
  total_iqd: number;
  total_usd_cents: number;
  status: 'unpaid' | 'partially_paid' | 'paid' | 'void';
  doc_status: 'active' | 'void';
  void_reason: string | null;
  remaining: number;
  received_currency: Currency | null;
  version: number;
}

type DateChip = 'today' | 'week' | 'month' | 'all';

/** The list's figures over the whole filter; `balance` is absent without the balances flag. */
interface OrderTotals {
  orders: number;
  total_iqd: number;
  total_usd_cents: number;
  balance?: { owing: number; owed_iqd: number; owed_usd_cents: number } | null;
}

/**
 * The Orders page (FR-611). It opens on today and yesterday, newest first, because that is
 * what an employee needs when they pick up the phone; everything else is one chip away.
 */
export function OrdersPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  // A just-saved order arrives in the navigation state (see OrderFormPage). Read it once, up front,
  // so the save toast (with its 8-second undo, FR-610) shows the moment the list mounts.
  const savedOrder = (location.state as { savedOrder?: { id: string; number: number } } | null)
    ?.savedOrder;

  const [chip, setChip] = useState<DateChip>('today');
  const [unpaidOnly, setUnpaidOnly] = useState(false);
  const [paymentType, setPaymentType] = useState<'all' | 'cash' | 'borrowed'>('all');
  const [doneBy, setDoneBy] = useState('');
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState<{ message: string; orderId: string } | null>(() =>
    savedOrder
      ? { message: t('orders:saved', { number: formatter.identifier(savedOrder.number) }), orderId: savedOrder.id }
      : null,
  );

  // Wipe the history entry so a refresh or back-nav does not repeat the toast (no setState here).
  useEffect(() => {
    if (savedOrder) navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Let the toast fade after its undo window; the timer callback is the only place state changes.
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 8000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const undo = useMutation({
    mutationFn: (orderId: string) =>
      apiRequest(`/orders/${orderId}/undo`, {
        method: 'POST',
        body: {},
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      setToast(null);
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
      await queryClient.invalidateQueries({ queryKey: ['items'] });
    },
  });

  const range = rangeOf(chip, formatter.today());
  const paging = usePaging({ storageKey: 'orders', resetOn: [chip, unpaidOnly, paymentType, doneBy, query] });

  const orders = useQuery({
    queryKey: ['orders', chip, unpaidOnly, paymentType, doneBy, query, paging.page, paging.pageSize],
    queryFn: () => {
      const params = new URLSearchParams();
      if (range.from) params.set('from', range.from);
      if (range.to) params.set('to', range.to);
      // "Unpaid" is every order still owing something — unpaid or partly paid (client review).
      if (unpaidOnly) params.set('status', 'owing');
      if (paymentType !== 'all') params.set('payment_type', paymentType);
      if (doneBy) params.set('done_by', doneBy);
      if (query) params.set('q', query);
      return apiRequest<{ items: OrderRow[]; total: number; totals: OrderTotals }>(
        `/orders?${params.toString()}&${paging.query}`,
      );
    },
    // Keep the current rows on screen while a filter change refetches, so the table dims for a
    // moment instead of collapsing to a skeleton on every keystroke or dropdown change.
    placeholderData: keepPreviousData,
  });
  const refreshing = orders.isFetching && orders.isPlaceholderData;

  const directory = useQuery({
    queryKey: ['users', 'directory'],
    queryFn: () =>
      apiRequest<{ id: string; display_name: string; is_active: boolean }[]>('/users/directory'),
  });

  const rows = orders.data?.items ?? [];
  const totals = orders.data?.totals;

  usePageTitle(t('orders:title'));

  return (
    <>
      <div className="mz-stack">
        <div className="mz-toolbar">
          <div className="mz-toolbar__filters">
            <div className="mz-toolbar__search">
              <TextField
                label={t('common:search')}
                placeholder={t('orders:search_hint')}
                value={query}
                type="search"
                inputMode="search"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <select
              className="mz-select"
              aria-label={t('common:date')}
              value={chip}
              onChange={(event) => setChip(event.target.value as DateChip)}
            >
              <option value="today">{t('common:today')}</option>
              <option value="week">{t('common:this_week')}</option>
              <option value="month">{t('common:this_month')}</option>
              <option value="all">{t('orders:any_date')}</option>
            </select>
            <select
              className="mz-select"
              aria-label={t('glossary:payment_type')}
              value={paymentType}
              onChange={(event) => setPaymentType(event.target.value as typeof paymentType)}
            >
              <option value="all">{t('orders:all_payments')}</option>
              <option value="cash">{t('glossary:cash')}</option>
              <option value="borrowed">{t('glossary:borrowed')}</option>
            </select>
            <select
              className="mz-select"
              aria-label={t('glossary:done_by')}
              value={doneBy}
              onChange={(event) => setDoneBy(event.target.value)}
            >
              <option value="">{t('orders:anyone')}</option>
              {(directory.data ?? [])
                .filter((user) => user.is_active)
                .map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.display_name}
                  </option>
                ))}
            </select>
            <FilterChip active={unpaidOnly} onClick={() => setUnpaidOnly(!unpaidOnly)}>
              {t('glossary:unpaid')}
            </FilterChip>
          </div>

          <Can permission="orders.create">
            <Link to="/orders/new" className="mz-button mz-button--primary">
              <Icon name="plus" />
              {t('orders:new_order')}
            </Link>
          </Can>
        </div>

        {/* The figures of the whole filter (client review), as the other lists have them: how
            many orders, what they came to, and what is still to collect — that last card is
            also the "Unpaid" filter. */}
        {totals ? (
          <div className="mz-kpis mz-kpis--three">
            <div className="mz-kpi">
              <span className="mz-kpi__head">
                <span className="mz-kpi__icon" aria-hidden="true">
                  <Icon name="orders" size={18} />
                </span>
                <span className="mz-caption">{t('orders:tile_orders')}</span>
              </span>
              <span className="mz-kpi__count" data-tabular>
                {formatter.number(totals.orders)}
              </span>
            </div>
            <div className="mz-kpi">
              <span className="mz-kpi__head">
                <span className="mz-kpi__icon" aria-hidden="true">
                  <Icon name="chart" size={18} />
                </span>
                <span className="mz-caption">{t('orders:tile_sold')}</span>
              </span>
              <DualAmount amount_iqd={totals.total_iqd} amount_usd_cents={totals.total_usd_cents} />
            </div>
            {/* What is owed, and how many orders owe it, belong to the balances flag (2.6.2). */}
            {totals.balance ? (
              <button
                type="button"
                className="mz-kpi mz-kpi--button"
                aria-pressed={unpaidOnly}
                onClick={() => setUnpaidOnly(!unpaidOnly)}
              >
                <span className="mz-kpi__head">
                  <span className="mz-kpi__icon" aria-hidden="true">
                    <Icon name="clock" size={18} />
                  </span>
                  <span className="mz-caption">{t('orders:tile_to_collect')}</span>
                </span>
                <span className="mz-kpi__count" data-tabular>
                  {formatter.number(totals.balance.owing)}
                </span>
                <span className="mz-owed">
                  <DualAmount amount_iqd={totals.balance.owed_iqd} amount_usd_cents={totals.balance.owed_usd_cents} />
                </span>
              </button>
            ) : null}
          </div>
        ) : null}

        <QueryStates
          query={orders}
          isEmpty={rows.length === 0}
          emptyTitle={t('orders:empty')}
          emptyAction={
            <Can permission="orders.create">
              <Link to="/orders/new" className="mz-button mz-button--primary">
                {t('orders:new_order')}
              </Link>
            </Can>
          }
        >
          <div className="mz-refreshable" data-busy={refreshing ? 'true' : undefined} aria-busy={refreshing}>
          <OrderTable rows={rows} />
          </div>
          <Pager
            page={paging.page}
            pageSize={paging.pageSize}
            total={orders.data?.total ?? 0}
            onPage={paging.setPage}
            onPageSize={paging.setPageSize}
          />
        </QueryStates>
      </div>

      {toast ? (
        <Toast
          message={toast.message}
          actionLabel={t('common:undo')}
          onAction={() => undo.mutate(toast.orderId)}
        />
      ) : null}
    </>
  );
}

/**
 * Today and yesterday by default (FR-611); the week chip widens it to seven days, and "This
 * month" is the calendar month — the 1st to today — as on the Accounts page, so the Sold card
 * here and the Sold figure there agree (it was the last 30 days, which reached into last month).
 */
function rangeOf(chip: DateChip, today: string): { from?: string; to?: string } {
  if (chip === 'all') return {};
  if (chip === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  const to = today;
  const days = chip === 'today' ? 1 : 7;
  const from = new Date(`${today}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - days);
  return { from: from.toISOString().slice(0, 10), to };
}

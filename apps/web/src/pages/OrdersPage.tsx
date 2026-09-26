import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon, TextField, Toast } from '@mizan/ui';
import type { Currency, Rate, RateSource } from '@mizan/money';
import { apiRequest, newIdempotencyKey } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { Can } from '../components/Can.js';
import { DualAmount } from '../components/DualAmount.js';
import { QueryStates } from '../components/states.js';
import { OrderStatusChip, PaymentTypeChip } from '../components/chips.js';
import { FilterChip } from './MaterialsPage.js';
import { customerName } from '../lib/customers.js';
import { useFormatter } from '../lib/store.js';
import { DataList } from '../components/DataList.js';

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
      ? { message: t('orders:saved', { number: formatter.number(savedOrder.number) }), orderId: savedOrder.id }
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

  const orders = useQuery({
    queryKey: ['orders', chip, unpaidOnly, paymentType, doneBy, query],
    queryFn: () => {
      const params = new URLSearchParams();
      if (range.from) params.set('from', range.from);
      if (range.to) params.set('to', range.to);
      if (unpaidOnly) params.set('status', 'unpaid');
      if (paymentType !== 'all') params.set('payment_type', paymentType);
      if (doneBy) params.set('done_by', doneBy);
      if (query) params.set('q', query);
      return apiRequest<{ items: OrderRow[]; total: number }>(`/orders?${params.toString()}`);
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
          <DataList
            rows={rows}
            rowKey={(order) => order.id}
            href={(order) => `/orders/${order.id}`}
            columns={[
              {
                // Order number over its date, so a row is anchored by what people call it.
                header: t('common:number_column'),
                cell: (order) => (
                  <span className="mz-cell__body">
                    <strong>{t('orders:number', { number: formatter.number(order.number) })}</strong>
                    <span className="mz-caption">{formatter.date(order.order_date)}</span>
                  </span>
                ),
              },
              {
                // Customer, with who recorded the sale beneath it.
                header: t('glossary:customer'),
                cell: (order) => (
                  <span className="mz-cell__body">
                    <span>
                      {customerName(
                        { name: order.customer_name, is_system: order.customer_is_system },
                        t,
                      )}
                    </span>
                    {order.acting_user_name ? (
                      <span
                        className="mz-caption"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                      >
                        <Icon name="user" size={12} />
                        {order.acting_user_name}
                      </span>
                    ) : null}
                  </span>
                ),
              },
              {
                header: t('glossary:total'),
                numeric: true,
                cell: (order) => (
                  <DualAmount
                    amount_iqd={order.total_iqd}
                    amount_usd_cents={order.total_usd_cents}
                    primary={order.settlement_currency}
                  />
                ),
              },
              {
                // What is still owed — the number an office actually chases.
                header: t('orders:remaining'),
                numeric: true,
                cell: (order) =>
                  order.remaining > 0 ? (
                    <span className="mz-owed" data-tabular>
                      {formatter.money(order.remaining, order.settlement_currency)}
                    </span>
                  ) : (
                    <span className="mz-muted">—</span>
                  ),
              },
              {
                header: t('glossary:payment_type'),
                secondary: true,
                cell: (order) => <PaymentTypeChip type={order.payment_type} />,
              },
              { header: t('common:status'), cell: (order) => <OrderStatusChip status={order.status} /> },
            ]}
            card={(order) => (
              <span className="mz-rowcard">
                <span className="mz-rowcard__head">
                  <span className="mz-list__title">
                    {t('orders:number', { number: formatter.number(order.number) })}
                  </span>
                  <span className="mz-rowcard__chips">
                    <PaymentTypeChip type={order.payment_type} />
                    <OrderStatusChip status={order.status} />
                  </span>
                </span>
                <span className="mz-caption">
                  <bdi>{customerName({ name: order.customer_name, is_system: order.customer_is_system }, t)}</bdi>
                  {' · '}
                  {formatter.date(order.order_date)}
                  {order.acting_user_name ? (
                    <>
                      {' · '}
                      <bdi>{order.acting_user_name}</bdi>
                    </>
                  ) : null}
                </span>
                <span className="mz-rowcard__foot">
                  <DualAmount
                    amount_iqd={order.total_iqd}
                    amount_usd_cents={order.total_usd_cents}
                    primary={order.settlement_currency}
                  />
                  {order.remaining > 0 ? (
                    <span className="mz-caption mz-owed" data-tabular>
                      {t('orders:remaining')}: {formatter.money(order.remaining, order.settlement_currency)}
                    </span>
                  ) : null}
                </span>
              </span>
            )}
          />
          </div>
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

/** Today and yesterday by default (FR-611); the week and month chips widen it. */
function rangeOf(chip: DateChip, today: string): { from?: string; to?: string } {
  if (chip === 'all') return {};
  const to = today;
  const days = chip === 'today' ? 1 : chip === 'week' ? 7 : 30;
  const from = new Date(`${today}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - days);
  return { from: from.toISOString().slice(0, 10), to };
}

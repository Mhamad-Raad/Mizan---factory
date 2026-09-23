import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { BottomSheet, Button, TextField } from '@mizan/ui';
import type { Currency, Rate, RateSource } from '@mizan/money';
import { apiRequest } from '../lib/api.js';
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
  const [chip, setChip] = useState<DateChip>('today');
  const [unpaidOnly, setUnpaidOnly] = useState(false);
  const [filters, setFilters] = useState(false);
  const [paymentType, setPaymentType] = useState<'all' | 'cash' | 'borrowed'>('all');
  const [doneBy, setDoneBy] = useState('');
  const [query, setQuery] = useState('');

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
  });

  const directory = useQuery({
    queryKey: ['users', 'directory'],
    queryFn: () => apiRequest<{ id: string; display_name: string; is_active: boolean }[]>('/users/directory'),
    enabled: filters,
  });

  const rows = orders.data?.items ?? [];

  usePageTitle(t('orders:title'));

  return (
    <>
      <div className="mz-stack">
        <div className="mz-toolbar">
        <div className="mz-toolbar__filters">
          <FilterChip active={chip === 'today'} onClick={() => setChip('today')}>
            {t('common:today')}
          </FilterChip>
          <FilterChip active={chip === 'week'} onClick={() => setChip('week')}>
            {t('common:this_week')}
          </FilterChip>
          <FilterChip active={chip === 'month'} onClick={() => setChip('month')}>
            {t('common:this_month')}
          </FilterChip>
          <FilterChip active={unpaidOnly} onClick={() => setUnpaidOnly(!unpaidOnly)}>
            {t('glossary:unpaid')}
          </FilterChip>
          <FilterChip active={filters} onClick={() => setFilters(true)}>
            {t('orders:more_filters')}
          </FilterChip>
        </div>

        <Can permission="orders.create">
          <Link to="/orders/new" className="mz-button mz-button--primary mz-button--block">
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
          <DataList
            rows={rows}
            rowKey={(order) => order.id}
            href={(order) => `/orders/${order.id}`}
            columns={[
              {
                header: t('common:number_column'),
                cell: (order) => t('orders:number', { number: formatter.number(order.number) }),
              },
              {
                header: t('glossary:customer'),
                cell: (order) =>
                  customerName({ name: order.customer_name, is_system: order.customer_is_system }, t),
              },
              { header: t('glossary:date_sold'), cell: (order) => formatter.date(order.order_date) },
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
                header: t('glossary:payment_type'),
                secondary: true,
                cell: (order) => <PaymentTypeChip type={order.payment_type} />,
              },
              { header: t('common:status'), cell: (order) => <OrderStatusChip status={order.status} /> },
            ]}
            card={(order) => (
              <>
                <span className="mz-list__body">
                  <span className="mz-list__title">
                    {t('orders:number', { number: formatter.number(order.number) })}
                  </span>
                  <span className="mz-caption" style={{ display: 'block' }}>
                    {customerName({ name: order.customer_name, is_system: order.customer_is_system }, t)} ·{' '}
                    {formatter.date(order.order_date)}
                  </span>
                  <DualAmount
                    amount_iqd={order.total_iqd}
                    amount_usd_cents={order.total_usd_cents}
                    primary={order.settlement_currency}
                  />
                </span>
                <span className="mz-row" style={{ gap: 'var(--space-1)' }}>
                  <PaymentTypeChip type={order.payment_type} />
                  <OrderStatusChip status={order.status} />
                </span>
              </>
            )}
          />
        </QueryStates>

        {filters ? (
          <BottomSheet title={t('orders:more_filters')} open onClose={() => setFilters(false)} closeLabel={t('common:close')}>
            <div className="mz-stack">
              <TextField
                label={t('common:search')}
                hint={t('orders:search_hint')}
                value={query}
                type="search"
                onChange={(event) => setQuery(event.target.value)}
              />
              <label className="mz-field">
                <span className="mz-field__label">{t('glossary:payment_type')}</span>
                <select
                  className="mz-field__control"
                  value={paymentType}
                  onChange={(event) => setPaymentType(event.target.value as typeof paymentType)}
                >
                  <option value="all">{t('common:all')}</option>
                  <option value="cash">{t('glossary:cash')}</option>
                  <option value="borrowed">{t('glossary:borrowed')}</option>
                </select>
              </label>
              <label className="mz-field">
                <span className="mz-field__label">{t('glossary:done_by')}</span>
                <select className="mz-field__control" value={doneBy} onChange={(event) => setDoneBy(event.target.value)}>
                  <option value="">{t('common:all')}</option>
                  {(directory.data ?? []).map((user) => (
                    <option key={user.id} value={user.id}>
                      <bdi>{user.display_name}</bdi>
                    </option>
                  ))}
                </select>
              </label>
              <FilterChip active={chip === 'all'} onClick={() => setChip('all')}>
                {t('orders:any_date')}
              </FilterChip>
              <Button block onClick={() => setFilters(false)}>
                {t('common:close')}
              </Button>
            </div>
          </BottomSheet>
        ) : null}
      </div>
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

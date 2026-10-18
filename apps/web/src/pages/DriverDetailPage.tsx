import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet, Button, Card, Chip, Icon, SegmentedControl } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { useIdempotencyKey } from '../lib/idempotency.js';
import { usePageTitle } from '../lib/page-title.js';
import { errorMessage } from '../lib/errors.js';
import { invalidateHistory } from '../lib/invalidate.js';
import { useCursorPaging, useKeepPageInRange, usePaging } from '../lib/paging.js';
import { presetPeriod } from '../lib/periods.js';
import { useFormatter, usePermission } from '../lib/store.js';
import type { DriverRow } from '../lib/drivers.js';
import type { OrderRow } from '../lib/orders.js';
import { AuditDiff } from '../components/AuditDiff.js';
import { Can } from '../components/Can.js';
import { DriverSheet } from '../components/DriverSheet.js';
import { DualAmount } from '../components/DualAmount.js';
import { InactiveChip } from '../components/chips.js';
import { KpiHead } from '../components/KpiHead.js';
import { OrderTable } from '../components/OrderTable.js';
import { Pager } from '../components/Pager.js';
import { PrintButton, usePrintSelection } from '../components/PrintSelection.js';
import { QueryStates } from '../components/states.js';
import { SavedToast } from '../components/SavedToast.js';
import type { SavedNotice } from '../components/SavedToast.js';

type Tab = 'orders' | 'history';
type Period = 'all' | 'today' | 'week' | 'month' | 'last_month' | 'year';

interface HistoryRow {
  id: string;
  action: string;
  occurred_at: string;
  actor_display_name: string | null;
  note: string | null;
  changes: Record<string, unknown> | null;
}

/**
 * One driver (D-105): who they are — name, phone, car — with Edit and Deactivate beside the name,
 * and below it every order they took, newest first, for the period chosen, with how many and what
 * they came to. A History tab says who changed the driver and when (rule 3).
 */
export function DriverDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const formatter = useFormatter();
  const queryClient = useQueryClient();
  const mayViewOrders = usePermission('orders.view');
  const [tab, setTab] = useState<Tab>(mayViewOrders ? 'orders' : 'history');
  const [period, setPeriod] = useState<Period>('all');
  const [editing, setEditing] = useState(false);
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false);
  const [notice, setNotice] = useState<SavedNotice | null>(null);
  const dismissNotice = useCallback(() => setNotice(null), []);

  const driver = useQuery({
    queryKey: ['drivers', id],
    queryFn: () => apiRequest<DriverRow>(`/drivers/${id}`),
  });
  const data = driver.data;

  const range = presetPeriod(period, formatter.today());
  const filter = new URLSearchParams({ driver_id: id });
  if (range.from) filter.set('from', range.from);
  if (range.to) filter.set('to', range.to);
  const ordersPaging = usePaging({
    storageKey: 'driver-orders',
    prefix: 'orders_',
    resetOn: [id, period],
  });
  const orders = useQuery({
    queryKey: ['orders', 'driver', id, period, ordersPaging.page, ordersPaging.pageSize],
    queryFn: () =>
      apiRequest<{
        items: OrderRow[];
        total: number;
        totals?: { orders: number; total_iqd: number; total_usd_cents: number };
      }>(`/orders?${filter.toString()}&${ordersPaging.query}`),
    enabled: mayViewOrders && tab === 'orders',
    placeholderData: keepPreviousData,
  });
  useKeepPageInRange(ordersPaging, orders);
  const refreshing = orders.isFetching && orders.isPlaceholderData;

  const historyPaging = useCursorPaging({ storageKey: 'driver-history', resetOn: [id] });
  const history = useQuery({
    queryKey: ['drivers', id, 'history', historyPaging.cursor, historyPaging.pageSize],
    queryFn: () =>
      apiRequest<{ items: HistoryRow[]; next_cursor: string | null }>(
        `/drivers/${id}/history?${historyPaging.query}`,
      ),
    enabled: tab === 'history',
    placeholderData: keepPreviousData,
  });

  // The orders ticked to print again — a delivery run's receipts in one go (D-086).
  const selecting = usePrintSelection<OrderRow>(
    (row) => ({ kind: 'order', id: row.id }),
    (row) => row.id,
  );

  const activeKey = useIdempotencyKey(`driver-active:${id}`);
  const setActive = useMutation({
    mutationFn: (active: boolean) =>
      apiRequest<DriverRow>(`/drivers/${id}/${active ? 'reactivate' : 'deactivate'}`, {
        method: 'POST',
        body: { version: data?.version },
        idempotencyKey: activeKey.key,
      }),
    onSuccess: async () => {
      activeKey.renew();
      setConfirmingDeactivate(false);
      await queryClient.invalidateQueries({ queryKey: ['drivers'] });
      await queryClient.invalidateQueries({ queryKey: ['/drivers'] });
      await invalidateHistory(queryClient);
    },
  });
  const setActiveError = errorMessage(t, setActive.error);
  const closeDeactivate = () => {
    setConfirmingDeactivate(false);
    setActive.reset();
  };

  usePageTitle(data?.name ?? t('drivers:title'));

  const totals = orders.data?.totals;

  return (
    <div className="mz-stack">
      <QueryStates query={driver}>
        {data ? (
          <>
            <Card>
              <div className="mz-stack">
                <div
                  className="mz-row mz-row--between"
                  style={{ alignItems: 'flex-start', gap: 'var(--space-3)', flexWrap: 'wrap' }}
                >
                  <div className="mz-stack" style={{ gap: '2px' }}>
                    <h2 className="mz-title">
                      <bdi>{data.name}</bdi>
                    </h2>
                    {data.phone ? (
                      <a href={`tel:${data.phone}`} className="mz-caption mz-tap-link">
                        <bdi dir="ltr">{data.phone}</bdi>
                      </a>
                    ) : null}
                  </div>
                  {/* The record's own buttons sit with its name, as on a material (business review). */}
                  <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                    <InactiveChip row={data} />
                    <Can permission="drivers.edit">
                      <Button variant="secondary" icon="edit" onClick={() => setEditing(true)}>
                        {t('drivers:edit_driver')}
                      </Button>
                      <Button
                        variant={data.is_active ? 'danger' : 'secondary'}
                        loading={setActive.isPending && !confirmingDeactivate}
                        onClick={() => {
                          setActive.reset();
                          // Reactivating puts nothing at risk and happens at once; deactivating asks.
                          if (data.is_active) setConfirmingDeactivate(true);
                          else setActive.mutate(true);
                        }}
                      >
                        {data.is_active ? t('drivers:deactivate') : t('drivers:reactivate')}
                      </Button>
                    </Can>
                  </div>
                </div>
                {setActiveError && !confirmingDeactivate ? (
                  <div className="mz-warning" role="alert">
                    {setActiveError}
                  </div>
                ) : null}

                <hr className="mz-divider" />

                <dl className="mz-stack" style={{ gap: 'var(--space-2)', margin: 0 }}>
                  <div className="mz-row mz-row--between" style={{ gap: 'var(--space-3)' }}>
                    <dt className="mz-caption">{t('drivers:car_number')}</dt>
                    <dd style={{ margin: 0 }}>
                      {data.car_number ? <bdi>{data.car_number}</bdi> : '—'}
                    </dd>
                  </div>
                  {data.notes ? (
                    <div
                      className="mz-row mz-row--between"
                      style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}
                    >
                      <dt className="mz-caption">{t('glossary:notes')}</dt>
                      <dd style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                        <bdi>{data.notes}</bdi>
                      </dd>
                    </div>
                  ) : null}
                </dl>
                {!data.is_active ? (
                  <p className="mz-caption">{t('drivers:inactive_hint')}</p>
                ) : null}
              </div>
            </Card>

            <SegmentedControl
              label={t('common:more')}
              hideLabel
              value={tab}
              onChange={setTab}
              options={[
                ...(mayViewOrders ? [{ value: 'orders' as Tab, label: t('orders:title') }] : []),
                { value: 'history', label: t('glossary:history') },
              ]}
            />

            {tab === 'orders' ? (
              <>
                <div className="mz-toolbar">
                  <div className="mz-toolbar__filters">
                    <select
                      className="mz-select"
                      aria-label={t('trade:period')}
                      value={period}
                      onChange={(event) => setPeriod(event.target.value as Period)}
                    >
                      <option value="all">{t('orders:any_date')}</option>
                      <option value="today">{t('common:today')}</option>
                      <option value="week">{t('common:this_week')}</option>
                      <option value="month">{t('common:this_month')}</option>
                      <option value="last_month">{t('purchases:period_last_month')}</option>
                      <option value="year">{t('purchases:period_this_year')}</option>
                    </select>
                  </div>
                  <Can permission="orders.create">
                    <Link to={`/orders/new?driver=${id}`} className="mz-button mz-button--money-in">
                      <Icon name="money-in" />
                      {t('trade:new_sale')}
                    </Link>
                  </Can>
                </div>

                {totals ? (
                  <div className="mz-kpis mz-kpis--two">
                    <div className="mz-kpi">
                      <KpiHead icon="orders" label={t('drivers:tile_orders')} />
                      <span className="mz-kpi__count" data-tabular>
                        {formatter.number(totals.orders)}
                      </span>
                    </div>
                    <div className="mz-kpi">
                      <KpiHead icon="money-in" label={t('drivers:tile_total')} />
                      <DualAmount
                        amount_iqd={totals.total_iqd}
                        amount_usd_cents={totals.total_usd_cents}
                      />
                    </div>
                  </div>
                ) : null}

                {(orders.data?.items.length ?? 0) > 0 ? <PrintButton state={selecting} /> : null}

                <QueryStates
                  query={orders}
                  isEmpty={(orders.data?.items.length ?? 0) === 0}
                  emptyTitle={t('drivers:no_orders')}
                >
                  <div
                    className="mz-refreshable"
                    data-busy={refreshing ? 'true' : undefined}
                    aria-busy={refreshing}
                  >
                    <OrderTable rows={orders.data?.items ?? []} selection={selecting.selection} />
                  </div>
                  <Pager
                    page={ordersPaging.page}
                    pageSize={ordersPaging.pageSize}
                    total={orders.data?.total ?? 0}
                    onPage={ordersPaging.setPage}
                    onPageSize={ordersPaging.setPageSize}
                  />
                </QueryStates>
              </>
            ) : null}

            {tab === 'history' ? (
              <QueryStates
                query={history}
                isEmpty={(history.data?.items.length ?? 0) === 0}
                emptyTitle={t('history:empty')}
              >
                <ul className="mz-list">
                  {(history.data?.items ?? []).map((row) => (
                    <li key={row.id} className="mz-list__item mz-list__item--detail">
                      <span className="mz-row-lead">
                        <Icon
                          name={
                            row.action === 'create'
                              ? 'plus'
                              : row.action === 'update'
                                ? 'edit'
                                : 'clock'
                          }
                          size={18}
                        />
                      </span>
                      <span className="mz-list__body">
                        {/* Who did what, as on the History page: the name, then the action. */}
                        <span
                          className="mz-list__title mz-row"
                          style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}
                        >
                          <bdi>{row.actor_display_name ?? t('history:system')}</bdi>
                          <Chip>
                            {t(`history:action.${row.action}`, { defaultValue: row.action })}
                          </Chip>
                        </span>
                        <span className="mz-caption">
                          {formatter.timestamp(new Date(row.occurred_at))}
                        </span>
                        {row.changes && Object.keys(row.changes).length > 0 ? (
                          <AuditDiff changes={row.changes} note={row.note} />
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
                <Pager
                  page={historyPaging.page}
                  pageSize={historyPaging.pageSize}
                  hasNext={Boolean(history.data?.next_cursor)}
                  onPage={(next) => {
                    const cursor = history.data?.next_cursor;
                    if (next > historyPaging.page && cursor) historyPaging.next(cursor);
                    else if (next < historyPaging.page) historyPaging.previous();
                  }}
                  onPageSize={historyPaging.setPageSize}
                />
              </QueryStates>
            ) : null}
          </>
        ) : null}
      </QueryStates>

      {editing && data ? (
        <DriverSheet
          driver={data}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setNotice({ message: t('drivers:saved') });
          }}
        />
      ) : null}

      {confirmingDeactivate && data ? (
        <BottomSheet
          title={t('drivers:deactivate')}
          open
          onClose={closeDeactivate}
          closeLabel={t('common:close')}
        >
          <div className="mz-stack">
            <p>
              <strong>
                <bdi>{data.name}</bdi>
              </strong>
            </p>
            <p className="mz-muted">{t('drivers:deactivate_body')}</p>
            {setActiveError ? (
              <div className="mz-warning" role="alert">
                {setActiveError}
              </div>
            ) : null}
            <Button
              variant="danger"
              block
              loading={setActive.isPending}
              onClick={() => setActive.mutate(false)}
            >
              {t('drivers:deactivate')}
            </Button>
          </div>
        </BottomSheet>
      ) : null}

      {notice ? <SavedToast notice={notice} onDone={dismissNotice} /> : null}
    </div>
  );
}

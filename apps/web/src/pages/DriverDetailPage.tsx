import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet, Button, Card, Icon } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { useIdempotencyKey } from '../lib/idempotency.js';
import { usePageTitle } from '../lib/page-title.js';
import { errorMessage } from '../lib/errors.js';
import { invalidateHistory } from '../lib/invalidate.js';
import { useKeepPageInRange, usePaging } from '../lib/paging.js';
import { presetPeriod } from '../lib/periods.js';
import { useFormatter, usePermission } from '../lib/store.js';
import type { DriverRow } from '../lib/drivers.js';
import { Can } from '../components/Can.js';
import { DriverSheet } from '../components/DriverSheet.js';
import { DualAmount } from '../components/DualAmount.js';
import { InactiveChip } from '../components/chips.js';
import { KpiHead } from '../components/KpiHead.js';
import { TradeTable } from '../components/TradeTable.js';
import type { TradeRow } from '../components/TradeTable.js';
import { Pager } from '../components/Pager.js';
import { PrintButton, usePrintSelection } from '../components/PrintSelection.js';
import { QueryStates } from '../components/states.js';
import { SavedToast } from '../components/SavedToast.js';
import type { SavedNotice } from '../components/SavedToast.js';

type Period = 'all' | 'today' | 'week' | 'month' | 'last_month' | 'year';

/**
 * One driver (D-105, D-106): who they are — name, phone, car — with Edit and Deactivate beside the
 * name, and below it every sale they took and every purchase they brought in, newest first, for the
 * period chosen — the Buying & selling list narrowed to them, with its figures, each side for whoever
 * may see it. Changes to the driver are in History (rule 3); the page has no tab of its own for them.
 */
export function DriverDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const formatter = useFormatter();
  const queryClient = useQueryClient();
  const mayViewOrders = usePermission('orders.view');
  const mayViewPurchases = usePermission('purchases.view');
  const mayViewTrade = mayViewOrders || mayViewPurchases;
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
    queryKey: ['trade', 'driver', id, period, ordersPaging.page, ordersPaging.pageSize],
    queryFn: () =>
      apiRequest<{
        items: TradeRow[];
        total: number;
        totals?: {
          sales?: { count: number; total_iqd: number; total_usd_cents: number };
          purchases?: { count: number; cost?: { total_iqd: number; total_usd_cents: number } };
        };
      }>(`/trade?${filter.toString()}&${ordersPaging.query}`),
    enabled: mayViewTrade,
    placeholderData: keepPreviousData,
  });
  useKeepPageInRange(ordersPaging, orders);
  const refreshing = orders.isFetching && orders.isPlaceholderData;

  // The rows ticked to print again — a day's loads in one go (D-086).
  const selecting = usePrintSelection<TradeRow>(
    (row) =>
      row.kind === 'sale' ? { kind: 'order', id: row.id } : { kind: 'purchase', id: row.id },
    (row) => `${row.kind}:${row.id}`,
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
      // Every driver picker, the Trade filter's (`/drivers?status=all`) among them.
      await queryClient.invalidateQueries({
        predicate: (query) => String(query.queryKey[0]).startsWith('/drivers'),
      });
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

            {mayViewTrade ? (
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
                  <span className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                    <Can permission="purchases.create">
                      <Link
                        to={`/purchases/new?driver=${id}`}
                        className="mz-button mz-button--money-out"
                      >
                        <Icon name="money-out" />
                        {t('purchases:new_purchase')}
                      </Link>
                    </Can>
                    <Can permission="orders.create">
                      <Link
                        to={`/orders/new?driver=${id}`}
                        className="mz-button mz-button--money-in"
                      >
                        <Icon name="money-in" />
                        {t('trade:new_sale')}
                      </Link>
                    </Can>
                  </span>
                </div>

                {/* Each side's own figures, never added together, as on Buying & selling. */}
                {totals?.sales || totals?.purchases ? (
                  <div className="mz-kpis">
                    {totals.sales ? (
                      <>
                        <div className="mz-kpi">
                          <KpiHead icon="orders" label={t('drivers:tile_orders')} />
                          <span className="mz-kpi__count" data-tabular>
                            {formatter.number(totals.sales.count)}
                          </span>
                        </div>
                        <div className="mz-kpi">
                          <KpiHead icon="money-in" label={t('trade:tile_sold')} />
                          <DualAmount
                            amount_iqd={totals.sales.total_iqd}
                            amount_usd_cents={totals.sales.total_usd_cents}
                          />
                        </div>
                      </>
                    ) : null}
                    {totals.purchases ? (
                      <>
                        <div className="mz-kpi">
                          <KpiHead icon="purchases" label={t('drivers:tile_purchases')} />
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
                    <TradeTable rows={orders.data?.items ?? []} selection={selecting.selection} />
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

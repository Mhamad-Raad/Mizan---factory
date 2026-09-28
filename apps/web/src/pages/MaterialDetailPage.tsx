import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BottomSheet,
  Button,
  Card,
  Chip,
  DateField,
  NumberField,
  Tabs,
  TextField,
  Toast,
} from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { useIdempotencyKey } from '../lib/idempotency.js';
import { toMoneyBody } from '../lib/money.js';
import { parseCount, quantityText } from '../lib/quantity.js';
import { usePageTitle } from '../lib/page-title.js';
import { Can } from '../components/Can.js';
import { DualAmount } from '../components/DualAmount.js';
import { MonthPriceEditor } from '../components/MonthPriceEditor.js';
import { MoneyInput } from '../components/MoneyInput.js';
import type { MoneyValue } from '../components/MoneyInput.js';
import { QueryStates } from '../components/states.js';
import { Pager } from '../components/Pager.js';
import { useCursorPaging, useKeepPageInRange, usePaging } from '../lib/paging.js';
import { useFormatter, usePermission } from '../lib/store.js';
import { useIsWide } from '../lib/wide.js';
import { errorMessage } from '../lib/errors.js';
import { invalidateHistory, invalidateMoneyViews } from '../lib/invalidate.js';
import { useGlobalRate } from '../lib/rates.js';
import type { ItemRow } from './MaterialsPage.js';

interface MonthPrice {
  id: string;
  month: string;
  sale: { amount_iqd: number; amount_usd_cents: number; entered_currency: 'IQD' | 'USD' } | null;
  bought?: { amount_iqd: number; amount_usd_cents: number; entered_currency: 'IQD' | 'USD' } | null;
  note: string | null;
  version: number;
  updated_by_name: string | null;
}

interface Movement {
  id: string;
  movement_type: string;
  qty_count: number | null;
  qty_kg: string | null;
  entry_date: string;
  note: string | null;
  performed_by: string | null;
  is_live: boolean;
}

/** `/items/:id/lots` (D-075): the buys with stock left, the used-up count, and the latest buy. */
interface LotsResponse {
  items: Lot[];
  used_up_count: number;
  latest: Lot | null;
}

/** How many used-up buys one "show more" brings. */
const USED_UP_PAGE = 100;

/**
 * One buy of this material (D-062): how much came in, how much of it is left, and what each unit
 * cost. The unit cost is a bought price and is absent for whoever may not see bought prices.
 */
export interface Lot {
  purchase_line_id: string;
  purchase_id: string;
  purchase_number: number;
  bought_on: string;
  quantity: string;
  remaining: string;
  unit_cost_iqd?: number;
  unit_cost_usd_cents?: number;
  entered_currency: 'IQD' | 'USD';
  rate_iqd_per_usd: string;
}

interface ItemDetail extends ItemRow {
  notes: string | null;
  first_bought_on: string | null;
  version: number;
}

type Tab = 'overview' | 'prices' | 'movements' | 'history';

/**
 * The material detail page (FR-307): stock and the two derived dates on the header card, the
 * stock split by what we paid for it (D-062) with "Add stock" — which is how stock comes in now —
 * then the monthly prices, the movements that produced the stock, and this material's History.
 */
export function MaterialDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const formatter = useFormatter();
  const queryClient = useQueryClient();
  const maySetPrices = usePermission('materials.set_prices');
  // Adding stock is buying it (D-062): the key is the buying one.
  const mayBuy = usePermission('purchases.create');
  const wide = useIsWide();

  const [tab, setTab] = useState<Tab>('overview');
  const [priceSheet, setPriceSheet] = useState<{ month: string; existing?: MonthPrice } | null>(
    null,
  );
  const [adding, setAdding] = useState(false);
  /** Deactivating asks first, like every other action that takes something out of use. */
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false);
  const [showUsedUp, setShowUsedUp] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const item = useQuery({
    queryKey: ['items', id],
    queryFn: () => apiRequest<ItemDetail>(`/items/${id}`),
  });

  // The buys with stock left, how many are used up, and the latest buy (D-075). The used-up
  // ones arrive only when asked for, a page at a time: at ten years a material had 520 buys.
  const lots = useQuery({
    queryKey: ['items', id, 'lots'],
    queryFn: () => apiRequest<LotsResponse>(`/items/${id}/lots`),
  });
  const usedUpLots = useInfiniteQuery({
    queryKey: ['items', id, 'lots', 'used_up'],
    queryFn: ({ pageParam }) =>
      apiRequest<{ items: Lot[]; has_more: boolean }>(
        `/items/${id}/lots?used_up=true&page=${pageParam}&page_size=${USED_UP_PAGE}`,
      ),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => (last.has_more ? pages.length + 1 : undefined),
    enabled: showUsedUp,
  });

  const { rate: currentRate } = useGlobalRate();

  // Each tab pages on its own (D-058): prices and movements by page number in the address,
  // the audit trail by cursor.
  const pricesPaging = usePaging({ storageKey: 'material-prices', prefix: 'prices_', resetOn: [id] });
  const movesPaging = usePaging({ storageKey: 'material-movements', prefix: 'moves_', resetOn: [id] });
  const historyPaging = useCursorPaging({ storageKey: 'record-history', resetOn: [id] });

  const prices = useQuery({
    queryKey: ['items', id, 'prices', pricesPaging.page, pricesPaging.pageSize],
    queryFn: () => apiRequest<{ items: MonthPrice[]; total: number }>(`/items/${id}/prices?${pricesPaging.query}`),
    enabled: tab === 'prices',
    placeholderData: keepPreviousData,
  });
  useKeepPageInRange(pricesPaging, prices);

  const movements = useQuery({
    queryKey: ['items', id, 'movements', movesPaging.page, movesPaging.pageSize],
    queryFn: () =>
      apiRequest<{ items: Movement[]; total: number }>(`/items/${id}/movements?${movesPaging.query}`),
    enabled: tab === 'movements',
    placeholderData: keepPreviousData,
  });
  useKeepPageInRange(movesPaging, movements);

  const history = useQuery({
    queryKey: ['items', id, 'history', historyPaging.cursor, historyPaging.pageSize],
    queryFn: () =>
      apiRequest<{
        next_cursor: string | null;
        items: {
          id: string;
          action: string;
          occurred_at: string;
          actor_display_name: string | null;
          note: string | null;
        }[];
      }>(`/items/${id}/history?${historyPaging.query}`),
    enabled: tab === 'history',
    placeholderData: keepPreviousData,
  });
  const historyNext = history.data?.next_cursor ?? null;

  // Each write holds one key across its retries, renewed only by its success (FR-1305).
  const pricesKey = useIdempotencyKey();
  const addStockKey = useIdempotencyKey();
  const activeKey = useIdempotencyKey();

  const savePrices = useMutation({
    mutationFn: (input: { month: string; body: unknown; version: number | null }) =>
      apiRequest(`/items/${id}/prices/${input.month.slice(0, 7)}`, {
        method: 'PUT',
        body: input.body,
        idempotencyKey: pricesKey.key,
      }),
    onSuccess: async () => {
      pricesKey.renew();
      closePrices();
      setToast(t('materials:prices_saved'));
      await queryClient.invalidateQueries({ queryKey: ['items'] });
      // A month's price values the stock and the margin, which Today, Reports and Accounts sum.
      await invalidateMoneyViews(queryClient);
    },
  });

  // "Add stock" is a buy of this one material, with no company (D-062).
  const addStock = useMutation({
    mutationFn: (input: {
      purchase_date: string;
      note: string | null;
      qty_count: number | null;
      qty_kg: string | null;
      unit_price: { amount: number; currency: 'IQD' | 'USD'; other_amount: number | null };
    }) =>
      apiRequest('/purchases', {
        method: 'POST',
        idempotencyKey: addStockKey.key,
        body: {
          company_id: null,
          purchase_date: input.purchase_date,
          notes: input.note,
          lines: [
            {
              item_id: id,
              qty_count: input.qty_count,
              qty_kg: input.qty_kg,
              unit_price: input.unit_price,
            },
          ],
        },
      }),
    onSuccess: async () => {
      addStockKey.renew();
      closeAddStock();
      setToast(t('materials:stock_added'));
      await queryClient.invalidateQueries({ queryKey: ['items'] });
      await queryClient.invalidateQueries({ queryKey: ['purchases'] });
      await invalidateMoneyViews(queryClient);
    },
  });

  const setActive = useMutation({
    mutationFn: (active: boolean) =>
      apiRequest(`/items/${id}/${active ? 'reactivate' : 'deactivate'}`, {
        method: 'POST',
        body: { version: item.data?.version },
        idempotencyKey: activeKey.key,
      }),
    onSuccess: async () => {
      activeKey.renew();
      setConfirmingDeactivate(false);
      await queryClient.invalidateQueries({ queryKey: ['items'] });
      await invalidateHistory(queryClient);
    },
  });

  // A sheet that closes forgets its last refusal, so it does not greet the next attempt with it.
  function closePrices() {
    setPriceSheet(null);
    savePrices.reset();
  }
  function closeAddStock() {
    setAdding(false);
    addStock.reset();
  }
  function closeDeactivate() {
    setConfirmingDeactivate(false);
    setActive.reset();
  }

  const setActiveError = errorMessage(t, setActive.error);
  const thisMonth = `${formatter.today().slice(0, 7)}-01`;

  // A movement can carry kg, a count, or both — the material's own measure first.
  const movementQty = (movement: Movement) =>
    quantityText({ ...movement, priced_measure: item.data?.stock.priced_measure }, formatter, t);

  usePageTitle(item.data?.name ?? t('materials:title'));

  return (
    <>
      <div className="mz-stack">
        <QueryStates query={item}>
          {item.data ? (
            <>
              <Card>
                <div className="mz-row mz-row--between">
                  <div>
                    <h2 className="mz-title">
                      <bdi>{item.data.name}</bdi>
                    </h2>
                    <span className="mz-caption">
                      {t(`glossary:${item.data.pricing_unit}`)}
                      {item.data.code ? ` · ${item.data.code}` : ''}
                    </span>
                  </div>
                  {!item.data.is_active ? (
                    <Chip icon="close">{t('common:deactivated')}</Chip>
                  ) : null}
                </div>

                <p className="mz-title" data-tabular style={{ marginBlockStart: 'var(--space-3)' }}>
                  {item.data.stock.priced_complete
                    ? `${formatter.quantity(item.data.stock.priced_quantity)} ${t(
                        `common:${item.data.stock.priced_measure}_symbol`,
                      )}`
                    : '—'}
                </p>
                <span className="mz-caption" style={{ display: 'block' }}>
                  {t('materials:other_measure')}:{' '}
                  {item.data.stock.priced_measure === 'kg'
                    ? item.data.stock.count_complete
                      ? formatter.number(item.data.stock.stock_count)
                      : '—'
                    : item.data.stock.kg_complete
                      ? formatter.quantity(item.data.stock.stock_kg)
                      : '—'}
                </span>
                <span className="mz-caption" style={{ display: 'block' }}>
                  {t('glossary:date_bought')}:{' '}
                  {item.data.first_bought_on ? formatter.date(item.data.first_bought_on) : '—'}
                  {' · '}
                  {t('glossary:date_sold')}:{' '}
                  {item.data.last_sold_on ? formatter.date(item.data.last_sold_on) : '—'}
                </span>
              </Card>

              <StockByPrice
                lots={lots.data?.items ?? []}
                usedUp={usedUpLots.data?.pages.flatMap((page) => page.items) ?? []}
                usedUpCount={lots.data?.used_up_count ?? 0}
                loading={lots.isPending || (showUsedUp && usedUpLots.isPending)}
                pricedMeasure={item.data.stock.priced_measure}
                showUsedUp={showUsedUp}
                onToggleUsedUp={() => setShowUsedUp(!showUsedUp)}
                moreUsedUp={
                  showUsedUp && usedUpLots.hasNextPage
                    ? { loading: usedUpLots.isFetchingNextPage, load: () => void usedUpLots.fetchNextPage() }
                    : null
                }
                action={
                  mayBuy && item.data.is_active ? (
                    <Button icon="plus" onClick={() => setAdding(true)}>
                      {t('materials:add_stock')}
                    </Button>
                  ) : null
                }
              />

              <Tabs
                label={t('common:more')}
                value={tab}
                onChange={setTab}
                tabs={[
                  { value: 'overview', label: t('materials:tab_overview') },
                  { value: 'prices', label: t('glossary:monthly_prices') },
                  { value: 'movements', label: t('materials:tab_movements') },
                  { value: 'history', label: t('glossary:history') },
                ]}
              />

              {tab === 'overview' ? (
                <div className="mz-stack">
                  {/* The damage this material has had, and the form to record more (FR-801). */}
                  <Can permission="damages.view">
                    <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                      <Link to={`/damages?item=${id}`} className="mz-button mz-button--ghost">
                        {t('damages:of_material')}
                      </Link>
                      <Can permission="damages.create">
                        <Link
                          to={`/damages/new?item=${id}`}
                          className="mz-button mz-button--secondary"
                        >
                          {t('damages:record')}
                        </Link>
                      </Can>
                    </div>
                  </Can>
                  <Card>
                    <h3 className="mz-heading">{t('materials:this_month_prices')}</h3>
                    <div
                      className="mz-row mz-row--between"
                      style={{ marginBlockStart: 'var(--space-2)' }}
                    >
                      <span>{t('glossary:sale_price')}</span>
                      {item.data.sale ? (
                        <DualAmount
                          amount_iqd={item.data.sale.amount_iqd}
                          amount_usd_cents={item.data.sale.amount_usd_cents}
                        />
                      ) : (
                        <span className="mz-caption">{t('materials:no_price_yet')}</span>
                      )}
                    </div>
                    {item.data.sale && item.data.sale.source === 'fallback' ? (
                      <span className="mz-caption">
                        {t('materials:price_from', {
                          month: formatter.month(item.data.sale.from_month.slice(0, 7)),
                        })}
                      </span>
                    ) : null}
                    {item.data.bought ? (
                      <div
                        className="mz-row mz-row--between"
                        style={{ marginBlockStart: 'var(--space-2)' }}
                      >
                        <span>{t('glossary:bought_price')}</span>
                        <DualAmount
                          amount_iqd={item.data.bought.amount_iqd}
                          amount_usd_cents={item.data.bought.amount_usd_cents}
                        />
                      </div>
                    ) : null}
                    {maySetPrices ? (
                      <Button
                        variant="secondary"
                        block
                        onClick={() => setPriceSheet({ month: thisMonth })}
                        style={{ marginBlockStart: 'var(--space-3)' }}
                      >
                        {t('materials:set_this_month')}
                      </Button>
                    ) : null}
                  </Card>

                  {item.data.notes ? (
                    <Card>
                      <h3 className="mz-heading">{t('glossary:notes')}</h3>
                      <p>
                        <bdi>{item.data.notes}</bdi>
                      </p>
                    </Card>
                  ) : null}

                  <Can permission="materials.edit">
                    {setActiveError && !confirmingDeactivate ? (
                      <div className="mz-warning" role="alert">
                        {setActiveError}
                      </div>
                    ) : null}
                    <Button
                      variant={item.data.is_active ? 'danger' : 'secondary'}
                      loading={setActive.isPending && !confirmingDeactivate}
                      onClick={() => {
                        setActive.reset();
                        // Reactivating puts nothing at risk and happens at once; deactivating asks.
                        if (item.data?.is_active) setConfirmingDeactivate(true);
                        else setActive.mutate(true);
                      }}
                    >
                      {item.data.is_active ? t('materials:deactivate') : t('materials:reactivate')}
                    </Button>
                  </Can>
                </div>
              ) : null}

              {tab === 'prices' ? (
                <QueryStates
                  query={prices}
                  isEmpty={(prices.data?.items.length ?? 0) === 0}
                  emptyTitle={t('materials:no_prices_title')}
                  emptyAction={
                    maySetPrices ? (
                      <Button onClick={() => setPriceSheet({ month: thisMonth })}>
                        {t('materials:set_this_month')}
                      </Button>
                    ) : undefined
                  }
                >
                  <Card>
                    {(prices.data?.items ?? []).map((row) => (
                      <div
                        key={row.id}
                        className={`mz-price-month${row.month === thisMonth ? ' mz-price-month--current' : ''}`}
                      >
                        <strong>{formatter.month(row.month.slice(0, 7))}</strong>
                        <span>
                          {row.sale ? (
                            <DualAmount
                              amount_iqd={row.sale.amount_iqd}
                              amount_usd_cents={row.sale.amount_usd_cents}
                            />
                          ) : (
                            '—'
                          )}
                          <span className="mz-caption" style={{ display: 'block' }}>
                            {t('glossary:sale_price')}
                          </span>
                        </span>
                        <span>
                          {row.bought ? (
                            <DualAmount
                              amount_iqd={row.bought.amount_iqd}
                              amount_usd_cents={row.bought.amount_usd_cents}
                            />
                          ) : (
                            '—'
                          )}
                          <span className="mz-caption" style={{ display: 'block' }}>
                            {row.bought ? t('glossary:bought_price') : ''}
                          </span>
                          {maySetPrices ? (
                            <Button
                              variant="ghost"
                              onClick={() => setPriceSheet({ month: row.month, existing: row })}
                            >
                              {t('common:edit')}
                            </Button>
                          ) : null}
                        </span>
                      </div>
                    ))}
                  </Card>
                  <Pager
                    page={pricesPaging.page}
                    pageSize={pricesPaging.pageSize}
                    total={prices.data?.total ?? 0}
                    onPage={pricesPaging.setPage}
                    onPageSize={pricesPaging.setPageSize}
                  />
                </QueryStates>
              ) : null}

              {tab === 'movements' ? (
                <QueryStates
                  query={movements}
                  isEmpty={(movements.data?.items.length ?? 0) === 0}
                  emptyTitle={t('materials:no_movements')}
                >
                  {wide ? (
                    <div className="mz-table-wrap">
                      <table className="mz-table">
                        <thead>
                          <tr>
                            <th scope="col">{t('common:type')}</th>
                            <th scope="col">{t('common:date')}</th>
                            <th scope="col" className="mz-table__secondary">
                              {t('common:done_by')}
                            </th>
                            <th scope="col" className="mz-table__secondary">
                              {t('common:note')}
                            </th>
                            <th scope="col" data-numeric="true">
                              {t('glossary:quantity')}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {(movements.data?.items ?? []).map((movement) => (
                            <tr
                              key={movement.id}
                              style={{ cursor: 'default', opacity: movement.is_live ? 1 : 0.5 }}
                            >
                              <td>{t(`materials:movement.${movement.movement_type}`)}</td>
                              <td data-tabular>{formatter.date(movement.entry_date)}</td>
                              <td className="mz-table__secondary">
                                {movement.performed_by ? <bdi>{movement.performed_by}</bdi> : '—'}
                              </td>
                              <td className="mz-table__secondary">
                                {movement.note ? <bdi>{movement.note}</bdi> : '—'}
                              </td>
                              <td data-numeric="true" data-tabular>
                                {movementQty(movement)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <Card>
                      <ul className="mz-list">
                        {(movements.data?.items ?? []).map((movement) => (
                          <li key={movement.id} className="mz-list__item">
                            <span className="mz-list__body">
                              <span className="mz-list__title">
                                {t(`materials:movement.${movement.movement_type}`)}
                              </span>
                              <span className="mz-caption">
                                {formatter.date(movement.entry_date)}
                                {movement.performed_by ? ` · ${movement.performed_by}` : ''}
                                {movement.note ? ` · ${movement.note}` : ''}
                              </span>
                            </span>
                            <span data-tabular style={{ opacity: movement.is_live ? 1 : 0.5 }}>
                              {movementQty(movement)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </Card>
                  )}
                  <Pager
                    page={movesPaging.page}
                    pageSize={movesPaging.pageSize}
                    total={movements.data?.total ?? 0}
                    onPage={movesPaging.setPage}
                    onPageSize={movesPaging.setPageSize}
                  />
                </QueryStates>
              ) : null}

              {tab === 'history' ? (
                <QueryStates
                  query={history}
                  isEmpty={(history.data?.items.length ?? 0) === 0}
                  emptyTitle={t('history:empty')}
                >
                  {wide ? (
                    <div className="mz-table-wrap">
                      <table className="mz-table">
                        <thead>
                          <tr>
                            <th scope="col">{t('common:activity')}</th>
                            <th scope="col">{t('common:date')}</th>
                            <th scope="col" className="mz-table__secondary">
                              {t('common:done_by')}
                            </th>
                            <th scope="col" className="mz-table__secondary">
                              {t('common:note')}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {(history.data?.items ?? []).map((entry) => (
                            <tr key={entry.id} style={{ cursor: 'default' }}>
                              <td>{t(`history:action.${entry.action}`)}</td>
                              <td data-tabular>
                                {formatter.timestamp(new Date(entry.occurred_at))}
                              </td>
                              <td className="mz-table__secondary">
                                {entry.actor_display_name ? (
                                  <bdi>{entry.actor_display_name}</bdi>
                                ) : (
                                  '—'
                                )}
                              </td>
                              <td className="mz-table__secondary">
                                {entry.note ? <bdi>{entry.note}</bdi> : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <Card>
                      <ul className="mz-list">
                        {(history.data?.items ?? []).map((entry) => (
                          <li key={entry.id} className="mz-list__item">
                            <span className="mz-list__body">
                              <span className="mz-list__title">
                                {t(`history:action.${entry.action}`)}
                              </span>
                              <span className="mz-caption">
                                {formatter.timestamp(new Date(entry.occurred_at))}
                                {entry.actor_display_name ? ` · ${entry.actor_display_name}` : ''}
                                {entry.note ? ` · ${entry.note}` : ''}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </Card>
                  )}
                  <Pager
                    page={historyPaging.page}
                    pageSize={historyPaging.pageSize}
                    hasNext={Boolean(historyNext)}
                    onPage={(page) =>
                      page > historyPaging.page && historyNext ? historyPaging.next(historyNext) : historyPaging.previous()
                    }
                    onPageSize={historyPaging.setPageSize}
                  />
                </QueryStates>
              ) : null}
            </>
          ) : null}
        </QueryStates>

        {priceSheet ? (
          <MonthPriceEditor
            open
            month={priceSheet.month}
            monthLabel={formatter.month(priceSheet.month.slice(0, 7))}
            rate={currentRate}
            initial={priceSheet.existing}
            saving={savePrices.isPending}
            error={errorMessage(t, savePrices.error) ?? undefined}
            onClose={closePrices}
            onSave={(input) =>
              savePrices.mutate({
                month: priceSheet.month,
                version: input.version ?? null,
                body: {
                  sale: input.sale ? toMoneyBody(input.sale) : null,
                  bought: input.bought ? toMoneyBody(input.bought) : null,
                  note: input.note,
                  version: input.version,
                },
              })
            }
          />
        ) : null}

        {adding && item.data ? (
          <AddStockSheet
            pricedMeasure={item.data.stock.priced_measure}
            rate={currentRate}
            latest={lots.data?.latest ?? null}
            saving={addStock.isPending}
            error={errorMessage(t, addStock.error) ?? undefined}
            onClose={closeAddStock}
            onEdit={addStock.reset}
            onSave={(input) => addStock.mutate(input)}
          />
        ) : null}

        {confirmingDeactivate && item.data ? (
          <BottomSheet title={t('materials:deactivate')} open onClose={closeDeactivate} closeLabel={t('common:close')}>
            <div className="mz-stack">
              <p>
                <strong>
                  <bdi>{item.data.name}</bdi>
                </strong>
              </p>
              <p className="mz-muted">{t('common:deactivate_material_body')}</p>
              {setActiveError ? (
                <div className="mz-warning" role="alert">
                  {setActiveError}
                </div>
              ) : null}
              <Button variant="danger" block loading={setActive.isPending} onClick={() => setActive.mutate(false)}>
                {t('materials:deactivate')}
              </Button>
            </div>
          </BottomSheet>
        ) : null}

        {toast ? (
          <Toast message={toast} actionLabel={t('common:close')} onAction={() => setToast(null)} />
        ) : null}
      </div>
    </>
  );
}

/**
 * The stock split by what we paid (D-062): every buy of the material, oldest first — the order a
 * sale takes them in — with how much of it is left and what each one cost. Used-up buys fold
 * away behind a toggle; each row opens the buy it describes.
 */
function StockByPrice({
  lots,
  usedUp,
  usedUpCount,
  loading,
  pricedMeasure,
  showUsedUp,
  onToggleUsedUp,
  moreUsedUp,
  action,
}: {
  /** The buys with stock left, oldest first. */
  lots: readonly Lot[];
  /** The used-up buys fetched so far (newest first, a page at a time). */
  usedUp: readonly Lot[];
  usedUpCount: number;
  loading: boolean;
  pricedMeasure: 'count' | 'kg';
  showUsedUp: boolean;
  onToggleUsedUp: () => void;
  /** Another page of used-up buys, when there is one. */
  moreUsedUp: { loading: boolean; load: () => void } | null;
  action: ReactNode;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const unit = pricedMeasure === 'kg' ? ` ${t('common:kg_symbol')}` : '';
  // One list, oldest first — the order a sale takes them in — whichever request each buy came from.
  const shown = showUsedUp
    ? [...lots, ...usedUp].sort(
        (left, right) =>
          left.bought_on.localeCompare(right.bought_on) || left.purchase_number - right.purchase_number,
      )
    : lots;

  return (
    <Card>
      <div className="mz-row mz-row--between" style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <div>
          <h3 className="mz-heading">{t('materials:stock_by_price')}</h3>
          <p className="mz-caption">{t('materials:stock_by_price_hint')}</p>
        </div>
        {action}
      </div>

      {loading ? null : shown.length === 0 ? (
        <p className="mz-muted" style={{ marginBlockStart: 'var(--space-3)' }}>
          {t('materials:no_stock_bought')}
        </p>
      ) : (
        <ul className="mz-list" style={{ marginBlockStart: 'var(--space-2)' }}>
          {shown.map((lot) => (
            <li key={lot.purchase_line_id}>
              <Link
                to={`/purchases/${lot.purchase_id}`}
                className="mz-list__item mz-list__item--interactive mz-list__item--detail"
              >
                <span className="mz-list__body">
                  <span className="mz-list__title" data-tabular>
                    {t('materials:left_of', {
                      // Pieces are whole: the API's "125.000" reads "125".
                      left: `${formatter.quantity(lot.remaining)}${unit}`,
                      total: `${formatter.quantity(lot.quantity)}${unit}`,
                    })}
                  </span>
                  <span className="mz-caption">
                    {t('materials:bought_on_date', { date: formatter.date(lot.bought_on) })}
                    {' · '}
                    {t('purchases:number', { number: formatter.identifier(lot.purchase_number) })}
                  </span>
                </span>
                {lot.unit_cost_iqd !== undefined && lot.unit_cost_usd_cents !== undefined ? (
                  <span className="mz-list__end">
                    <DualAmount
                      amount_iqd={lot.unit_cost_iqd}
                      amount_usd_cents={lot.unit_cost_usd_cents}
                      primary={lot.entered_currency}
                    />
                    <span className="mz-caption" style={{ display: 'block' }}>
                      {t('materials:each')}
                    </span>
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {moreUsedUp ? (
        <Button variant="ghost" loading={moreUsedUp.loading} onClick={moreUsedUp.load}>
          {t('customers:show_more')}
        </Button>
      ) : null}
      {usedUpCount > 0 ? (
        <Button variant="ghost" onClick={onToggleUsedUp}>
          {showUsedUp
            ? t('materials:hide_used_up')
            : t('materials:show_used_up', { count: formatter.number(usedUpCount) })}
        </Button>
      ) : null}
    </Card>
  );
}

/**
 * "Add stock" (D-062): a new buy of this material — how much came in, what each one cost, when.
 * The cost opens with the last buy's, in the currency it was paid in, since a new shipment is
 * most often at or near the last price; the buy keeps its own price whatever is typed.
 */
function AddStockSheet({
  pricedMeasure,
  rate,
  latest,
  saving,
  error,
  onClose,
  onSave,
  onEdit,
}: {
  pricedMeasure: 'count' | 'kg';
  rate: string | null;
  latest: Lot | null;
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (input: {
    purchase_date: string;
    note: string | null;
    qty_count: number | null;
    qty_kg: string | null;
    unit_price: { amount: number; currency: 'IQD' | 'USD'; other_amount: number | null };
  }) => void;
  /** Any change to the inputs: the caller forgets the last refusal. */
  onEdit?: () => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [date, setDate] = useState(formatter.today());
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      onEdit?.();
      set(value);
    };
  const [cost, setCost] = useState<MoneyValue>(() => {
    if (latest && latest.unit_cost_iqd !== undefined && latest.unit_cost_usd_cents !== undefined) {
      return {
        amount: latest.entered_currency === 'IQD' ? latest.unit_cost_iqd : latest.unit_cost_usd_cents,
        currency: latest.entered_currency,
        other_amount: null,
      };
    }
    return { amount: null, currency: 'IQD', other_amount: null };
  });

  // Pieces are whole: "2.5" is refused under the field, never rounded to 3.
  const count = parseCount(quantity);
  const countInvalid = pricedMeasure === 'count' && count.kind === 'invalid';
  const quantityValid =
    pricedMeasure === 'count' ? count.kind === 'count' && count.value > 0 : quantity.trim() !== '' && Number(quantity) > 0;
  const valid = quantityValid && cost.amount !== null && cost.amount >= 0;

  return (
    <BottomSheet title={t('materials:add_stock')} open onClose={onClose} closeLabel={t('common:close')}>
      <div className="mz-stack">
        <p className="mz-muted">{t('materials:add_stock_hint')}</p>
        <div className="mz-grid-2">
          <NumberField
            label={t('glossary:quantity')}
            unit={pricedMeasure === 'kg' ? t('common:kg_symbol') : t('common:count_symbol')}
            decimals={pricedMeasure === 'kg' ? 3 : 0}
            value={quantity}
            error={countInvalid ? t('common:count_whole') : undefined}
            onChange={(event) => edit(setQuantity)(event.target.value)}
          />
          <DateField
            label={t('materials:bought_on')}
            value={date}
            max={formatter.today()}
            onChange={(event) => edit(setDate)(event.target.value)}
          />
        </div>
        <MoneyInput
          label={t('materials:cost_per_unit')}
          value={cost}
          rate={rate}
          sourceLabel={t('glossary:system_rate')}
          onChange={edit(setCost)}
        />
        <TextField
          label={t('materials:buy_note')}
          hint={t('common:optional')}
          value={note}
          error={error}
          maxLength={500}
          onChange={(event) => edit(setNote)(event.target.value)}
        />
        <Button
          block
          loading={saving}
          disabled={!valid}
          onClick={() =>
            cost.amount !== null &&
            onSave({
              purchase_date: date,
              note: note.trim() === '' ? null : note.trim(),
              qty_count: count.kind === 'count' && pricedMeasure === 'count' ? count.value : null,
              qty_kg: pricedMeasure === 'kg' ? quantity.trim() : null,
              unit_price: { amount: cost.amount, currency: cost.currency, other_amount: cost.other_amount ?? null },
            })
          }
        >
          {t('materials:add_stock')}
        </Button>
      </div>
    </BottomSheet>
  );
}

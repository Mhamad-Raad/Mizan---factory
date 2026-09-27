import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { ApiError, apiRequest, newIdempotencyKey } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { Can } from '../components/Can.js';
import { DualAmount } from '../components/DualAmount.js';
import { MonthPriceEditor } from '../components/MonthPriceEditor.js';
import { MoneyInput } from '../components/MoneyInput.js';
import type { MoneyValue } from '../components/MoneyInput.js';
import { QueryStates } from '../components/states.js';
import { Pager } from '../components/Pager.js';
import { useCursorPaging, usePaging } from '../lib/paging.js';
import { useFormatter, usePermission } from '../lib/store.js';
import { useIsWide } from '../lib/wide.js';
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
  const [showUsedUp, setShowUsedUp] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const item = useQuery({
    queryKey: ['items', id],
    queryFn: () => apiRequest<ItemDetail>(`/items/${id}`),
  });

  const lots = useQuery({
    queryKey: ['items', id, 'lots'],
    queryFn: () => apiRequest<{ items: Lot[] }>(`/items/${id}/lots`),
  });

  const rate = useQuery({
    queryKey: ['global-rate'],
    queryFn: () =>
      apiRequest<{ current: { rate_iqd_per_usd: string } | null }>('/settings/global-rates'),
  });

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

  const movements = useQuery({
    queryKey: ['items', id, 'movements', movesPaging.page, movesPaging.pageSize],
    queryFn: () =>
      apiRequest<{ items: Movement[]; total: number }>(`/items/${id}/movements?${movesPaging.query}`),
    enabled: tab === 'movements',
    placeholderData: keepPreviousData,
  });

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

  const savePrices = useMutation({
    mutationFn: (input: { month: string; body: unknown; version: number | null }) =>
      apiRequest(`/items/${id}/prices/${input.month.slice(0, 7)}`, {
        method: 'PUT',
        body: input.body,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      setPriceSheet(null);
      setToast(t('materials:prices_saved'));
      await queryClient.invalidateQueries({ queryKey: ['items'] });
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
        idempotencyKey: newIdempotencyKey(),
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
      setAdding(false);
      setToast(t('materials:stock_added'));
      await queryClient.invalidateQueries({ queryKey: ['items'] });
      await queryClient.invalidateQueries({ queryKey: ['purchases'] });
    },
  });

  const setActive = useMutation({
    mutationFn: (active: boolean) =>
      apiRequest(`/items/${id}/${active ? 'reactivate' : 'deactivate'}`, {
        method: 'POST',
        body: { version: item.data?.version },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['items'] });
    },
  });

  const currentRate = rate.data?.current?.rate_iqd_per_usd ?? '1310.0000';
  const thisMonth = `${formatter.today().slice(0, 7)}-01`;

  // A movement can carry kg, a count, or both — kept exactly as the phone card showed them.
  const movementQty = (movement: Movement) => {
    const parts: string[] = [];
    if (movement.qty_kg !== null) {
      parts.push(`${formatter.quantity(movement.qty_kg)} ${t('common:kg_symbol')}`);
    }
    if (movement.qty_count !== null) parts.push(formatter.number(movement.qty_count));
    return parts.length > 0 ? parts.join(' · ') : '—';
  };

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
                loading={lots.isPending}
                pricedMeasure={item.data.stock.priced_measure}
                showUsedUp={showUsedUp}
                onToggleUsedUp={() => setShowUsedUp(!showUsedUp)}
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
                    <Button
                      variant={item.data.is_active ? 'danger' : 'secondary'}
                      onClick={() => setActive.mutate(!item.data?.is_active)}
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
            error={
              savePrices.error instanceof ApiError
                ? t(savePrices.error.fields[0]?.message_key ?? 'errors:VALIDATION_FAILED')
                : undefined
            }
            onClose={() => setPriceSheet(null)}
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
            latest={(lots.data?.items ?? []).at(-1) ?? null}
            saving={addStock.isPending}
            error={
              addStock.error instanceof ApiError
                ? t(addStock.error.fields[0]?.message_key ?? addStock.error.messageKey, {
                    defaultValue: t('errors:VALIDATION_FAILED'),
                  })
                : undefined
            }
            onClose={() => setAdding(false)}
            onSave={(input) => addStock.mutate(input)}
          />
        ) : null}

        {toast ? (
          <Toast message={toast} actionLabel={t('common:close')} onAction={() => setToast(null)} />
        ) : null}
      </div>
    </>
  );
}

function toMoneyBody(value: {
  amount: number | null;
  currency: 'IQD' | 'USD';
  other_amount?: number | null;
}) {
  return value.amount === null
    ? null
    : { amount: value.amount, currency: value.currency, other_amount: value.other_amount ?? null };
}

/**
 * The stock split by what we paid (D-062): every buy of the material, oldest first — the order a
 * sale takes them in — with how much of it is left and what each one cost. Used-up buys fold
 * away behind a toggle; each row opens the buy it describes.
 */
function StockByPrice({
  lots,
  loading,
  pricedMeasure,
  showUsedUp,
  onToggleUsedUp,
  action,
}: {
  lots: readonly Lot[];
  loading: boolean;
  pricedMeasure: 'count' | 'kg';
  showUsedUp: boolean;
  onToggleUsedUp: () => void;
  action: ReactNode;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const unit = pricedMeasure === 'kg' ? ` ${t('common:kg_symbol')}` : '';
  const live = lots.filter((lot) => Number(lot.remaining) > 0);
  const usedUp = lots.length - live.length;
  const shown = showUsedUp ? lots : live;

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

      {usedUp > 0 ? (
        <Button variant="ghost" onClick={onToggleUsedUp}>
          {showUsedUp ? t('materials:hide_used_up') : t('materials:show_used_up', { count: formatter.number(usedUp) })}
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
}: {
  pricedMeasure: 'count' | 'kg';
  rate: string;
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
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [date, setDate] = useState(formatter.today());
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
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

  const valid = quantity.trim() !== '' && Number(quantity) > 0 && cost.amount !== null && cost.amount >= 0;

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
            onChange={(event) => setQuantity(event.target.value)}
          />
          <DateField
            label={t('materials:bought_on')}
            value={date}
            max={formatter.today()}
            onChange={(event) => setDate(event.target.value)}
          />
        </div>
        <MoneyInput
          label={t('materials:cost_per_unit')}
          value={cost}
          rate={rate}
          sourceLabel={t('glossary:system_rate')}
          onChange={setCost}
        />
        <TextField
          label={t('materials:buy_note')}
          hint={t('common:optional')}
          value={note}
          error={error}
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
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
              qty_count: pricedMeasure === 'count' ? Math.round(Number(quantity)) : null,
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

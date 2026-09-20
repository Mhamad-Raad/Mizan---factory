import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet, Button, Card, Chip, DateField, NumberField, Tabs, TextField, Toast } from '@mizan/ui';
import { ApiError, apiRequest, newIdempotencyKey } from '../lib/api.js';
import { AppShell } from '../components/AppShell.js';
import { Can } from '../components/Can.js';
import { DualAmount } from '../components/DualAmount.js';
import { MonthPriceEditor } from '../components/MonthPriceEditor.js';
import { QueryStates } from '../components/states.js';
import { useFormatter, usePermission } from '../lib/store.js';
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

interface ItemDetail extends ItemRow {
  notes: string | null;
  first_bought_on: string | null;
  version: number;
}

type Tab = 'overview' | 'prices' | 'movements' | 'history';

/**
 * The material detail page (FR-307): stock and the two derived dates on the header card, then
 * the monthly prices, the movements that produced the stock, and this material's History.
 */
export function MaterialDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const formatter = useFormatter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const maySetPrices = usePermission('materials.set_prices');
  const mayRecordStock = usePermission('materials.opening_stock');

  const [tab, setTab] = useState<Tab>('overview');
  const [priceSheet, setPriceSheet] = useState<{ month: string; existing?: MonthPrice } | null>(null);
  const [stockSheet, setStockSheet] = useState<'opening' | 'adjustment' | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const item = useQuery({
    queryKey: ['items', id],
    queryFn: () => apiRequest<ItemDetail>(`/items/${id}`),
  });

  const rate = useQuery({
    queryKey: ['global-rate'],
    queryFn: () =>
      apiRequest<{ current: { rate_iqd_per_usd: string; is_stale: boolean } | null }>('/settings/global-rates'),
  });

  const prices = useQuery({
    queryKey: ['items', id, 'prices'],
    queryFn: () => apiRequest<{ items: MonthPrice[] }>(`/items/${id}/prices`),
    enabled: tab === 'prices',
  });

  const movements = useQuery({
    queryKey: ['items', id, 'movements'],
    queryFn: () => apiRequest<{ items: Movement[]; total: number }>(`/items/${id}/movements`),
    enabled: tab === 'movements',
  });

  const history = useQuery({
    queryKey: ['items', id, 'history'],
    queryFn: () =>
      apiRequest<{ items: { id: string; action: string; occurred_at: string; actor_display_name: string | null; note: string | null }[] }>(
        `/items/${id}/history`,
      ),
    enabled: tab === 'history',
  });

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

  const recordStock = useMutation({
    mutationFn: (input: { kind: 'opening' | 'adjustment'; body: unknown }) =>
      apiRequest(`/items/${id}/${input.kind === 'opening' ? 'opening-stock' : 'stock-adjustments'}`, {
        method: 'POST',
        body: input.body,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      setStockSheet(null);
      setToast(t('materials:stock_recorded'));
      await queryClient.invalidateQueries({ queryKey: ['items'] });
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

  return (
    <AppShell title={item.data?.name ?? t('materials:title')}>
      <div className="mz-stack">
        <QueryStates query={item}>
          {item.data ? (
            <>
              <Card>
                <div className="mz-row mz-row--between">
                  <div>
                    <h2 className="mz-title">{item.data.name}</h2>
                    <span className="mz-caption">
                      {t(`glossary:${item.data.pricing_unit}`)}
                      {item.data.code ? ` · ${item.data.code}` : ''}
                    </span>
                  </div>
                  {!item.data.is_active ? <Chip icon="close">{t('common:deactivated')}</Chip> : null}
                </div>

                <p className="mz-title" data-tabular style={{ marginBlockStart: 'var(--space-3)' }}>
                  {item.data.stock.priced_complete
                    ? `${formatter.number(item.data.stock.priced_quantity, item.data.stock.priced_measure === 'kg' ? 3 : 0)} ${t(
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
                      ? formatter.number(item.data.stock.stock_kg, 3)
                      : '—'}
                </span>
                <span className="mz-caption" style={{ display: 'block' }}>
                  {t('glossary:date_bought')}: {item.data.first_bought_on ? formatter.date(item.data.first_bought_on) : '—'}
                  {' · '}
                  {t('glossary:date_sold')}: {item.data.last_sold_on ? formatter.date(item.data.last_sold_on) : '—'}
                </span>
              </Card>

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
                  <Card>
                    <h3 className="mz-heading">{t('materials:this_month_prices')}</h3>
                    <div className="mz-row mz-row--between" style={{ marginBlockStart: 'var(--space-2)' }}>
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
                        {t('materials:price_from', { month: formatter.month(item.data.sale.from_month.slice(0, 7)) })}
                      </span>
                    ) : null}
                    {item.data.bought ? (
                      <div className="mz-row mz-row--between" style={{ marginBlockStart: 'var(--space-2)' }}>
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
                      <p>{item.data.notes}</p>
                    </Card>
                  ) : null}

                  {mayRecordStock ? (
                    <div className="mz-row" style={{ gap: 'var(--space-2)' }}>
                      <Button variant="secondary" onClick={() => setStockSheet('opening')}>
                        {t('glossary:opening_stock')}
                      </Button>
                      <Button variant="secondary" onClick={() => setStockSheet('adjustment')}>
                        {t('materials:correct_stock')}
                      </Button>
                    </div>
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
                            <DualAmount amount_iqd={row.sale.amount_iqd} amount_usd_cents={row.sale.amount_usd_cents} />
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
                            <Button variant="ghost" onClick={() => setPriceSheet({ month: row.month, existing: row })}>
                              {t('common:edit')}
                            </Button>
                          ) : null}
                        </span>
                      </div>
                    ))}
                  </Card>
                </QueryStates>
              ) : null}

              {tab === 'movements' ? (
                <QueryStates
                  query={movements}
                  isEmpty={(movements.data?.items.length ?? 0) === 0}
                  emptyTitle={t('materials:no_movements')}
                >
                  <Card>
                    <ul className="mz-list">
                      {(movements.data?.items ?? []).map((movement) => (
                        <li key={movement.id} className="mz-list__item">
                          <span className="mz-list__body">
                            <span className="mz-list__title">{t(`materials:movement.${movement.movement_type}`)}</span>
                            <span className="mz-caption">
                              {formatter.date(movement.entry_date)}
                              {movement.performed_by ? ` · ${movement.performed_by}` : ''}
                              {movement.note ? ` · ${movement.note}` : ''}
                            </span>
                          </span>
                          <span data-tabular style={{ opacity: movement.is_live ? 1 : 0.5 }}>
                            {movement.qty_kg !== null
                              ? `${formatter.number(movement.qty_kg, 3)} ${t('common:kg_symbol')}`
                              : null}
                            {movement.qty_count !== null ? ` ${formatter.number(movement.qty_count)}` : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                </QueryStates>
              ) : null}

              {tab === 'history' ? (
                <QueryStates
                  query={history}
                  isEmpty={(history.data?.items.length ?? 0) === 0}
                  emptyTitle={t('history:empty')}
                >
                  <Card>
                    <ul className="mz-list">
                      {(history.data?.items ?? []).map((entry) => (
                        <li key={entry.id} className="mz-list__item">
                          <span className="mz-list__body">
                            <span className="mz-list__title">{t(`history:action.${entry.action}`)}</span>
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

        {stockSheet ? (
          <StockSheet
            kind={stockSheet}
            pricedMeasure={item.data?.stock.priced_measure ?? 'count'}
            saving={recordStock.isPending}
            error={
              recordStock.error instanceof ApiError
                ? t(recordStock.error.fields[0]?.message_key ?? 'errors:VALIDATION_FAILED')
                : undefined
            }
            onClose={() => setStockSheet(null)}
            onSave={(body) => recordStock.mutate({ kind: stockSheet, body })}
          />
        ) : null}

        {toast ? <Toast message={toast} actionLabel={t('common:close')} onAction={() => setToast(null)} /> : null}
        <Button variant="ghost" onClick={() => navigate('/materials')}>
          {t('common:back')}
        </Button>
      </div>
    </AppShell>
  );
}

function toMoneyBody(value: { amount: number | null; currency: 'IQD' | 'USD'; other_amount?: number | null }) {
  return value.amount === null
    ? null
    : { amount: value.amount, currency: value.currency, other_amount: value.other_amount ?? null };
}

/** Opening stock and corrections: both are movements with a mandatory note (FR-303, FR-308). */
function StockSheet({
  kind,
  pricedMeasure,
  saving,
  error,
  onClose,
  onSave,
}: {
  kind: 'opening' | 'adjustment';
  pricedMeasure: 'count' | 'kg';
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (body: unknown) => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [date, setDate] = useState(formatter.today());
  const [count, setCount] = useState('');
  const [kg, setKg] = useState('');
  const [note, setNote] = useState('');

  return (
    <BottomSheet
      title={kind === 'opening' ? t('glossary:opening_stock') : t('materials:correct_stock')}
      open
      onClose={onClose}
      closeLabel={t('common:close')}
    >
      <div className="mz-stack">
        <DateField label={t('common:date')} value={date} max={formatter.today()} onChange={(event) => setDate(event.target.value)} />
        <div className="mz-grid-2">
          <NumberField
            label={t('glossary:count')}
            value={count}
            hint={pricedMeasure === 'count' ? undefined : t('orders:for_information')}
            onChange={(event) => setCount(event.target.value)}
          />
          <NumberField
            label={t('glossary:weight_kg')}
            unit={t('common:kg_symbol')}
            decimals={3}
            value={kg}
            hint={pricedMeasure === 'kg' ? undefined : t('orders:for_information')}
            onChange={(event) => setKg(event.target.value)}
          />
        </div>
        <TextField
          label={t('common:note')}
          value={note}
          error={error}
          onChange={(event) => setNote(event.target.value)}
          hint={t('materials:note_required')}
        />
        <Button
          block
          loading={saving}
          disabled={note.trim() === '' || (count.trim() === '' && kg.trim() === '')}
          onClick={() =>
            onSave({
              entry_date: date,
              qty_count: count.trim() === '' ? null : Math.round(Number(count)),
              qty_kg: kg.trim() === '' ? null : kg.trim(),
              note: note.trim(),
            })
          }
        >
          {t('common:save')}
        </Button>
      </div>
    </BottomSheet>
  );
}

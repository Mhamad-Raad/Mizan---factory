import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet, Button, Card, Chip, Icon, SegmentedControl, TextField, Toast } from '@mizan/ui';
import { ApiError, apiRequest, newIdempotencyKey } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { DualAmount } from '../components/DualAmount.js';
import { Can } from '../components/Can.js';
import { QueryStates } from '../components/states.js';
import { Pager } from '../components/Pager.js';
import { useCursorPaging } from '../lib/paging.js';
import { PriceFromMonth, RateBadge } from '../components/chips.js';
import { useFormatter, usePermission } from '../lib/store.js';
import type { PurchaseDetail } from './PurchasesPage.js';

type Tab = 'lines' | 'history';

interface PurchaseHistory {
  next_cursor: string | null;
  items: { id: string; action: string; occurred_at: string; actor_display_name: string | null; note: string | null }[];
}

/**
 * One buy (D-062): stock we bought for ourselves — made by creating a material or adding to one
 * in Materials, never with a company. The header says when and who, the total at its rate, the
 * materials it brought in at their own prices, and its History. It can be voided while none of its
 * stock has gone out; once some has been sold or damaged it is the cost of those, and the API
 * refuses (BUY_IN_USE) — the sheet says so in words.
 */
export function PurchaseDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const formatter = useFormatter();
  const queryClient = useQueryClient();
  const mayVoid = usePermission('purchases.void');

  const [tab, setTab] = useState<Tab>('lines');
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  const purchase = useQuery({
    queryKey: ['purchases', id],
    queryFn: () => apiRequest<PurchaseDetail>(`/purchases/${id}`),
  });
  const data = purchase.data;


  // The audit trail is paged by cursor (D-058).
  const historyPaging = useCursorPaging({ storageKey: 'record-history', resetOn: [id] });
  const history = useQuery({
    queryKey: ['purchases', id, 'history', historyPaging.cursor, historyPaging.pageSize],
    queryFn: () => apiRequest<PurchaseHistory>(`/purchases/${id}/history?${historyPaging.query}`),
    enabled: tab === 'history',
    placeholderData: keepPreviousData,
  });
  const historyNext = history.data?.next_cursor ?? null;

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['purchases'] });
    await queryClient.invalidateQueries({ queryKey: ['items'] });
    await queryClient.invalidateQueries({ queryKey: ['accounts'] });
  };

  const voidPurchase = useMutation({
    mutationFn: () =>
      apiRequest(`/purchases/${id}/void`, {
        method: 'POST',
        body: { reason: reason.trim(), version: purchase.data?.version },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      setVoiding(false);
      setToast(t('purchases:voided'));
      await invalidate();
    },
  });

  const settlement = data?.settlement_currency ?? 'IQD';
  const active = data?.doc_status === 'active';

  usePageTitle(data ? t('purchases:number', { number: formatter.identifier(data.number) }) : t('purchases:title'));

  return (
    <>
      <div className="mz-stack">
        <QueryStates query={purchase}>
          {data ? (
            <>
              {data.doc_status === 'void' ? (
                <div className="mz-warning" role="status">
                  {t('purchases:void_banner', {
                    employee: data.voided_by_name ?? '',
                    reason: data.void_reason ?? '',
                  })}
                </div>
              ) : null}

              <Card>
                <div className="mz-row mz-row--between" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
                  <div className="mz-stack" style={{ gap: '2px', minInlineSize: 0 }}>
                    <h2 className="mz-title">{t('purchases:number', { number: formatter.identifier(data.number) })}</h2>
                    <span className="mz-caption">{t('purchases:buy_caption')}</span>
                    <span className="mz-caption" style={{ display: 'block' }}>
                      {formatter.date(data.purchase_date)}
                      {data.acting_user_name ? ` · ${t('glossary:done_by')}: ${data.acting_user_name}` : ''}
                    </span>
                    {data.notes ? (
                      <span className="mz-caption" style={{ display: 'block' }}>
                        <bdi>{data.notes}</bdi>
                      </span>
                    ) : null}
                  </div>
                  <span className="mz-row" style={{ gap: 'var(--space-1)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {data.doc_status === 'void' ? (
                      <Chip tone="danger" icon="close">
                        {t('glossary:void')}
                      </Chip>
                    ) : null}
                  </span>
                </div>

                <hr className="mz-divider" />

                <div className="mz-detail-summary">
                  <div className="mz-stack" style={{ gap: 'var(--space-2)' }}>
                    <span className="mz-figure__label">{t('glossary:total')}</span>
                    {data.cost ? (
                      <DualAmount
                        amount_iqd={data.cost.total_iqd}
                        amount_usd_cents={data.cost.total_usd_cents}
                        primary={settlement}
                        size="large"
                      />
                    ) : (
                      <span className="mz-muted">—</span>
                    )}
                    <span className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                      <RateBadge rate={data.rate_iqd_per_usd} source={data.rate_source} />
                    </span>
                  </div>

                  <div className="mz-detail-figures">
                    {data.cost && data.cost.discount_iqd > 0 ? (
                      <div className="mz-figure">
                        <span className="mz-figure__label">{t('glossary:discount')}</span>
                        <span className="mz-figure__value" data-tabular>
                          {formatter.money(data.cost.discount_iqd, 'IQD')}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>
              </Card>

              {/* Its damage, and — set apart at the end — Void, so it is never a slip. Buying more
                  is done from the material itself (D-062). */}
              <div className="mz-actions">
                <div className="mz-actions__group">
                  {/* What arrived damaged in this delivery (FR-802, FR-805). */}
                  <Can permission="damages.view">
                    <Link to={`/damages?purchase=${id}`} className="mz-button mz-button--secondary">
                      <Icon name="warning" />
                      {t('glossary:damaged_items')}
                    </Link>
                  </Can>
                </div>

                {active && mayVoid ? (
                  <div className="mz-actions__group mz-actions__group--end">
                    <Button variant="danger" icon="trash" onClick={() => setVoiding(true)}>
                      {t('purchases:void_purchase')}
                    </Button>
                  </div>
                ) : null}
              </div>

              <SegmentedControl
                label={t('common:more')}
                value={tab}
                onChange={setTab}
                options={[
                  { value: 'lines', label: t('orders:lines') },
                  { value: 'history', label: t('glossary:history') },
                ]}
              />

              {tab === 'lines' ? (
                <ul className="mz-list">
                  {data.lines.map((line) => (
                    <li key={line.id} className="mz-list__item mz-list__item--detail">
                      <span className="mz-row-lead">
                        <Icon name="materials" size={18} />
                      </span>
                      <span className="mz-list__body">
                        <span className="mz-list__title">
                          <Link to={`/materials/${line.item_id}`} className="mz-quiet-link">
                            <bdi>{line.item_name}</bdi>
                          </Link>
                        </span>
                        <span className="mz-caption" style={{ display: 'block' }} data-tabular>
                          {quantityOf(line, formatter, t)}
                          {line.cost ? (
                            <>
                              {' × '}
                              {formatter.money(
                                line.cost.price_entered_currency === 'IQD'
                                  ? line.cost.unit_price_iqd
                                  : line.cost.unit_price_usd_cents,
                                line.cost.price_entered_currency,
                              )}
                            </>
                          ) : null}
                        </span>
                        {line.cost?.price_source === 'override' ? (
                          <Chip tone="warning">{t('purchases:price_override')}</Chip>
                        ) : line.cost?.price_from_month ? (
                          <PriceFromMonth month={line.cost.price_from_month} />
                        ) : null}
                        {line.note ? (
                          <span className="mz-caption" style={{ display: 'block' }}>
                            <bdi>{line.note}</bdi>
                          </span>
                        ) : null}
                      </span>
                      {line.cost ? (
                        <span className="mz-list__end">
                          <DualAmount
                            amount_iqd={line.cost.line_total_iqd}
                            amount_usd_cents={line.cost.line_total_usd_cents}
                            primary={settlement}
                          />
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
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
                          <Icon name={row.action === 'void' ? 'close' : row.action === 'create' ? 'plus' : 'history'} size={18} />
                        </span>
                        <span className="mz-list__body">
                          <span className="mz-list__title">{t(`history:action.${row.action}`)}</span>
                          <span className="mz-caption">
                            {formatter.timestamp(new Date(row.occurred_at))}
                            {row.actor_display_name ? ` · ${row.actor_display_name}` : ''}
                          </span>
                          {row.note ? (
                            <span className="mz-caption" style={{ display: 'block' }}>
                              <bdi>{row.note}</bdi>
                            </span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
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

        {voiding && data ? (
          <BottomSheet
            title={t('purchases:void_purchase')}
            open
            onClose={() => setVoiding(false)}
            closeLabel={t('common:close')}
          >
            <div className="mz-stack">
              <p>
                {t('purchases:void_explanation', {
                  count: data.lines.length,
                  amount: data.cost ? formatter.money(data.cost.total_iqd, 'IQD') : '',
                })}
              </p>
              <TextField
                label={t('glossary:reason')}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={2000}
              />
              {voidPurchase.error instanceof ApiError ? (
                <div className="mz-warning" role="alert">
                  {t(voidPurchase.error.messageKey, { defaultValue: t('errors:INTERNAL') })}
                </div>
              ) : null}
              <Button
                block
                loading={voidPurchase.isPending}
                disabled={reason.trim() === ''}
                onClick={() => voidPurchase.mutate()}
              >
                {t('purchases:void_purchase')}
              </Button>
            </div>
          </BottomSheet>
        ) : null}

        {toast ? <Toast message={toast} actionLabel={t('common:close')} onAction={() => setToast(null)} /> : null}
      </div>
    </>
  );
}

/** The priced measure first, the other one after it when it was recorded too. */
function quantityOf(
  line: PurchaseDetail['lines'][number],
  formatter: ReturnType<typeof useFormatter>,
  t: (key: string) => string,
): string {
  const kg = line.qty_kg !== null ? `${formatter.quantity(line.qty_kg)} ${t('common:kg_symbol')}` : null;
  const count = line.qty_count !== null ? `${formatter.number(line.qty_count)} ${t('common:count_symbol')}` : null;
  const [first, second] = line.priced_measure === 'kg' ? [kg, count] : [count, kg];
  return [first, second].filter(Boolean).join(' · ');
}

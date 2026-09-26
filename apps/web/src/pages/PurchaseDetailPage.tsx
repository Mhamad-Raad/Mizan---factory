import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet, Button, Card, Chip, TextField, Toast } from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { ApiError, apiRequest, newIdempotencyKey } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { DualAmount } from '../components/DualAmount.js';
import { Can } from '../components/Can.js';
import { QueryStates } from '../components/states.js';
import { PriceFromMonth, RateBadge } from '../components/chips.js';
import { useFormatter, usePermission } from '../lib/store.js';
import type { PurchaseDetail } from './PurchasesPage.js';

type Tab = 'lines' | 'history';

interface PurchaseHistory {
  items: { id: string; action: string; occurred_at: string; actor_display_name: string | null; note: string | null }[];
  ledger_entries: {
    id: string;
    entry_type: string;
    entry_date: string;
    entered_currency: Currency | null;
    rate_iqd_per_usd: string;
    note: string | null;
    voucher_number: number | null;
    reverses_entry_id: string | null;
    cost?: { amount_iqd: number; amount_usd_cents: number } | null;
  }[];
}

/**
 * The purchase detail page (spec 3.3): the header with the company — or "Stock only" — the
 * totals, "We owe for this purchase" for those allowed to see money (FR-712), the lines with
 * their price source, and History including the company entries that name this purchase.
 */
export function PurchaseDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const formatter = useFormatter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mayVoid = usePermission('purchases.void');
  const mayEdit = usePermission('purchases.edit');
  const maySeeBalance = usePermission('fields.see_company_balances');

  const [tab, setTab] = useState<Tab>('lines');
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  const purchase = useQuery({
    queryKey: ['purchases', id],
    queryFn: () => apiRequest<PurchaseDetail>(`/purchases/${id}`),
  });

  const balance = useQuery({
    queryKey: ['purchases', id, 'balance'],
    queryFn: () =>
      apiRequest<{
        settlement_currency: Currency | null;
        cost: { total: number | null; linked: number | null; allocated: number | null; remaining: number | null };
      }>(`/purchases/${id}/balance`),
    enabled: maySeeBalance && Boolean(purchase.data?.company_id),
  });

  const history = useQuery({
    queryKey: ['purchases', id, 'history'],
    queryFn: () => apiRequest<PurchaseHistory>(`/purchases/${id}/history`),
    enabled: tab === 'history',
  });

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
      await queryClient.invalidateQueries({ queryKey: ['purchases'] });
      await queryClient.invalidateQueries({ queryKey: ['companies'] });
      await queryClient.invalidateQueries({ queryKey: ['items'] });
    },
  });

  const data = purchase.data;
  const settlement = data?.settlement_currency ?? 'IQD';
  const remaining = balance.data?.cost.remaining ?? null;

  usePageTitle(data ? t('purchases:number', { number: formatter.number(data.number) }) : t('purchases:title'));

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
                <div className="mz-row mz-row--between">
                  <div>
                    <h2 className="mz-title">
                      {data.company_id ? (
                        <Link to={`/companies/${data.company_id}`}><bdi>{data.company_name}</bdi></Link>
                      ) : (
                        t('purchases:stock_only_badge')
                      )}
                    </h2>
                    <span className="mz-caption" style={{ display: 'block' }}>
                      {formatter.date(data.purchase_date)}
                      {data.acting_user_name ? ` · ${data.acting_user_name}` : ''}
                    </span>
                    {data.notes ? <span className="mz-caption">{data.notes}</span> : null}
                  </div>
                  <span className="mz-list__end">
                    {data.doc_status === 'void' ? (
                      <Chip tone="danger" icon="close">
                        {t('glossary:void')}
                      </Chip>
                    ) : null}
                    <RateBadge rate={data.rate_iqd_per_usd} source={data.rate_source} />
                  </span>
                </div>

                {data.cost ? (
                  <div style={{ marginBlockStart: 'var(--space-3)' }}>
                    <span className="mz-caption" style={{ display: 'block' }}>
                      {t('glossary:total')}
                    </span>
                    <DualAmount
                      amount_iqd={data.cost.total_iqd}
                      amount_usd_cents={data.cost.total_usd_cents}
                      primary={settlement}
                      size="large"
                    />
                    {data.cost.discount_iqd > 0 ? (
                      <div className="mz-row mz-row--between">
                        <span className="mz-caption">{t('glossary:discount')}</span>
                        <DualAmount
                          amount_iqd={data.cost.discount_iqd}
                          amount_usd_cents={data.cost.discount_usd_cents}
                          primary={settlement}
                        />
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* "We owe for this purchase" (FR-712): its total less what is linked to it and
                    less its oldest-first share of the payments that named no purchase. */}
                {data.company_id && remaining !== null ? (
                  <div className="mz-row mz-row--between" style={{ marginBlockStart: 'var(--space-2)' }}>
                    <span className="mz-caption">{t('purchases:we_owe_for_this')}</span>
                    <span data-tabular>{formatter.money(remaining, settlement)}</span>
                  </div>
                ) : null}
              </Card>

              <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                {data.doc_status === 'active' && mayEdit ? (
                  <Link to={`/purchases/${id}/edit`} className="mz-button mz-button--secondary">
                    {t('common:edit')}
                  </Link>
                ) : null}
                {data.doc_status === 'active' && mayVoid ? (
                  <Button variant="secondary" onClick={() => setVoiding(true)}>
                    {t('purchases:void_purchase')}
                  </Button>
                ) : null}
                <Link
                  to={`/purchases/new${data.company_id ? `?company=${data.company_id}` : ''}`}
                  className="mz-button mz-button--ghost"
                >
                  {t('purchases:duplicate')}
                </Link>
                {/* What arrived damaged in this delivery (FR-802, FR-805). */}
                <Can permission="damages.view">
                  <Link to={`/damages?purchase=${id}`} className="mz-button mz-button--ghost">
                    {t('glossary:damaged_items')}
                  </Link>
                </Can>
              </div>

              <div className="mz-row" style={{ gap: 'var(--space-2)' }}>
                <Button variant={tab === 'lines' ? 'secondary' : 'ghost'} onClick={() => setTab('lines')}>
                  {t('orders:lines')}
                </Button>
                <Button variant={tab === 'history' ? 'secondary' : 'ghost'} onClick={() => setTab('history')}>
                  {t('glossary:history')}
                </Button>
              </div>

              {tab === 'lines' ? (
                <Card>
                  <ul className="mz-list">
                    {data.lines.map((line) => (
                      <li key={line.id} className="mz-list__item">
                        <span className="mz-list__body">
                          <span className="mz-list__title">
                            <Link to={`/materials/${line.item_id}`}><bdi>{line.item_name}</bdi></Link>
                          </span>
                          <span className="mz-caption" style={{ display: 'block' }}>
                            {line.priced_measure === 'kg'
                              ? `${formatter.number(line.qty_kg ?? '0', 3)} ${t('common:kg_symbol')}`
                              : `${formatter.number(line.qty_count ?? 0)} ${t('common:count_symbol')}`}
                            {line.priced_measure === 'kg' && line.qty_count !== null
                              ? ` · ${formatter.number(line.qty_count)} ${t('common:count_symbol')}`
                              : ''}
                            {line.priced_measure === 'count' && line.qty_kg !== null
                              ? ` · ${formatter.number(line.qty_kg, 3)} ${t('common:kg_symbol')}`
                              : ''}
                          </span>
                          {line.cost ? (
                            <span className="mz-caption" style={{ display: 'block' }}>
                              {line.cost.price_source === 'month'
                                ? t('orders:from_month_price')
                                : t('purchases:price_override')}
                              {line.cost.price_from_month ? (
                                <PriceFromMonth month={line.cost.price_from_month} />
                              ) : null}
                            </span>
                          ) : null}
                          {line.note ? <span className="mz-caption"><bdi>{line.note}</bdi></span> : null}
                        </span>
                        {line.cost ? (
                          <span className="mz-list__end">
                            <DualAmount
                              amount_iqd={line.cost.line_total_iqd}
                              amount_usd_cents={line.cost.line_total_usd_cents}
                              primary={settlement}
                            />
                            <span className="mz-caption" style={{ display: 'block' }} data-tabular>
                              {formatter.money(line.cost.unit_price_iqd, 'IQD')}
                            </span>
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : null}

              {tab === 'history' ? (
                <QueryStates
                  query={history}
                  isEmpty={(history.data?.items.length ?? 0) === 0}
                  emptyTitle={t('history:empty')}
                >
                  <Card>
                    <ul className="mz-list">
                      {(history.data?.items ?? []).map((row) => (
                        <li key={row.id} className="mz-list__item">
                          <span className="mz-list__body">
                            <span className="mz-list__title">{t(`history:action.${row.action}`)}</span>
                            <span className="mz-caption">
                              {formatter.timestamp(new Date(row.occurred_at))}
                              {row.actor_display_name ? ` · ${row.actor_display_name}` : ''}
                              {row.note ? ` · ${row.note}` : ''}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>

                    {(history.data?.ledger_entries ?? []).length > 0 ? (
                      <ul className="mz-list">
                        {(history.data?.ledger_entries ?? []).map((entry) => (
                          <li key={entry.id} className="mz-list__item">
                            <span className="mz-list__body">
                              <span className="mz-list__title">{t(`companies:entry.${entry.entry_type}`)}</span>
                              <span className="mz-caption">
                                {formatter.date(entry.entry_date)}
                                {entry.note ? ` · ${entry.note}` : ''}
                              </span>
                            </span>
                            {entry.cost ? (
                              <DualAmount
                                amount_iqd={entry.cost.amount_iqd}
                                amount_usd_cents={entry.cost.amount_usd_cents}
                                primary={settlement}
                              />
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </Card>
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
        <Button variant="ghost" onClick={() => navigate('/purchases')}>
          {t('common:back')}
        </Button>
      </div>
    </>
  );
}

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet, Button, Card, Chip, Icon, SegmentedControl, TextField, Toast } from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { ApiError, apiRequest, newIdempotencyKey } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { DualAmount } from '../components/DualAmount.js';
import { Can } from '../components/Can.js';
import { QueryStates } from '../components/states.js';
import { Pager } from '../components/Pager.js';
import { PaymentSheet } from '../components/PaymentSheet.js';
import type { PaymentBody } from '../components/PaymentSheet.js';
import { useCursorPaging } from '../lib/paging.js';
import { PriceFromMonth, RateBadge } from '../components/chips.js';
import { useFormatter, usePermission } from '../lib/store.js';
import type { PurchaseDetail } from './PurchasesPage.js';

type Tab = 'lines' | 'payments' | 'history';

interface PurchaseHistory {
  next_cursor: string | null;
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
 * The purchase detail page (spec 3.3), laid out as the order's is (client review): the header
 * with the purchase number, the company — or "Stock only" — and who recorded it; the total and
 * "We owe for this purchase" (FR-712) side by side; the actions in three groups — pay, work with
 * the document, and Void set apart at the end; then Lines, Payments and History as one control.
 *
 * "Pay for this purchase" records a company payment that names this purchase, so it comes off
 * this purchase first rather than the oldest one (FR-712); the amount is pre-filled with what
 * this purchase still owes.
 */
export function PurchaseDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const formatter = useFormatter();
  const queryClient = useQueryClient();
  const mayVoid = usePermission('purchases.void');
  const mayEdit = usePermission('purchases.edit');
  const maySeeBalance = usePermission('fields.see_company_balances');
  const mayPay = usePermission('companies.record_payment');
  const maySeeCompany = usePermission('customers.view');

  const [tab, setTab] = useState<Tab>('lines');
  const [voiding, setVoiding] = useState(false);
  const [paying, setPaying] = useState(false);
  const [reason, setReason] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  const purchase = useQuery({
    queryKey: ['purchases', id],
    queryFn: () => apiRequest<PurchaseDetail>(`/purchases/${id}`),
  });
  const data = purchase.data;
  const companyId = data?.company_id ?? null;

  const balance = useQuery({
    queryKey: ['purchases', id, 'balance'],
    queryFn: () =>
      apiRequest<{
        settlement_currency: Currency | null;
        cost: { total: number | null; linked: number | null; allocated: number | null; remaining: number | null };
      }>(`/purchases/${id}/balance`),
    enabled: maySeeBalance && Boolean(companyId),
  });

  // The rate a payment made today is shown at: the company's own when it has one (D-054),
  // otherwise the system rate. The server converts with the same rule; this is the preview.
  const globalRate = useQuery({
    queryKey: ['global-rate'],
    queryFn: () => apiRequest<{ current: { rate_iqd_per_usd: string } | null }>('/settings/global-rates'),
    enabled: paying,
  });
  const company = useQuery({
    queryKey: ['customers', companyId],
    queryFn: () => apiRequest<{ rate?: { rate_iqd_per_usd: string } | null }>(`/customers/${companyId}`),
    enabled: paying && maySeeCompany && Boolean(companyId),
  });

  // The audit trail is paged by cursor (D-058); the purchase's own money rows ride on every page.
  const historyPaging = useCursorPaging({ storageKey: 'record-history', resetOn: [id] });
  const history = useQuery({
    queryKey: ['purchases', id, 'history', historyPaging.cursor, historyPaging.pageSize],
    queryFn: () => apiRequest<PurchaseHistory>(`/purchases/${id}/history?${historyPaging.query}`),
    enabled: tab !== 'lines',
    placeholderData: keepPreviousData,
  });
  const historyNext = history.data?.next_cursor ?? null;
  // What was paid or credited against this purchase — everything but the purchase's own row.
  const payments = (history.data?.ledger_entries ?? []).filter((entry) => entry.entry_type !== 'purchase');

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['purchases'] });
    await queryClient.invalidateQueries({ queryKey: ['companies'] });
    await queryClient.invalidateQueries({ queryKey: ['customers'] });
    await queryClient.invalidateQueries({ queryKey: ['items'] });
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

  const payment = useMutation({
    mutationFn: (body: PaymentBody) =>
      apiRequest(`/companies/${companyId}/payments`, {
        method: 'POST',
        body: { ...body, purchase_id: id },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      setPaying(false);
      setToast(t('companies:payment_recorded'));
      await invalidate();
    },
  });

  const settlement = data?.settlement_currency ?? 'IQD';
  const remaining = balance.data?.cost.remaining ?? null;
  const active = data?.doc_status === 'active';
  const canPay = active && mayPay && Boolean(companyId) && (remaining === null || remaining > 0);
  const rate = company.data?.rate?.rate_iqd_per_usd ?? globalRate.data?.current?.rate_iqd_per_usd ?? null;

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
                <div className="mz-row mz-row--between" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
                  <div className="mz-stack" style={{ gap: '2px', minInlineSize: 0 }}>
                    <h2 className="mz-title">{t('purchases:number', { number: formatter.number(data.number) })}</h2>
                    {data.company_id ? (
                      maySeeCompany ? (
                        <Link to={`/customers/${data.company_id}`} className="mz-caption">
                          <bdi>{data.company_name}</bdi>
                        </Link>
                      ) : (
                        <span className="mz-caption">
                          <bdi>{data.company_name}</bdi>
                        </span>
                      )
                    ) : null}
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
                    {data.company_id === null ? <Chip>{t('purchases:stock_only_badge')}</Chip> : null}
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
                    {/* "We owe for this purchase" (FR-712): its total less what is linked to it and
                        less its oldest-first share of the payments that named no purchase. */}
                    {data.company_id && remaining !== null && active ? (
                      <div className="mz-figure">
                        <span className="mz-figure__label">{t('purchases:we_owe_for_this')}</span>
                        <span className={`mz-figure__value${remaining > 0 ? ' mz-figure__value--owed' : ''}`} data-tabular>
                          {formatter.money(remaining, settlement)}
                        </span>
                      </div>
                    ) : null}
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

              {/* Three groups, as on an order: pay, work with the document, and — set apart at
                  the end — the one destructive action, so Void is never a slip. */}
              <div className="mz-actions">
                {canPay ? (
                  <div className="mz-actions__group mz-actions__group--primary">
                    <Button icon="check" onClick={() => setPaying(true)}>
                      {t('purchases:make_payment')}
                    </Button>
                  </div>
                ) : null}

                <div className="mz-actions__group">
                  {active && mayEdit ? (
                    <Link to={`/purchases/${id}/edit`} className="mz-button mz-button--secondary">
                      <Icon name="edit" />
                      {t('common:edit')}
                    </Link>
                  ) : null}
                  <Can permission="purchases.create">
                    <Link
                      to={`/purchases/new${data.company_id ? `?company=${data.company_id}` : ''}`}
                      className="mz-button mz-button--secondary"
                    >
                      <Icon name="plus" />
                      {t('purchases:duplicate')}
                    </Link>
                  </Can>
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
                  ...(data.company_id ? [{ value: 'payments' as const, label: t('orders:payments') }] : []),
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

              {tab === 'payments' ? (
                <QueryStates
                  query={history}
                  isEmpty={payments.length === 0}
                  emptyTitle={t('purchases:no_payments')}
                  emptyAction={
                    canPay ? <Button onClick={() => setPaying(true)}>{t('purchases:make_payment')}</Button> : undefined
                  }
                >
                  <ul className="mz-list">
                    {payments.map((entry) => (
                      <li key={entry.id} className="mz-list__item mz-list__item--detail">
                        <span className="mz-row-lead">
                          <Icon name={entry.entry_type === 'reversal' ? 'refresh' : 'check'} size={18} />
                        </span>
                        <span className="mz-list__body">
                          <span className="mz-list__title">{t(`companies:entry.${entry.entry_type}`)}</span>
                          <span className="mz-caption">
                            {formatter.date(entry.entry_date)}
                            {entry.voucher_number
                              ? ` · ${t('customers:voucher_number', { number: formatter.number(entry.voucher_number) })}`
                              : ''}
                          </span>
                          {entry.note ? (
                            <span className="mz-caption" style={{ display: 'block' }}>
                              <bdi>{entry.note}</bdi>
                            </span>
                          ) : null}
                        </span>
                        {entry.cost ? (
                          <span className="mz-list__end">
                            {/* Stored signed; the row's title says what it was, so the amount
                                reads as the money that changed hands. */}
                            <DualAmount
                              amount_iqd={Math.abs(entry.cost.amount_iqd)}
                              amount_usd_cents={Math.abs(entry.cost.amount_usd_cents)}
                              primary={settlement}
                            />
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </QueryStates>
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

        {paying && data && rate ? (
          <PaymentSheet
            open
            title={t('purchases:make_payment')}
            amountLabel={t('companies:amount_paid')}
            remainingLabel={t('purchases:we_owe_for_this')}
            saveLabel={t('customers:make_payment')}
            settleHint={t('purchases:settle_in_full_hint')}
            remaining={Math.max(remaining ?? 0, 0)}
            settlement_currency={settlement}
            rate={rate}
            saving={payment.isPending}
            error={
              payment.error instanceof ApiError
                ? t(payment.error.messageKey, { defaultValue: t('errors:VALIDATION_FAILED') })
                : undefined
            }
            onClose={() => setPaying(false)}
            onSave={(body) => payment.mutate(body)}
          />
        ) : null}

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
  const kg = line.qty_kg !== null ? `${formatter.number(line.qty_kg, 3)} ${t('common:kg_symbol')}` : null;
  const count = line.qty_count !== null ? `${formatter.number(line.qty_count)} ${t('common:count_symbol')}` : null;
  const [first, second] = line.priced_measure === 'kg' ? [kg, count] : [count, kg];
  return [first, second].filter(Boolean).join(' · ');
}

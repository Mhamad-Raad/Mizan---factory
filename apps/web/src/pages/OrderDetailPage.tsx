import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet, Button, Card, Chip, DateField, Icon, SegmentedControl, TextField, Toast } from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { ApiError, apiRequest, newIdempotencyKey } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { Can } from '../components/Can.js';
import { DualAmount } from '../components/DualAmount.js';
import { PaymentSheet } from '../components/PaymentSheet.js';
import { QueryStates } from '../components/states.js';
import { OrderStatusChip, PaymentTypeChip, RateBadge } from '../components/chips.js';
import { useJustSettled } from '../lib/motion.js';
import { customerName } from '../lib/customers.js';
import { useFormatter, usePermission } from '../lib/store.js';
import type { OrderDetail } from './OrderFormPage.js';

type Tab = 'lines' | 'payments' | 'history';

interface OrderHistory {
  items: { id: string; action: string; occurred_at: string; actor_display_name: string | null; note: string | null }[];
  payment_type_changes: {
    id: string;
    from_type: string;
    to_type: string;
    note: string;
    changed_at: string;
    changed_by_name: string | null;
  }[];
  ledger_entries: {
    id: string;
    entry_type: string;
    entry_date: string;
    amount_iqd: number;
    amount_usd_cents: number;
    note: string | null;
    voucher_number: number | null;
    reverses_entry_id: string | null;
  }[];
}

/**
 * The order detail page (spec 3.3): the header with its chips, the totals and what is still
 * owed, then the lines, the payments with "Record payment", and the History including the
 * payment-type changes. A voided order keeps its banner and offers "Duplicate as new order"
 * rather than pretending it can be revived (FR-610).
 */
export function OrderDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const formatter = useFormatter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mayRecordPayment = usePermission('orders.record_payment');
  const mayChangeType = usePermission('orders.change_payment_type');
  const mayVoid = usePermission('orders.void');
  const maySeeBalance = usePermission('fields.see_customer_balances');

  const [tab, setTab] = useState<Tab>('lines');
  const [paying, setPaying] = useState(false);
  const [changingType, setChangingType] = useState(false);
  const [voiding, setVoiding] = useState(false);
  // The receipt is fetched once, kept in an off-screen block, and printed straight from the
  // Print button — no preview modal (the browser's own print dialog is the preview).
  const [receiptWanted, setReceiptWanted] = useState(false);
  const printPending = useRef(false);
  const [toast, setToast] = useState<string | null>(null);

  const order = useQuery({
    queryKey: ['orders', id],
    queryFn: () => apiRequest<OrderDetail>(`/orders/${id}`),
  });

  const rate = useQuery({
    queryKey: ['global-rate'],
    queryFn: () => apiRequest<{ current: { rate_iqd_per_usd: string } | null }>('/settings/global-rates'),
  });

  const history = useQuery({
    queryKey: ['orders', id, 'history'],
    queryFn: () => apiRequest<OrderHistory>(`/orders/${id}/history`),
    enabled: tab === 'history' || tab === 'payments',
  });

  const receiptData = useQuery({
    queryKey: ['orders', id, 'receipt'],
    queryFn: () =>
      apiRequest<{
        order: OrderDetail;
        customer: { name: string; is_system: boolean; phone: string | null; settlement_currency: Currency };
        balance_after: number | null;
      }>(`/orders/${id}/receipt`),
    enabled: receiptWanted,
  });

  // Print the moment the receipt data is in the DOM. The click handler enables the fetch and arms
  // the ref; this fires window.print() once — a side effect only, no state set inside the effect.
  useEffect(() => {
    if (printPending.current && receiptData.data) {
      printPending.current = false;
      window.print();
    }
  }, [receiptData.data]);

  const printReceipt = () => {
    if (receiptData.data) {
      window.print();
      return;
    }
    printPending.current = true;
    setReceiptWanted(true);
  };

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['orders'] });
    await queryClient.invalidateQueries({ queryKey: ['customers'] });
    await queryClient.invalidateQueries({ queryKey: ['items'] });
  };

  const payment = useMutation({
    mutationFn: (body: unknown) =>
      apiRequest(`/orders/${id}/payments`, { method: 'POST', body, idempotencyKey: newIdempotencyKey() }),
    onSuccess: async () => {
      setPaying(false);
      setToast(t('customers:payment_recorded'));
      await invalidate();
    },
  });

  const changeType = useMutation({
    mutationFn: (body: unknown) =>
      apiRequest(`/orders/${id}/payment-type`, { method: 'POST', body, idempotencyKey: newIdempotencyKey() }),
    onSuccess: async () => {
      setChangingType(false);
      setToast(t('orders:payment_type_changed'));
      await invalidate();
    },
  });

  const voidOrder = useMutation({
    mutationFn: (reason: string) =>
      apiRequest(`/orders/${id}/void`, {
        method: 'POST',
        body: { reason, version: order.data?.version },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      setVoiding(false);
      setToast(t('orders:voided'));
      await invalidate();
    },
  });

  const data = order.data;
  // The moment a payment brings this order to zero (signature moment 2, spec 3.6.2).
  const settled = useJustSettled(data?.remaining ?? 0);
  const excessNeeded =
    payment.error instanceof ApiError && payment.error.fieldError('amount')?.code === 'EXCEEDS_REMAINING';

  usePageTitle(data ? t('orders:number', { number: formatter.number(data.number) }) : t('orders:title'));

  return (
    <>
      <div className="mz-stack">
        <QueryStates query={order}>
          {data ? (
            <>
              {data.doc_status === 'void' ? (
                <div className="mz-warning" role="status">
                  {t('orders:void_banner', {
                    employee: data.voided_by_name ?? '',
                    reason: data.void_reason ?? '',
                  })}
                </div>
              ) : null}

              <Card className={settled ? 'mz-settled' : undefined}>
                <div
                  className="mz-row mz-row--between"
                  style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}
                >
                  <div className="mz-stack" style={{ gap: '2px' }}>
                    <h2 className="mz-title">{t('orders:number', { number: formatter.number(data.number) })}</h2>
                    <Link to={`/customers/${data.customer_id}`} className="mz-caption">
                      {customerName({ name: data.customer_name, is_system: data.customer_is_system }, t)}
                    </Link>
                    <span className="mz-caption" style={{ display: 'block' }}>
                      {formatter.date(data.order_date)}
                      {data.acting_user_name ? ` · ${t('glossary:done_by')}: ${data.acting_user_name}` : ''}
                    </span>
                  </div>
                  <span
                    className="mz-row"
                    style={{ gap: 'var(--space-1)', flexWrap: 'wrap', justifyContent: 'flex-end' }}
                  >
                    <PaymentTypeChip type={data.payment_type} />
                    <OrderStatusChip status={data.status} settling={settled} />
                  </span>
                </div>

                <hr className="mz-divider" />

                <div className="mz-detail-summary">
                  <div className="mz-stack" style={{ gap: 'var(--space-2)' }}>
                    <span className="mz-figure__label">{t('glossary:total')}</span>
                    <DualAmount
                      amount_iqd={data.total_iqd}
                      amount_usd_cents={data.total_usd_cents}
                      primary={data.settlement_currency}
                      size="large"
                    />
                    <span className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                      {data.received_currency ? (
                        <Chip tone="primary">
                          {t('orders:paid_in_currency', {
                            currency: t(`glossary:${data.received_currency.toLowerCase()}`),
                          })}
                        </Chip>
                      ) : null}
                      <RateBadge rate={data.rate_iqd_per_usd} source={data.rate_source} />
                    </span>
                  </div>

                  <div className="mz-detail-figures">
                    {maySeeBalance ? (
                      <div className="mz-figure">
                        <span className="mz-figure__label">{t('orders:remaining')}</span>
                        <span
                          className={`mz-figure__value${data.remaining > 0 ? ' mz-figure__value--owed' : ''}`}
                          data-tabular
                        >
                          {formatter.money(data.remaining, data.settlement_currency)}
                        </span>
                      </div>
                    ) : null}
                    {data.discount_iqd > 0 ? (
                      <div className="mz-figure">
                        <span className="mz-figure__label">{t('glossary:discount')}</span>
                        <span className="mz-figure__value" data-tabular>
                          {formatter.money(data.discount_iqd, 'IQD')}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>
              </Card>

              {/* The actions read as three groups: settle the money, work with the document, and —
                  set apart at the end — the one destructive action, so Void is never a slip. */}
              <div className="mz-actions">
                {data.doc_status === 'active' &&
                ((mayRecordPayment && data.status !== 'paid') || mayChangeType) ? (
                  <div className="mz-actions__group">
                    {mayRecordPayment && data.status !== 'paid' ? (
                      <Button icon="check" onClick={() => setPaying(true)}>
                        {t('customers:record_payment')}
                      </Button>
                    ) : null}
                    {mayChangeType ? (
                      <Button variant="secondary" icon="refresh" onClick={() => setChangingType(true)}>
                        {t('orders:change_payment_type')}
                      </Button>
                    ) : null}
                  </div>
                ) : null}

                <div className="mz-actions__group">
                  {data.doc_status === 'active' ? (
                    <Can permission="orders.view">
                      <Link to={`/orders/${id}/edit`} className="mz-button mz-button--secondary">
                        <Icon name="edit" />
                        {t('common:edit')}
                      </Link>
                    </Can>
                  ) : null}
                  <Button variant="secondary" icon="print" onClick={printReceipt}>
                    {t('common:print')}
                  </Button>
                  {data.doc_status === 'void' ? (
                    <Link
                      to={`/orders/new?customer=${data.customer_id}`}
                      className="mz-button mz-button--secondary"
                    >
                      <Icon name="plus" />
                      {t('orders:duplicate')}
                    </Link>
                  ) : null}
                  {/* What came back damaged from this order (FR-802, FR-806). */}
                  <Can permission="damages.view">
                    <Link to={`/damages?order=${id}`} className="mz-button mz-button--ghost">
                      <Icon name="warning" />
                      {t('glossary:damaged_items')}
                    </Link>
                  </Can>
                </div>

                {data.doc_status === 'active' && mayVoid ? (
                  <div className="mz-actions__group mz-actions__group--end">
                    <Button variant="danger" icon="trash" onClick={() => setVoiding(true)}>
                      {t('orders:void_order')}
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
                  { value: 'payments', label: t('orders:payments') },
                  { value: 'history', label: t('glossary:history') },
                ]}
              />

              {tab === 'lines' ? (
                <Card>
                  <ul className="mz-list">
                    {data.lines.map((line) => (
                      <li key={line.id} className="mz-list__item">
                        <span className="mz-row-lead">
                          <Icon name="materials" size={18} />
                        </span>
                        <span className="mz-list__body">
                          <span className="mz-list__title"><bdi>{line.item_name}</bdi></span>
                          <span className="mz-caption" style={{ display: 'block' }} data-tabular>
                            {line.priced_measure === 'kg'
                              ? `${formatter.number(line.qty_kg ?? '0', 3)} ${t('common:kg_symbol')}`
                              : formatter.number(line.qty_count ?? 0)}
                            {' × '}
                            {formatter.money(
                              line.price_entered_currency === 'IQD' ? line.unit_price_iqd : line.unit_price_usd_cents,
                              line.price_entered_currency,
                            )}
                          </span>
                          {line.price_source === 'override' ? (
                            <Chip tone="warning">{t('orders:price_overridden')}</Chip>
                          ) : null}
                        </span>
                        <span className="mz-list__end">
                          <DualAmount
                            amount_iqd={line.line_total_iqd}
                            amount_usd_cents={line.line_total_usd_cents}
                            primary={data.settlement_currency}
                          />
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : null}

              {tab === 'payments' ? (
                <QueryStates
                  query={history}
                  isEmpty={(history.data?.ledger_entries ?? []).filter((entry) => entry.entry_type !== 'order').length === 0}
                  emptyTitle={t('orders:no_payments')}
                  emptyAction={
                    mayRecordPayment && data.doc_status === 'active' ? (
                      <Button onClick={() => setPaying(true)}>{t('customers:record_payment')}</Button>
                    ) : undefined
                  }
                >
                  <Card>
                    <ul className="mz-list">
                      {(history.data?.ledger_entries ?? [])
                        .filter((entry) => entry.entry_type !== 'order')
                        .map((entry) => (
                          <li key={entry.id} className="mz-list__item">
                            <span className="mz-row-lead">
                              <Icon name="check" size={18} />
                            </span>
                            <span className="mz-list__body">
                              <span className="mz-list__title">{t(`customers:entry.${entry.entry_type}`)}</span>
                              <span className="mz-caption">
                                {formatter.date(entry.entry_date)}
                                {entry.voucher_number
                                  ? ` · ${t('customers:voucher_number', { number: formatter.number(entry.voucher_number) })}`
                                  : ''}
                                {entry.note ? ` · ${entry.note}` : ''}
                              </span>
                            </span>
                            <span className="mz-list__end">
                              <DualAmount
                                amount_iqd={entry.amount_iqd}
                                amount_usd_cents={entry.amount_usd_cents}
                                primary={data.settlement_currency}
                              />
                            </span>
                          </li>
                        ))}
                    </ul>
                  </Card>
                </QueryStates>
              ) : null}

              {tab === 'history' ? (
                <QueryStates query={history} isEmpty={(history.data?.items.length ?? 0) === 0} emptyTitle={t('history:empty')}>
                  <Card>
                    <ul className="mz-list">
                      {(history.data?.payment_type_changes ?? []).map((change) => (
                        <li key={change.id} className="mz-list__item">
                          <span className="mz-row-lead">
                            <Icon name="refresh" size={18} />
                          </span>
                          <span className="mz-list__body">
                            <span className="mz-list__title">
                              {t('orders:type_changed', {
                                from: t(`glossary:${change.from_type}`),
                                to: t(`glossary:${change.to_type}`),
                              })}
                            </span>
                            <span className="mz-caption">
                              {formatter.timestamp(new Date(change.changed_at))}
                              {change.changed_by_name ? ` · ${change.changed_by_name}` : ''} · {change.note}
                            </span>
                          </span>
                        </li>
                      ))}
                      {(history.data?.items ?? []).map((entry) => (
                        <li key={entry.id} className="mz-list__item">
                          <span className="mz-row-lead">
                            <Icon name="clock" size={18} />
                          </span>
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

        {paying && data ? (
          <PaymentSheet
            open
            remaining={Math.max(data.remaining, 0)}
            settlement_currency={data.settlement_currency}
            rate={rate.data?.current?.rate_iqd_per_usd ?? '1310.0000'}
            saving={payment.isPending}
            needsExcessConfirmation={excessNeeded}
            error={
              payment.error instanceof ApiError && !excessNeeded
                ? t(payment.error.messageKey, { defaultValue: t('errors:VALIDATION_FAILED') })
                : undefined
            }
            onClose={() => setPaying(false)}
            onSave={(body) => payment.mutate(body)}
          />
        ) : null}

        {changingType && data ? (
          <ChangePaymentTypeSheet
            currentType={data.payment_type}
            remaining={data.remaining}
            settlementCurrency={data.settlement_currency}
            saving={changeType.isPending}
            error={changeType.error instanceof ApiError ? t('errors:VALIDATION_FAILED') : undefined}
            onClose={() => setChangingType(false)}
            onSave={(body) => changeType.mutate(body)}
          />
        ) : null}

        {voiding && data ? (
          <VoidSheet
            saving={voidOrder.isPending}
            lineCount={data.lines.length}
            remaining={data.remaining}
            settlementCurrency={data.settlement_currency}
            onClose={() => setVoiding(false)}
            onSave={(reason) => voidOrder.mutate(reason)}
          />
        ) : null}

        {/* Kept off-screen and printed straight from the Print button — the browser's print dialog
            is the only preview, so there is no modal to dismiss first. A full invoice: who issued
            it, who it is for, the lines, the money, and the rate it was settled at. */}
        {receiptData.data
          ? (() => {
              const rc = receiptData.data;
              const subtotalIqd = rc.order.lines.reduce((sum, line) => sum + line.line_total_iqd, 0);
              return (
                <div className="mz-print-region" aria-hidden="true">
                  <div className="mz-invoice">
                    {/* Who issued it, and what this document is. */}
                    <header className="mz-invoice__head">
                      <div className="mz-invoice__brand">
                        <strong className="mz-invoice__name">{t('common:app_name')}</strong>
                        <span className="mz-invoice__muted">{t('common:app_tagline')}</span>
                      </div>
                      <div className="mz-invoice__doc">
                        <span className="mz-invoice__doctype">{t('glossary:receipt')}</span>
                        <strong>{t('orders:number', { number: formatter.number(rc.order.number) })}</strong>
                        <span className="mz-invoice__muted">{formatter.date(rc.order.order_date)}</span>
                      </div>
                    </header>

                    {/* Who it is for, and how it was paid. */}
                    <div className="mz-invoice__parties">
                      <div className="mz-invoice__party">
                        <span className="mz-invoice__label">{t('glossary:customer')}</span>
                        <strong>
                          {customerName({ name: rc.customer.name, is_system: rc.customer.is_system }, t)}
                        </strong>
                        {rc.customer.phone ? (
                          <span className="mz-invoice__muted">
                            <bdi>{rc.customer.phone}</bdi>
                          </span>
                        ) : null}
                      </div>
                      <div className="mz-invoice__party mz-invoice__party--end">
                        <span className="mz-invoice__label">{t('glossary:payment_type')}</span>
                        <strong>
                          {t(`glossary:${rc.order.payment_type}`)} · {t(`glossary:${rc.order.status}`)}
                        </strong>
                        {rc.order.acting_user_name ? (
                          <span className="mz-invoice__muted">
                            {t('glossary:done_by')}: {rc.order.acting_user_name}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    {/* The lines. */}
                    <table className="mz-invoice__table">
                      <thead>
                        <tr>
                          <th>{t('glossary:item')}</th>
                          <th className="mz-invoice__num">{t('glossary:quantity')}</th>
                          <th className="mz-invoice__num">{t('glossary:unit_price')}</th>
                          <th className="mz-invoice__num">{t('glossary:amount')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rc.order.lines.map((line) => (
                          <tr key={line.id}>
                            <td>
                              <bdi>{line.item_name}</bdi>
                            </td>
                            <td className="mz-invoice__num" data-tabular>
                              {line.priced_measure === 'kg'
                                ? `${formatter.number(line.qty_kg ?? '0', 3)} ${t('common:kg_symbol')}`
                                : formatter.number(line.qty_count ?? 0)}
                            </td>
                            <td className="mz-invoice__num" data-tabular>
                              {formatter.money(
                                line.price_entered_currency === 'IQD'
                                  ? line.unit_price_iqd
                                  : line.unit_price_usd_cents,
                                line.price_entered_currency,
                              )}
                            </td>
                            <td className="mz-invoice__num" data-tabular>
                              {formatter.money(line.line_total_iqd, 'IQD')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {/* The money. */}
                    <div className="mz-invoice__totals">
                      <div className="mz-invoice__total-row">
                        <span>{t('orders:subtotal')}</span>
                        <span data-tabular>{formatter.money(subtotalIqd, 'IQD')}</span>
                      </div>
                      {rc.order.discount_iqd > 0 ? (
                        <div className="mz-invoice__total-row">
                          <span>{t('glossary:discount')}</span>
                          <span data-tabular>−{formatter.money(rc.order.discount_iqd, 'IQD')}</span>
                        </div>
                      ) : null}
                      <div className="mz-invoice__total-row mz-invoice__total-row--grand">
                        <span>{t('glossary:total')}</span>
                        <strong>
                          <DualAmount
                            amount_iqd={rc.order.total_iqd}
                            amount_usd_cents={rc.order.total_usd_cents}
                            primary={rc.customer.settlement_currency}
                          />
                        </strong>
                      </div>
                      <div className="mz-invoice__total-row">
                        <span>{t('orders:remaining')}</span>
                        <span data-tabular>
                          {formatter.money(rc.order.remaining, rc.customer.settlement_currency)}
                        </span>
                      </div>
                      {rc.balance_after !== null ? (
                        <div className="mz-invoice__total-row">
                          <span>{t('glossary:balance')}</span>
                          <span data-tabular>
                            {formatter.money(rc.balance_after, rc.customer.settlement_currency)}
                          </span>
                        </div>
                      ) : null}
                    </div>

                    {/* The rate it was settled at, and a closing line. */}
                    <footer className="mz-invoice__foot">
                      <span>{t('common:rate_used', { rate: formatter.rate(rc.order.rate_iqd_per_usd) })}</span>
                      <span>
                        {t('orders:thank_you')} ·{' '}
                        {t('orders:printed_on', { date: formatter.date(formatter.today()) })}
                      </span>
                    </footer>
                  </div>
                </div>
              );
            })()
          : null}

        {toast ? <Toast message={toast} actionLabel={t('common:close')} onAction={() => setToast(null)} /> : null}
        <Button variant="ghost" onClick={() => navigate('/orders')}>
          {t('common:back')}
        </Button>
      </div>
    </>
  );
}

/**
 * The payment-type sheet (FR-605, flow 3.5.4). It says what the change will *do* before it
 * does it — settle the remainder today, or reverse the settlement and owe it again — and it
 * needs a note either way.
 */
function ChangePaymentTypeSheet({
  currentType,
  remaining,
  settlementCurrency,
  saving,
  error,
  onClose,
  onSave,
}: {
  currentType: 'cash' | 'borrowed';
  remaining: number;
  settlementCurrency: Currency;
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (body: unknown) => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const target = currentType === 'cash' ? 'borrowed' : 'cash';
  const [received, setReceived] = useState<Currency>('IQD');
  const [date, setDate] = useState(formatter.today());
  const [note, setNote] = useState('');

  return (
    <BottomSheet title={t('orders:change_payment_type')} open onClose={onClose} closeLabel={t('common:close')}>
      <div className="mz-stack">
        <p>
          {target === 'cash'
            ? t('orders:to_cash_explanation', { amount: formatter.money(remaining, settlementCurrency) })
            : t('orders:to_borrowed_explanation')}
        </p>

        {target === 'cash' ? (
          <>
            <SegmentedControl
              label={t('orders:paid_in')}
              value={received}
              onChange={setReceived}
              options={[
                { value: 'IQD', label: t('glossary:iqd') },
                { value: 'USD', label: t('glossary:usd') },
              ]}
            />
            <DateField
              label={t('glossary:date_paid')}
              value={date}
              max={formatter.today()}
              onChange={(event) => setDate(event.target.value)}
            />
          </>
        ) : null}

        <TextField
          label={t('common:note')}
          value={note}
          error={error}
          hint={t('materials:note_required')}
          onChange={(event) => setNote(event.target.value)}
        />

        <Button
          block
          loading={saving}
          disabled={note.trim() === ''}
          onClick={() =>
            onSave({
              to: target,
              note: note.trim(),
              entry_date: target === 'cash' ? date : undefined,
              received_currency: target === 'cash' ? received : null,
            })
          }
        >
          {t('glossary:confirm')}
        </Button>
      </div>
    </BottomSheet>
  );
}

/** Void (FR-610, flow 3.5.7): the sheet explains the effect, and the reason is required. */
function VoidSheet({
  saving,
  lineCount,
  remaining,
  settlementCurrency,
  onClose,
  onSave,
}: {
  saving: boolean;
  lineCount: number;
  remaining: number;
  settlementCurrency: Currency;
  onClose: () => void;
  onSave: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [reason, setReason] = useState('');

  return (
    <BottomSheet title={t('orders:void_order')} open onClose={onClose} closeLabel={t('common:close')}>
      <div className="mz-stack">
        <p>
          {t('orders:void_explanation', {
            count: lineCount,
            amount: formatter.money(remaining, settlementCurrency),
          })}
        </p>
        <TextField
          label={t('glossary:reason')}
          value={reason}
          hint={t('materials:note_required')}
          onChange={(event) => setReason(event.target.value)}
        />
        <Button variant="danger" block loading={saving} disabled={reason.trim() === ''} onClick={() => onSave(reason.trim())}>
          {t('orders:void_order')}
        </Button>
      </div>
    </BottomSheet>
  );
}

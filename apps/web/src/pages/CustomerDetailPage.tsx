import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet, Button, Card, Chip, DateField, SegmentedControl, TextField, Toast } from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { ApiError, apiRequest, newIdempotencyKey } from '../lib/api.js';
import { AppShell } from '../components/AppShell.js';
import { Can } from '../components/Can.js';
import { DualAmount } from '../components/DualAmount.js';
import { LedgerList } from '../components/LedgerList.js';
import type { LedgerRow } from '../components/LedgerList.js';
import { MoneyInput } from '../components/MoneyInput.js';
import type { MoneyValue } from '../components/MoneyInput.js';
import { PaymentSheet } from '../components/PaymentSheet.js';
import { ShareDocumentSheet } from '../components/ShareDocumentSheet.js';
import { QueryStates } from '../components/states.js';
import { OrderStatusChip, PaymentTypeChip } from '../components/chips.js';
import { customerName } from '../lib/customers.js';
import { useFormatter, usePermission } from '../lib/store.js';
import type { CustomerRow } from './CustomersPage.js';
import type { OrderRow } from './OrdersPage.js';

type Tab = 'overview' | 'orders' | 'ledger' | 'history';
type EntryKind = 'credit' | 'refund' | 'adjustment' | 'opening';

/**
 * The customer profile (FR-503): the balance on the header card in both currencies with "≈"
 * on the converted side, then their orders, their ledger with its running balance, and their
 * History. The walk-in customer has no ledger tab at all — its net is always zero (2.4.5).
 */
export function CustomerDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const formatter = useFormatter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mayRecordPayment = usePermission('orders.record_payment');
  const mayCredit = usePermission('orders.credit');
  const mayOpeningBalance = usePermission('customers.opening_balance');
  const maySeeBalance = usePermission('fields.see_customer_balances');

  const [tab, setTab] = useState<Tab>('overview');
  const [paying, setPaying] = useState(false);
  const [entrySheet, setEntrySheet] = useState<EntryKind | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [statement, setStatement] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const customer = useQuery({
    queryKey: ['customers', id],
    queryFn: () => apiRequest<CustomerRow>(`/customers/${id}`),
  });

  const rate = useQuery({
    queryKey: ['global-rate'],
    queryFn: () => apiRequest<{ current: { rate_iqd_per_usd: string } | null }>('/settings/global-rates'),
  });

  const orders = useQuery({
    queryKey: ['customers', id, 'orders'],
    queryFn: () => apiRequest<{ items: OrderRow[]; total: number }>(`/customers/${id}/orders`),
    enabled: tab === 'orders' || tab === 'overview',
  });

  const ledger = useQuery({
    queryKey: ['customers', id, 'ledger'],
    queryFn: () =>
      apiRequest<{
        customer: { settlement_currency: Currency };
        balance: number;
        items: LedgerRow[];
      }>(`/customers/${id}/ledger`),
    enabled: tab === 'ledger' && maySeeBalance && !customer.data?.is_system,
  });

  const history = useQuery({
    queryKey: ['customers', id, 'history'],
    queryFn: () =>
      apiRequest<{
        items: { id: string; action: string; occurred_at: string; actor_display_name: string | null; note: string | null }[];
      }>(`/customers/${id}/history`),
    enabled: tab === 'history',
  });

  const statementData = useQuery({
    queryKey: ['customers', id, 'statement'],
    queryFn: () =>
      apiRequest<{
        customer: { name: string; settlement_currency: Currency };
        opening_balance: number;
        closing_balance: number;
        items: LedgerRow[];
      }>(`/customers/${id}/statement`),
    enabled: statement,
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['customers'] });
    await queryClient.invalidateQueries({ queryKey: ['orders'] });
  };

  const payment = useMutation({
    mutationFn: (body: unknown) =>
      apiRequest(`/customers/${id}/payments`, { method: 'POST', body, idempotencyKey: newIdempotencyKey() }),
    onSuccess: async () => {
      setPaying(false);
      setToast(t('customers:payment_recorded'));
      await invalidate();
    },
  });

  const entry = useMutation({
    mutationFn: (input: { kind: EntryKind; body: unknown }) =>
      apiRequest(`/customers/${id}/${pathOf(input.kind)}`, {
        method: 'POST',
        body: input.body,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      setEntrySheet(null);
      setToast(t('customers:entry_recorded'));
      await invalidate();
    },
  });

  const assign = useMutation({
    mutationFn: (userId: string | null) =>
      apiRequest(`/customers/${id}/assignment`, {
        method: 'PUT',
        body: { user_id: userId },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      setAssigning(false);
      await invalidate();
    },
  });

  const directory = useQuery({
    queryKey: ['users', 'directory'],
    queryFn: () => apiRequest<{ id: string; display_name: string; is_active: boolean }[]>('/users/directory'),
    enabled: assigning,
  });

  const currentRate = rate.data?.current?.rate_iqd_per_usd ?? '1310.0000';
  const balance = customer.data?.balance ?? null;
  const settlement = customer.data?.settlement_currency ?? 'IQD';
  const excessNeeded =
    payment.error instanceof ApiError && payment.error.fieldError('amount')?.code === 'EXCEEDS_REMAINING';

  return (
    <AppShell title={customer.data ? customerName(customer.data, t) : t('customers:title')}>
      <div className="mz-stack">
        <QueryStates query={customer}>
          {customer.data ? (
            <>
              <Card>
                <div className="mz-row mz-row--between">
                  <div>
                    <h2 className="mz-title">{customerName(customer.data, t)}</h2>
                    {customer.data.phone ? (
                      <a href={`tel:${customer.data.phone}`} className="mz-caption" dir="ltr">
                        {customer.data.phone}
                      </a>
                    ) : null}
                    {customer.data.assigned_user_name ? (
                      <span className="mz-caption" style={{ display: 'block' }}>
                        {t('glossary:assigned_to')}: {customer.data.assigned_user_name}
                      </span>
                    ) : null}
                  </div>
                  {!customer.data.is_active ? <Chip icon="close">{t('common:deactivated')}</Chip> : null}
                </div>

                {balance ? (
                  <div style={{ marginBlockStart: 'var(--space-3)' }}>
                    <span className="mz-caption" style={{ display: 'block' }}>
                      {balance.amount_iqd >= 0 ? t('glossary:owed_to_us') : t('customers:in_credit')}
                    </span>
                    <DualAmount
                      amount_iqd={balance.amount_iqd}
                      amount_usd_cents={balance.amount_usd_cents}
                      primary={balance.currency}
                      kind="derived"
                      size="large"
                    />
                  </div>
                ) : null}
              </Card>

              <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                {mayRecordPayment && !customer.data.is_system ? (
                  <Button onClick={() => setPaying(true)}>{t('customers:record_payment')}</Button>
                ) : null}
                {mayCredit && !customer.data.is_system ? (
                  <>
                    <Button variant="secondary" onClick={() => setEntrySheet('credit')}>
                      {t('glossary:credit')}
                    </Button>
                    <Button variant="secondary" onClick={() => setEntrySheet('refund')}>
                      {t('glossary:refund')}
                    </Button>
                  </>
                ) : null}
                {mayOpeningBalance && !customer.data.is_system ? (
                  <Button variant="secondary" onClick={() => setEntrySheet('opening')}>
                    {t('glossary:opening_balance')}
                  </Button>
                ) : null}
                <Can permission="customers.assign">
                  {!customer.data.is_system ? (
                    <Button variant="secondary" onClick={() => setAssigning(true)}>
                      {t('customers:assign')}
                    </Button>
                  ) : null}
                </Can>
                {maySeeBalance && !customer.data.is_system ? (
                  <Button variant="ghost" onClick={() => setStatement(true)}>
                    {t('glossary:statement')}
                  </Button>
                ) : null}
              </div>

              <SegmentedControl
                label={t('common:more')}
                value={tab}
                onChange={setTab}
                options={[
                  { value: 'overview', label: t('materials:tab_overview') },
                  { value: 'orders', label: t('orders:title') },
                  ...(customer.data.is_system || !maySeeBalance
                    ? []
                    : [{ value: 'ledger' as Tab, label: t('customers:tab_ledger') }]),
                  { value: 'history', label: t('glossary:history') },
                ]}
              />

              {tab === 'overview' ? (
                <Card>
                  <h3 className="mz-heading">{t('customers:unpaid_first')}</h3>
                  <QueryStates
                    query={orders}
                    isEmpty={(orders.data?.items.length ?? 0) === 0}
                    emptyTitle={t('customers:no_orders')}
                    skeletonLines={3}
                  >
                    <ul className="mz-list">
                      {(orders.data?.items ?? [])
                        .filter((order) => order.status !== 'paid')
                        .slice(0, 5)
                        .map((order) => (
                          <li key={order.id}>
                            <Link to={`/orders/${order.id}`} className="mz-list__item mz-list__item--interactive">
                              <span className="mz-list__body">
                                <span className="mz-list__title">
                                  {t('orders:number', { number: formatter.number(order.number) })}
                                </span>
                                <span className="mz-caption" style={{ display: 'block' }}>
                                  {formatter.date(order.order_date)}
                                </span>
                                <DualAmount
                                  amount_iqd={order.total_iqd}
                                  amount_usd_cents={order.total_usd_cents}
                                  primary={settlement}
                                />
                              </span>
                              <span className="mz-list__end">
                                <OrderStatusChip status={order.status} />
                              </span>
                            </Link>
                          </li>
                        ))}
                    </ul>
                  </QueryStates>
                </Card>
              ) : null}

              {tab === 'orders' ? (
                <QueryStates
                  query={orders}
                  isEmpty={(orders.data?.items.length ?? 0) === 0}
                  emptyTitle={t('customers:no_orders')}
                  emptyAction={
                    <Can permission="orders.create">
                      <Link to={`/orders/new?customer=${id}`} className="mz-button mz-button--primary">
                        {t('orders:new_order')}
                      </Link>
                    </Can>
                  }
                >
                  <ul className="mz-list">
                    {(orders.data?.items ?? []).map((order) => (
                      <li key={order.id}>
                        <Link to={`/orders/${order.id}`} className="mz-list__item mz-list__item--interactive">
                          <span className="mz-list__body">
                            <span className="mz-list__title">
                              {t('orders:number', { number: formatter.number(order.number) })}
                            </span>
                            <span className="mz-caption" style={{ display: 'block' }}>
                              {formatter.date(order.order_date)}
                            </span>
                            <DualAmount
                              amount_iqd={order.total_iqd}
                              amount_usd_cents={order.total_usd_cents}
                              primary={settlement}
                            />
                          </span>
                          <span className="mz-list__end">
                            <PaymentTypeChip type={order.payment_type} />
                            <OrderStatusChip status={order.status} />
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </QueryStates>
              ) : null}

              {tab === 'ledger' ? (
                <QueryStates
                  query={ledger}
                  isEmpty={(ledger.data?.items.length ?? 0) === 0}
                  emptyTitle={t('customers:no_entries')}
                >
                  <Card>
                    <LedgerList
                      items={ledger.data?.items ?? []}
                      settlement_currency={ledger.data?.customer.settlement_currency ?? settlement}
                    />
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
                  </Card>
                </QueryStates>
              ) : null}
            </>
          ) : null}
        </QueryStates>

        {paying && customer.data ? (
          <PaymentSheet
            open
            remaining={Math.max(balance ? (settlement === 'IQD' ? balance.amount_iqd : balance.amount_usd_cents) : 0, 0)}
            settlement_currency={settlement}
            rate={currentRate}
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

        {entrySheet ? (
          <LedgerEntrySheet
            kind={entrySheet}
            rate={currentRate}
            saving={entry.isPending}
            error={entry.error instanceof ApiError ? t('errors:VALIDATION_FAILED') : undefined}
            onClose={() => setEntrySheet(null)}
            onSave={(body) => entry.mutate({ kind: entrySheet, body })}
          />
        ) : null}

        {assigning ? (
          <BottomSheet title={t('customers:assign')} open onClose={() => setAssigning(false)} closeLabel={t('common:close')}>
            <ul className="mz-list">
              <li>
                <button type="button" className="mz-list__item mz-list__item--interactive" onClick={() => assign.mutate(null)}>
                  {t('customers:unassigned')}
                </button>
              </li>
              {(directory.data ?? [])
                .filter((user) => user.is_active)
                .map((user) => (
                  <li key={user.id}>
                    <button
                      type="button"
                      className="mz-list__item mz-list__item--interactive"
                      onClick={() => assign.mutate(user.id)}
                    >
                      {user.display_name}
                    </button>
                  </li>
                ))}
            </ul>
          </BottomSheet>
        ) : null}

        {statement && statementData.data ? (
          <ShareDocumentSheet
            title={t('glossary:statement')}
            open
            onClose={() => setStatement(false)}
            text={statementText(statementData.data, formatter)}
          >
            <div className="mz-receipt">
              <strong>{statementData.data.customer.name}</strong>
              <div className="mz-receipt__line">
                <span>{t('glossary:opening_balance')}</span>
                <span data-tabular>
                  {formatter.money(statementData.data.opening_balance, statementData.data.customer.settlement_currency)}
                </span>
              </div>
              {statementData.data.items.map((row) => (
                <div key={row.entry_id} className="mz-receipt__line">
                  <span>
                    {formatter.date(row.entry_date)} · {t(`customers:entry.${row.entry_type}`)}
                  </span>
                  <span data-tabular>
                    {formatter.money(
                      statementData.data.customer.settlement_currency === 'IQD' ? row.amount_iqd : row.amount_usd_cents,
                      statementData.data.customer.settlement_currency,
                    )}
                  </span>
                </div>
              ))}
              <div className="mz-receipt__line">
                <strong>{t('glossary:balance')}</strong>
                <strong data-tabular>
                  {formatter.money(statementData.data.closing_balance, statementData.data.customer.settlement_currency)}
                </strong>
              </div>
            </div>
          </ShareDocumentSheet>
        ) : null}

        {toast ? <Toast message={toast} actionLabel={t('common:close')} onAction={() => setToast(null)} /> : null}
        <Button variant="ghost" onClick={() => navigate('/customers')}>
          {t('common:back')}
        </Button>
      </div>
    </AppShell>
  );
}

function pathOf(kind: EntryKind): string {
  return kind === 'opening' ? 'opening-balance' : `${kind}s`;
}

function statementText(
  data: { customer: { name: string; settlement_currency: Currency }; opening_balance: number; closing_balance: number },
  formatter: { money: (minor: number, currency: Currency) => string },
): string {
  return `${data.customer.name}: ${formatter.money(data.opening_balance, data.customer.settlement_currency)} → ${formatter.money(
    data.closing_balance,
    data.customer.settlement_currency,
  )}`;
}

/**
 * Credit, refund, adjustment and the opening balance (FR-504, FR-506). All four need a note,
 * because all four are somebody deciding to change a balance by hand.
 */
function LedgerEntrySheet({
  kind,
  rate,
  saving,
  error,
  onClose,
  onSave,
}: {
  kind: EntryKind;
  rate: string;
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (body: unknown) => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [amount, setAmount] = useState<MoneyValue>({ amount: null, currency: 'IQD', other_amount: null });
  const [date, setDate] = useState(formatter.today());
  const [note, setNote] = useState('');

  return (
    <BottomSheet title={t(`customers:sheet.${kind}`)} open onClose={onClose} closeLabel={t('common:close')}>
      <div className="mz-stack">
        <MoneyInput label={t('customers:amount')} value={amount} rate={rate} onChange={setAmount} error={error} />
        <DateField label={t('common:date')} value={date} max={formatter.today()} onChange={(event) => setDate(event.target.value)} />
        <TextField
          label={t('common:note')}
          value={note}
          hint={t('materials:note_required')}
          onChange={(event) => setNote(event.target.value)}
        />
        {kind === 'adjustment' ? <p className="mz-caption">{t('customers:adjustment_hint')}</p> : null}
        <Button
          block
          loading={saving}
          disabled={amount.amount === null || note.trim() === ''}
          onClick={() =>
            onSave({
              amount: amount.amount,
              currency: amount.currency,
              other_amount: amount.other_amount ?? null,
              entry_date: date,
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

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet, Button, Card, DateField, Icon, Menu, SegmentedControl, TextField, Toast } from '@mizan/ui';
import type { IconName, MenuItem } from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { ApiError, apiRequest, newIdempotencyKey } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { Can } from '../components/Can.js';
import { DualAmount } from '../components/DualAmount.js';
import { LedgerList } from '../components/LedgerList.js';
import type { LedgerRow } from '../components/LedgerList.js';
import { MoneyInput } from '../components/MoneyInput.js';
import type { MoneyValue } from '../components/MoneyInput.js';
import { PaymentSheet } from '../components/PaymentSheet.js';
import { SetRateSheet } from '../components/SetRateSheet.js';
import { ShareDocumentSheet } from '../components/ShareDocumentSheet.js';
import { QueryStates } from '../components/states.js';
import { OrderTable } from '../components/OrderTable.js';
import { Pager } from '../components/Pager.js';
import { useCursorPaging, usePaging } from '../lib/paging.js';
import { EditPartySheet, RateHistorySheet, SettlementCurrencySheet } from '../components/party/PartySheets.js';
import { customerName } from '../lib/customers.js';
import { useApp, useFormatter, usePermission } from '../lib/store.js';
import { readNote } from '../lib/record-names.js';
import { DIRECTION_LABELS, InactiveChip, directionOf } from './CustomersPage.js';
import type { BalanceValue, CustomerRow } from './CustomersPage.js';
import type { OrderRow } from './OrdersPage.js';

type Tab = 'overview' | 'orders' | 'sales' | 'history';
type EntryKind = 'credit' | 'refund' | 'adjustment' | 'opening';
type Sheet = 'payment' | 'rate' | 'rate_history' | 'currency' | 'edit' | 'statement';

interface HistoryRow {
  id: string;
  action: string;
  entity_type: string;
  occurred_at: string;
  actor_display_name: string | null;
  note: string | null;
  changes: {
    /** The amounts are absent when the caller's field flags withhold them. */
    entry?: { type: string; amount_iqd?: number; amount_usd_cents?: number };
    rate_iqd_per_usd?: { old: string | null; new: string };
  } | null;
}

type HistoryAction = 'all' | 'rate_change' | 'ledger_entry' | 'update' | 'create' | 'status_change';

/** The kinds of change the History tab can narrow to, in the order an accountant asks for them. */
const HISTORY_ACTIONS: { value: HistoryAction; label: string }[] = [
  { value: 'all', label: 'customers:history_all' },
  { value: 'rate_change', label: 'customers:history_rates' },
  { value: 'ledger_entry', label: 'customers:history_money' },
  { value: 'update', label: 'customers:history_edits' },
  { value: 'create', label: 'customers:history_created' },
  { value: 'status_change', label: 'customers:history_status' },
];

/**
 * One company (D-054, FR-503): somebody who buys from us (D-062 — buying stock is the factory's
 * own business, never a company's).
 *
 * The header card carries what anybody looks for first — what they owe us, labelled by which way
 * it points; the one rate every amount is filled at; the settlement currency. Below it the
 * actions — take a payment, the record itself — and then one tab per thing the company has: its
 * orders, its account, and its History.
 */
export function CustomerDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const formatter = useFormatter();
  const queryClient = useQueryClient();
  const isAdmin = useApp((state) => state.user?.role === 'admin');
  const mayRecordPayment = usePermission('orders.record_payment');
  const mayCredit = usePermission('orders.credit');
  const mayOpeningBalance = usePermission('customers.opening_balance');
  const maySeeSelling = usePermission('fields.see_customer_balances');
  const maySetCustomerRate = usePermission('customers.set_rate');
  const maySetCompanyRate = usePermission('companies.set_rate');
  const mayEditCustomer = usePermission('customers.edit');
  const mayEditCompany = usePermission('companies.edit');

  const [tab, setTab] = useState<Tab>('overview');
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [entrySheet, setEntrySheet] = useState<EntryKind | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /** Bumped by every write that puts a row in the sales ledger (signature moment 3, 3.6.2). */
  const [landedVersion, setLandedVersion] = useState(0);

  const party = useQuery({
    queryKey: ['customers', id],
    queryFn: () => apiRequest<CustomerRow>(`/customers/${id}`),
  });
  const data = party.data;
  const selling = Boolean(data);
  const walkIn = Boolean(data?.is_system);

  // Each list on this screen keeps its own page in the address (D-058).
  const ordersPaging = usePaging({ storageKey: 'account-orders', prefix: 'orders_' });
  const orders = useQuery({
    queryKey: ['customers', id, 'orders', ordersPaging.page, ordersPaging.pageSize],
    queryFn: () =>
      apiRequest<{ items: OrderRow[]; total: number }>(`/customers/${id}/orders?${ordersPaging.query}`),
    enabled: selling && tab === 'orders',
    placeholderData: keepPreviousData,
  });

  // The overview asks the server for what is still owed, rather than filtering a page of orders.
  const owing = useQuery({
    queryKey: ['customers', id, 'orders', 'owing'],
    queryFn: () =>
      apiRequest<{ items: OrderRow[]; total: number }>(`/customers/${id}/orders?status=owing&page_size=5`),
    enabled: selling && tab === 'overview',
  });

  const salesPaging = usePaging({ storageKey: 'account-ledger', prefix: 'sales_' });
  const salesLedger = useQuery({
    queryKey: ['customers', id, 'ledger', salesPaging.page, salesPaging.pageSize],
    queryFn: () =>
      apiRequest<{
        customer: { settlement_currency: Currency };
        balance: number;
        items: LedgerRow[];
        total: number;
      }>(`/customers/${id}/ledger?${salesPaging.query}`),
    enabled: tab === 'sales' && selling && maySeeSelling && !walkIn,
    placeholderData: keepPreviousData,
  });

  const [historyAction, setHistoryAction] = useState<HistoryAction>('all');
  const historyPaging = useCursorPaging({ storageKey: 'history', resetOn: [id, historyAction] });
  const history = useQuery({
    queryKey: ['customers', id, 'history', historyAction, historyPaging.cursor, historyPaging.pageSize],
    queryFn: () =>
      apiRequest<{ items: HistoryRow[]; next_cursor: string | null }>(
        `/customers/${id}/history?${historyPaging.query}${historyAction === 'all' ? '' : `&action=${historyAction}`}`,
      ),
    enabled: tab === 'history',
    placeholderData: keepPreviousData,
  });

  const salesStatement = useQuery({
    queryKey: ['customers', id, 'statement'],
    queryFn: () => {
      const window = statementWindow();
      return apiRequest<{
        customer: { name: string; settlement_currency: Currency };
        opening_balance: number;
        closing_balance: number;
        items: LedgerRow[];
        item_count: number;
        has_more: boolean;
      }>(`/customers/${id}/statement?from=${window.from}&to=${window.to}`);
    },
    enabled: sheet === 'statement',
  });

  const settlement: Currency = data?.settlement_currency ?? 'IQD';
  const rate = data?.rate?.rate_iqd_per_usd ?? '1310.0000';
  const inSettlement = (value: BalanceValue | null | undefined) =>
    value ? (settlement === 'IQD' ? value.amount_iqd : value.amount_usd_cents) : 0;
  const owedToUs = inSettlement(data?.balance);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['customers'] });
    await queryClient.invalidateQueries({ queryKey: ['companies'] });
    await queryClient.invalidateQueries({ queryKey: ['orders'] });
  };
  const done = async (message?: string) => {
    setSheet(null);
    setEntrySheet(null);
    if (message) setToast(message);
    await refresh();
  };
  const post = (path: string, method: 'POST' | 'PUT' | 'PATCH' = 'POST') => (body: unknown) =>
    apiRequest(`/customers/${id}${path}`, { method, body, idempotencyKey: newIdempotencyKey() });

  const payment = useMutation({
    mutationFn: post('/payments'),
    onSuccess: async () => {
      await done(t('customers:payment_recorded'));
      setLandedVersion((version) => version + 1);
    },
  });
  const entry = useMutation({
    mutationFn: (input: { kind: EntryKind; body: unknown }) => post(`/${pathOf(input.kind)}`)(input.body),
    onSuccess: async () => {
      await done(t('customers:entry_recorded'));
      setLandedVersion((version) => version + 1);
    },
  });
  const setRate = useMutation({
    mutationFn: post('/rates'),
    onSuccess: () => done(t('customers:rate_saved')),
  });
  const setCurrency = useMutation({
    mutationFn: post('/settlement-currency', 'PUT'),
    onSuccess: () => done(),
  });
  const update = useMutation({
    mutationFn: post('', 'PATCH'),
    onSuccess: () => done(),
  });

  const errorOf = (error: unknown) =>
    error instanceof ApiError ? t(error.messageKey, { defaultValue: t('errors:VALIDATION_FAILED') }) : undefined;
  const excessNeeded =
    payment.error instanceof ApiError && payment.error.fieldError('amount')?.code === 'EXCEEDS_REMAINING';

  const mayRate = maySetCustomerRate || maySetCompanyRate;
  const mayEdit = !walkIn && (mayEditCustomer || mayEditCompany);
  const sellingActions = selling && !walkIn && (mayRecordPayment || mayCredit || mayOpeningBalance);

  const moreItems: MenuItem[] = [
    ...(sellingActions && mayCredit
      ? [
          { label: t('glossary:credit'), onSelect: () => setEntrySheet('credit') },
          { label: t('glossary:refund'), onSelect: () => setEntrySheet('refund') },
        ]
      : []),
    ...(sellingActions && mayOpeningBalance
      ? [{ label: t('customers:opening_theirs'), onSelect: () => setEntrySheet('opening') }]
      : []),
    ...(mayRate && !walkIn ? [{ label: t('customers:set_rate'), onSelect: () => setSheet('rate') }] : []),
    { label: t('companies:rate_history'), onSelect: () => setSheet('rate_history') },
    ...(isAdmin && !walkIn
      ? [{ label: t('companies:settlement_currency_change'), onSelect: () => setSheet('currency') }]
      : []),
    ...(selling && maySeeSelling && !walkIn
      ? [{ label: t('customers:statement_sales'), onSelect: () => setSheet('statement') }]
      : []),
  ];

  usePageTitle(data ? customerName(data, t) : t('customers:title'));

  return (
    <>
      <div className="mz-stack">
        <QueryStates query={party}>
          {data ? (
            <>
              <Card>
                <div className="mz-row mz-row--between" style={{ alignItems: 'flex-start', gap: 'var(--space-3)' }}>
                  <div className="mz-stack" style={{ gap: '2px' }}>
                    <h2 className="mz-title">
                      <bdi>{customerName(data, t)}</bdi>
                    </h2>
                    {data.contact_name ? (
                      <span className="mz-caption">
                        <bdi>{data.contact_name}</bdi>
                      </span>
                    ) : null}
                    {data.phone ? (
                      <a href={`tel:${data.phone}`} className="mz-caption" dir="ltr">
                        {data.phone}
                      </a>
                    ) : null}
                  </div>
                  <InactiveChip row={data} />
                </div>

                <hr className="mz-divider" />

                <div className="mz-detail-summary">
                  <PartyFigure party={data} />
                  <div className="mz-stack" style={{ gap: 'var(--space-2)' }}>
                    {/* The rate every amount for this business is filled at, on both sides (2.3.3). */}
                    <div className="mz-row mz-row--between" style={{ gap: 'var(--space-3)' }}>
                      <span className="mz-caption">
                        {data.rate?.is_customer_rate ? t('customers:rate_own') : t('customers:rate_is_global')}
                      </span>
                      <span data-tabular>{formatter.rate(rate)}</span>
                    </div>
                    <div className="mz-row mz-row--between" style={{ gap: 'var(--space-3)' }}>
                      <span className="mz-caption">{t('glossary:settlement_currency')}</span>
                      <span>{t(`glossary:${settlement.toLowerCase()}`)}</span>
                    </div>
                  </div>
                </div>
              </Card>

              {/* The everyday actions stay on the page — money in, money out, the record itself —
                  and everything else is one "More" away, so a phone shows the tabs, not a wall of
                  buttons. */}
              <div className="mz-actions">
                <div className="mz-actions__group mz-actions__group--primary">
                  {selling && !walkIn && mayRecordPayment ? (
                    <Button icon="check" onClick={() => setSheet('payment')}>
                      {t('customers:receive_payment')}
                    </Button>
                  ) : null}
                </div>
                <div className="mz-actions__group">
                  {mayEdit ? (
                    <Button variant="secondary" icon="edit" onClick={() => setSheet('edit')}>
                      {t('common:edit')}
                    </Button>
                  ) : null}
                  <Menu variant="button" icon="more" label={t('common:more')} items={moreItems} />
                </div>
              </div>

              <SegmentedControl
                label={t('common:more')}
                value={tab}
                onChange={setTab}
                options={[
                  { value: 'overview', label: t('materials:tab_overview') },
                  ...(selling ? [{ value: 'orders' as Tab, label: t('orders:title') }] : []),
                  ...(selling && maySeeSelling && !walkIn
                    ? [{ value: 'sales' as Tab, label: t('customers:tab_account') }]
                    : []),
                  { value: 'history', label: t('glossary:history') },
                ]}
              />

              {tab === 'overview' && selling ? (
                <Card>
                  <h3 className="mz-heading">{t('customers:unpaid_first')}</h3>
                  <QueryStates
                    query={owing}
                    isEmpty={(owing.data?.items.length ?? 0) === 0}
                    emptyTitle={t('customers:no_orders')}
                    skeletonLines={3}
                  >
                    <OrderTable rows={owing.data?.items ?? []} showCustomer={false} />
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
                  <OrderTable rows={orders.data?.items ?? []} showCustomer={false} />
                  <Pager
                    page={ordersPaging.page}
                    pageSize={ordersPaging.pageSize}
                    total={orders.data?.total ?? 0}
                    onPage={ordersPaging.setPage}
                    onPageSize={ordersPaging.setPageSize}
                  />
                </QueryStates>
              ) : null}

              {tab === 'sales' ? (
                <QueryStates
                  query={salesLedger}
                  isEmpty={(salesLedger.data?.items.length ?? 0) === 0}
                  emptyTitle={t('customers:no_entries')}
                >
                  <Card>
                    <LedgerList
                      items={salesLedger.data?.items ?? []}
                      settlement_currency={salesLedger.data?.customer.settlement_currency ?? settlement}
                      landedVersion={landedVersion}
                    />
                    <Pager
                      page={salesPaging.page}
                      pageSize={salesPaging.pageSize}
                      total={salesLedger.data?.total ?? 0}
                      onPage={salesPaging.setPage}
                      onPageSize={salesPaging.setPageSize}
                    />
                  </Card>
                </QueryStates>
              ) : null}

              {tab === 'history' ? (
                <>
                  {/* One kind of change at a time — the rate changes, the money, the edits — each
                      row saying who made it and when (rule 3). */}
                  <div className="mz-toolbar">
                    <div className="mz-toolbar__filters">
                      <select
                        className="mz-select"
                        aria-label={t('customers:history_filter')}
                        value={historyAction}
                        onChange={(event) => setHistoryAction(event.target.value as HistoryAction)}
                      >
                        {HISTORY_ACTIONS.map((action) => (
                          <option key={action.value} value={action.value}>
                            {t(action.label)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <QueryStates
                    query={history}
                    isEmpty={(history.data?.items.length ?? 0) === 0}
                    emptyTitle={t('history:empty')}
                  >
                    <ul className="mz-list">
                      {(history.data?.items ?? []).map((row) => (
                        <HistoryItem key={row.id} row={row} settlement={settlement} />
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
                </>
              ) : null}
            </>
          ) : null}
        </QueryStates>

        {sheet === 'payment' && data ? (
          <PaymentSheet
            open
            remaining={Math.max(owedToUs, 0)}
            settlement_currency={settlement}
            rate={rate}
            saving={payment.isPending}
            needsExcessConfirmation={excessNeeded}
            error={excessNeeded ? undefined : errorOf(payment.error)}
            onClose={() => setSheet(null)}
            onSave={(body) => payment.mutate(body)}
          />
        ) : null}

        {entrySheet ? (
          <LedgerEntrySheet
            kind={entrySheet}
            rate={rate}
            saving={entry.isPending}
            error={errorOf(entry.error)}
            onClose={() => setEntrySheet(null)}
            onSave={(body) => entry.mutate({ kind: entrySheet, body })}
          />
        ) : null}

        {sheet === 'edit' && data ? (
          <EditPartySheet
            party={data}
            saving={update.isPending}
            error={errorOf(update.error)}
            onClose={() => setSheet(null)}
            onSave={(body) => update.mutate(body)}
          />
        ) : null}

        {sheet === 'rate' ? (
          <SetRateSheet
            title={t('customers:set_rate')}
            label={t('customers:rate_label')}
            hint={t('customers:rate_hint')}
            current={data?.rate?.is_customer_rate ? data.rate.rate_iqd_per_usd : null}
            saving={setRate.isPending}
            onClose={() => setSheet(null)}
            onSave={(body) => setRate.mutate(body)}
          />
        ) : null}

        {sheet === 'rate_history' ? <RateHistorySheet id={id} onClose={() => setSheet(null)} /> : null}

        {sheet === 'currency' && data ? (
          <SettlementCurrencySheet
            current={settlement}
            hasMoney={owedToUs !== 0}
            balance={owedToUs}
            rate={rate}
            saving={setCurrency.isPending}
            error={errorOf(setCurrency.error)}
            onClose={() => setSheet(null)}
            onSave={(body) => setCurrency.mutate(body)}
          />
        ) : null}

        {sheet === 'statement' && salesStatement.data ? (
          <ShareDocumentSheet
            title={t('customers:statement_sales')}
            open
            onClose={() => setSheet(null)}
            text={statementText(salesStatement.data, formatter, t)}
          >
            <div className="mz-receipt">
              <strong>
                <bdi>{salesStatement.data.customer.name}</bdi>
              </strong>
              <p className="mz-caption">{t('common:statement_window')}</p>
              {salesStatement.data.has_more ? (
                <p className="mz-caption">
                  {t('common:statement_capped', {
                    shown: salesStatement.data.items.length,
                    total: salesStatement.data.item_count,
                  })}
                </p>
              ) : null}
              <div className="mz-receipt__line">
                <span>{t('glossary:opening_balance')}</span>
                <span data-tabular>
                  {formatter.money(salesStatement.data.opening_balance, salesStatement.data.customer.settlement_currency)}
                </span>
              </div>
              {salesStatement.data.items.map((row) => (
                <div key={row.entry_id} className="mz-receipt__line">
                  <span>
                    {formatter.date(row.entry_date)} · {t(`customers:entry.${row.entry_type}`)}
                  </span>
                  <span data-tabular>
                    {formatter.money(
                      salesStatement.data.customer.settlement_currency === 'IQD' ? row.amount_iqd : row.amount_usd_cents,
                      salesStatement.data.customer.settlement_currency,
                    )}
                  </span>
                </div>
              ))}
              <div className="mz-receipt__line">
                <strong>{t('glossary:balance')}</strong>
                <strong data-tabular>
                  {formatter.money(salesStatement.data.closing_balance, salesStatement.data.customer.settlement_currency)}
                </strong>
              </div>
            </div>
          </ShareDocumentSheet>
        ) : null}

        {toast ? <Toast message={toast} actionLabel={t('common:close')} onAction={() => setToast(null)} /> : null}
      </div>
    </>
  );
}

/** What the company owes us, large, labelled by which way it points. */
function PartyFigure({ party }: { party: CustomerRow }) {
  const { t } = useTranslation();
  const balance: BalanceValue | null | undefined = party.balance;
  if (!balance) return <span />;
  const direction = directionOf(balance);

  return (
    <div className="mz-stack" style={{ gap: 'var(--space-2)' }}>
      <span className={direction === 'owes' ? 'mz-figure__label mz-owed' : 'mz-figure__label'}>
        {t(DIRECTION_LABELS[direction])}
      </span>
      <DualAmount
        amount_iqd={Math.abs(balance.amount_iqd)}
        amount_usd_cents={Math.abs(balance.amount_usd_cents)}
        primary={balance.currency}
        kind="derived"
        size="large"
      />
    </div>
  );
}

/**
 * One row of the company's History. A money entry names what it was and how much; everything
 * else names the action. Rows from before D-062 may still come from the old buying side, and
 * are labelled from that side's names.
 */
function HistoryItem({ row, settlement }: { row: HistoryRow; settlement: Currency }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const money = row.changes?.entry;
  const rate = row.action === 'rate_change' ? row.changes?.rate_iqd_per_usd : undefined;
  const namespace = row.entity_type === 'company' ? 'companies' : 'customers';
  const icon: IconName = money
    ? 'check'
    : rate
      ? 'refresh'
      : row.action === 'create'
        ? 'plus'
        : row.action === 'update'
          ? 'edit'
          : 'clock';
  const title = money
    ? t(`${namespace}:entry.${money.type}`)
    : rate
      ? rate.old
        ? t('customers:rate_changed', { old: formatter.rate(rate.old), new: formatter.rate(rate.new) })
        : t('customers:rate_set', { new: formatter.rate(rate.new) })
      : t(`history:action.${row.action}`);
  return (
    <li className="mz-list__item mz-list__item--detail">
      <span className="mz-row-lead">
        <Icon name={icon} size={18} />
      </span>
      <span className="mz-list__body">
        <span className="mz-list__title" data-tabular={rate ? true : undefined}>
          {title}
        </span>
        <span className="mz-caption">
          {formatter.timestamp(new Date(row.occurred_at))}
          {row.actor_display_name ? ` · ${row.actor_display_name}` : ''}
        </span>
        {row.note ? (
          <span className="mz-caption" style={{ display: 'block' }}>
            <bdi>{readNote(row.note, t, formatter.identifier)}</bdi>
          </span>
        ) : null}
      </span>
      {money?.amount_iqd !== undefined && money.amount_usd_cents !== undefined ? (
        <span className="mz-list__end">
          <DualAmount
            amount_iqd={Math.abs(money.amount_iqd)}
            amount_usd_cents={Math.abs(money.amount_usd_cents)}
            primary={settlement}
          />
        </span>
      ) : null}
    </li>
  );
}

/** The last twelve months: the window a statement covers (FR-507). */
function statementWindow(): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today);
  from.setFullYear(from.getFullYear() - 1);
  return { from: from.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) };
}

function pathOf(kind: EntryKind): string {
  return kind === 'opening' ? 'opening-balance' : `${kind}s`;
}

/**
 * The statement as plain text, for the message a customer actually receives.
 *
 * Labelled rather than written as "opening → closing": an arrow in a text message does not
 * mirror, so in Kurdish and Arabic it pointed the wrong way, and a bare pair of numbers is not
 * a statement. The labels are the same two the printed sheet above uses.
 */
function statementText(
  data: { customer: { name: string; settlement_currency: Currency }; opening_balance: number; closing_balance: number },
  formatter: { money: (minor: number, currency: Currency) => string },
  t: (key: string) => string,
): string {
  const currency = data.customer.settlement_currency;
  return [
    data.customer.name,
    `${t('glossary:opening_balance')}: ${formatter.money(data.opening_balance, currency)}`,
    `${t('glossary:balance')}: ${formatter.money(data.closing_balance, currency)}`,
  ].join('\n');
}

/**
 * Credit, refund, adjustment and the opening balance on the selling side (FR-504, FR-506). All
 * four need a note, because all four are somebody deciding to change a balance by hand.
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
        <DateField
          label={t('common:date')}
          value={date}
          max={formatter.today()}
          onChange={(event) => setDate(event.target.value)}
        />
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

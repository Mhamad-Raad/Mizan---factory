import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BottomSheet,
  Button,
  Card,
  Checkbox,
  DateField,
  Icon,
  Menu,
  SegmentedControl,
  TextAreaField,
} from '@mizan/ui';
import type { IconName, MenuItem } from '@mizan/ui';
import { useIsWide } from '../lib/wide.js';
import type { Currency, Rate } from '@mizan/money';
import { ApiError, apiRequest } from '../lib/api.js';
import { useIdempotencyKey } from '../lib/idempotency.js';
import type { IdempotencyKey } from '../lib/idempotency.js';
import { usePageTitle } from '../lib/page-title.js';
import { Can } from '../components/Can.js';
import { DualAmount } from '../components/DualAmount.js';
import { LedgerList } from '../components/LedgerList.js';
import type { LedgerRow } from '../components/LedgerList.js';
import { MoneyInput } from '../components/MoneyInput.js';
import type { MoneyValue } from '../components/MoneyInput.js';
import { PaymentSheet } from '../components/PaymentSheet.js';
import { SetRateSheet } from '../components/SetRateSheet.js';
import { QueryStates } from '../components/states.js';
import { OrderTable } from '../components/OrderTable.js';
import { Pager } from '../components/Pager.js';
import { useCursorPaging, useKeepPageInRange, usePaging } from '../lib/paging.js';
import { EditPartySheet, SettlementCurrencySheet } from '../components/party/PartySheets.js';
import { DIRECTION_LABELS, customerName, directionOf } from '../lib/customers.js';
import { InactiveChip } from '../components/chips.js';
import { useApp, useFormatter, usePermission } from '../lib/store.js';
import { readNote } from '../lib/record-names.js';
import { errorMessage } from '../lib/errors.js';
import { invalidateMoneyViews } from '../lib/invalidate.js';
import { thisYear } from '../lib/periods.js';
import { documentOfLedgerRow, usePrint } from '../lib/print.js';
import type { AccountSide } from '../lib/print.js';
import { PrintButton, usePrintSelection } from '../components/PrintSelection.js';
import { SavedToast, paymentReceipt } from '../components/SavedToast.js';
import type { SavedNotice } from '../components/SavedToast.js';
import { useBuyingSide } from '../components/party/BuyingSide.js';
import { payableAmount, payableLabel } from '../lib/accounts.js';
import type { BalanceValue, CustomerRow } from './CustomersPage.js';
import type { OrderRow } from '../lib/orders.js';

type Tab = 'overview' | 'orders' | 'purchases' | 'sales' | 'buying' | 'history';
type EntryKind = 'credit' | 'refund' | 'adjustment';
type Sheet = 'payment' | 'rate' | 'currency' | 'edit' | 'print';

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
 * One company (D-054, FR-503): somebody we buy from, sell to, or both (D-085).
 *
 * The header card carries what anybody looks for first — what they owe us and what we owe them,
 * each labelled by which way it points; the one rate every amount is filled at; the account's
 * currency. Below it the actions — money in, money out, a new purchase, the record itself — and
 * then one tab per thing the company has: its orders, its purchases, the two sides of its account,
 * and its History. Any row of either account prints as a receipt, and the whole account prints as
 * a statement for the dates chosen (D-086).
 */
export function CustomerDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const formatter = useFormatter();
  const queryClient = useQueryClient();
  const isAdmin = useApp((state) => state.user?.role === 'admin');
  const mayRecordPayment = usePermission('orders.record_payment');
  const mayCredit = usePermission('orders.credit');
  const maySeeSelling = usePermission('fields.see_customer_balances');
  const maySetCustomerRate = usePermission('customers.set_rate');
  const maySetCompanyRate = usePermission('companies.set_rate');
  const mayEditCustomer = usePermission('customers.edit');
  const mayEditCompany = usePermission('companies.edit');
  // The orders are asked for only by someone who may read them; the API refuses the rest.
  const mayViewOrders = usePermission('orders.view');

  const [tab, setTab] = useState<Tab>('overview');
  const isWide = useIsWide();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [entrySheet, setEntrySheet] = useState<EntryKind | null>(null);
  const [notice, setNotice] = useState<SavedNotice | null>(null);
  const dismissNotice = useCallback(() => setNotice(null), []);
  const print = usePrint();
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
      apiRequest<{ items: OrderRow[]; total: number }>(
        `/customers/${id}/orders?${ordersPaging.query}`,
      ),
    enabled: selling && mayViewOrders && tab === 'orders',
    placeholderData: keepPreviousData,
  });
  useKeepPageInRange(ordersPaging, orders);

  // The overview's "Unpaid orders": the server's own filter, a page at a time with its own place in
  // the address (D-093) — a customer of many years has more than any one screen holds.
  const owingPaging = usePaging({ storageKey: 'account-owing-orders', prefix: 'owing_' });
  const owing = useQuery({
    queryKey: ['customers', id, 'orders', 'owing', owingPaging.page, owingPaging.pageSize],
    queryFn: () =>
      apiRequest<{
        items: OrderRow[];
        total: number;
        /** What every unpaid order still owes, not this page's — behind the balances flag. */
        totals?: { balance?: { owed_iqd: number; owed_usd_cents: number } };
      }>(`/customers/${id}/orders?status=owing&${owingPaging.query}`),
    enabled: selling && mayViewOrders && tab === 'overview',
    placeholderData: keepPreviousData,
  });
  useKeepPageInRange(owingPaging, owing);

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
  useKeepPageInRange(salesPaging, salesLedger);

  const [historyAction, setHistoryAction] = useState<HistoryAction>('all');
  const historyPaging = useCursorPaging({ storageKey: 'history', resetOn: [id, historyAction] });
  const history = useQuery({
    queryKey: [
      'customers',
      id,
      'history',
      historyAction,
      historyPaging.cursor,
      historyPaging.pageSize,
    ],
    queryFn: () =>
      apiRequest<{ items: HistoryRow[]; next_cursor: string | null }>(
        `/customers/${id}/history?${historyPaging.query}${historyAction === 'all' ? '' : `&action=${historyAction}`}`,
      ),
    enabled: tab === 'history',
    placeholderData: keepPreviousData,
  });

  const settlement: Currency = data?.settlement_currency ?? 'IQD';
  // Their own rate, or the global one the API reports in its place; none at all before a rate
  // has ever been set, and then nothing is converted.
  const rate: Rate | null = data?.rate?.rate_iqd_per_usd ?? null;
  const inSettlement = (value: BalanceValue | null | undefined) =>
    value ? (settlement === 'IQD' ? value.amount_iqd : value.amount_usd_cents) : 0;
  const owedToUs = inSettlement(data?.balance);
  const weOwe = inSettlement(data?.payable);

  const buying = useBuyingSide({
    id,
    name: data ? customerName(data, t) : '',
    onPrintAccount: () => setSheet('print'),
    enabled: Boolean(data) && !walkIn,
    tab,
    settlement,
    owed: weOwe,
    rate,
    onRecorded: setNotice,
  });

  // The sales account's rows, ticked to print again (D-086).
  const selectSales = usePrintSelection<LedgerRow>(
    (row) => documentOfLedgerRow('sales', id, row, mayViewOrders),
    (row) => row.entry_id,
  );

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['customers'] });
    await queryClient.invalidateQueries({ queryKey: ['companies'] });
    await queryClient.invalidateQueries({ queryKey: ['orders'] });
    await invalidateMoneyViews(queryClient);
  };
  // One key per opening of a sheet, held across its retries (FR-1305): the record, the sheet and
  // the kind of entry are its scope, so a refund never carries the key a credit already used.
  const opening = `${id}:${sheet ?? ''}:${entrySheet ?? ''}`;
  const paymentKey = useIdempotencyKey(`payment:${opening}`);
  const entryKey = useIdempotencyKey(`entry:${opening}`);
  const rateKey = useIdempotencyKey(`rate:${opening}`);
  const currencyKey = useIdempotencyKey(`currency:${opening}`);
  const updateKey = useIdempotencyKey(`update:${opening}`);
  const post =
    (path: string, key: IdempotencyKey, method: 'POST' | 'PUT' | 'PATCH' = 'POST') =>
    (body: unknown) =>
      apiRequest(`/customers/${id}${path}`, { method, body, idempotencyKey: key.key });
  const done = async (key: IdempotencyKey, message?: string, receipt?: SavedNotice['receipt']) => {
    key.renew();
    closeSheets();
    if (message) setNotice({ message, receipt });
    await refresh();
  };

  const payment = useMutation({
    mutationFn: post('/payments', paymentKey),
    onSuccess: async (answer) => {
      await done(paymentKey, t('customers:payment_recorded'), paymentReceipt('sales', id, answer));
      setLandedVersion((version) => version + 1);
    },
  });
  const entry = useMutation({
    mutationFn: (input: { kind: EntryKind; body: unknown }) =>
      post(`/${pathOf(input.kind)}`, entryKey)(input.body),
    onSuccess: async (answer) => {
      await done(entryKey, t('customers:entry_recorded'), paymentReceipt('sales', id, answer));
      setLandedVersion((version) => version + 1);
    },
  });
  const setRate = useMutation({
    mutationFn: post('/rates', rateKey),
    onSuccess: () => done(rateKey, t('customers:rate_saved')),
  });
  const setCurrency = useMutation({
    mutationFn: post('/settlement-currency', currencyKey, 'PUT'),
    onSuccess: () => done(currencyKey),
  });
  const update = useMutation({
    mutationFn: post('', updateKey, 'PATCH'),
    onSuccess: () => done(updateKey),
  });

  /**
   * A sheet that closes forgets its last answer: reopened, it must not show yesterday's refusal —
   * nor carry "record the excess as credit" over to a payment of a different amount.
   */
  function closeSheets() {
    setSheet(null);
    setEntrySheet(null);
    payment.reset();
    entry.reset();
    setRate.reset();
    setCurrency.reset();
    update.reset();
  }

  const errorOf = (error: unknown) => errorMessage(t, error) ?? undefined;
  const excessNeeded =
    payment.error instanceof ApiError &&
    payment.error.fieldError('amount')?.code === 'EXCEEDS_REMAINING';
  const rebaseRateRequired =
    setCurrency.error instanceof ApiError && setCurrency.error.code === 'REBASE_RATE_REQUIRED';

  const mayRate = maySetCustomerRate || maySetCompanyRate;
  const mayEdit = !walkIn && (mayEditCustomer || mayEditCompany);
  const sellingActions = selling && !walkIn && (mayRecordPayment || mayCredit);

  const moreItems: MenuItem[] = [
    ...(sellingActions && mayCredit
      ? [
          { label: t('glossary:credit'), onSelect: () => setEntrySheet('credit') },
          { label: t('glossary:refund'), onSelect: () => setEntrySheet('refund') },
        ]
      : []),
    ...(mayRate && !walkIn
      ? [{ label: t('customers:set_rate'), onSelect: () => setSheet('rate') }]
      : []),
    ...(isAdmin && !walkIn
      ? [{ label: t('companies:settlement_currency_change'), onSelect: () => setSheet('currency') }]
      : []),
    ...buying.menuItems,
    ...((maySeeSelling || buying.maySeeOwed) && !walkIn
      ? [{ label: t('print:print_statement'), onSelect: () => setSheet('print') }]
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
                <div
                  className="mz-row mz-row--between"
                  style={{ alignItems: 'flex-start', gap: 'var(--space-3)' }}
                >
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
                      // The digits read left to right; the line itself sits on the page's reading
                      // side, under the name — `dir` on the link sent it to the far edge in RTL.
                      <a href={`tel:${data.phone}`} className="mz-caption mz-tap-link">
                        <bdi dir="ltr">{data.phone}</bdi>
                      </a>
                    ) : null}
                  </div>
                  <InactiveChip row={data} />
                </div>

                <hr className="mz-divider" />

                <div className="mz-detail-summary">
                  <div
                    className="mz-row"
                    style={{ gap: 'var(--space-6)', flexWrap: 'wrap', alignItems: 'flex-start' }}
                  >
                    <PartyFigure party={data} />
                    <PayableFigure party={data} />
                    <NetFigure party={data} />
                  </div>
                  <div className="mz-stack" style={{ gap: 'var(--space-2)' }}>
                    {/* The rate every amount for this business is filled at, on both sides (2.3.3). */}
                    <div className="mz-row mz-row--between" style={{ gap: 'var(--space-3)' }}>
                      <span className="mz-caption">
                        {data.rate?.is_customer_rate
                          ? t('customers:rate_own')
                          : t('customers:rate_is_global')}
                      </span>
                      <span data-tabular>
                        {rate === null ? t('settings:no_rate_yet') : formatter.rate(rate)}
                      </span>
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
                    // Money in and money out look different and read as a pair (D-088).
                    <Button variant="money-in" icon="money-in" onClick={() => setSheet('payment')}>
                      {t('common:they_paid_us')}
                    </Button>
                  ) : null}
                  {buying.primaryActions}
                </div>
                <div className="mz-actions__group">
                  {mayEdit ? (
                    <Button variant="secondary" icon="edit" onClick={() => setSheet('edit')}>
                      {t('common:edit')}
                    </Button>
                  ) : null}
                  {/* On a desktop the list hangs from the button's own leading edge; on a phone the
                      button is at the row's end, and the list opens inward so it stays on screen. */}
                  {moreItems.length > 0 ? (
                    <Menu
                      variant="button"
                      icon="more"
                      label={t('common:more')}
                      items={moreItems}
                      align={isWide ? 'start' : 'end'}
                    />
                  ) : null}
                </div>
              </div>

              <SegmentedControl
                label={t('common:more')}
                hideLabel
                value={tab}
                onChange={setTab}
                options={[
                  { value: 'overview', label: t('materials:tab_overview') },
                  ...(selling && mayViewOrders
                    ? [{ value: 'orders' as Tab, label: t('orders:title') }]
                    : []),
                  ...(buying.maySeePurchases
                    ? [{ value: 'purchases' as Tab, label: t('purchases:title') }]
                    : []),
                  ...(selling && maySeeSelling && !walkIn
                    ? [{ value: 'sales' as Tab, label: t('print:side_sales') }]
                    : []),
                  ...(buying.maySeeOwed
                    ? [{ value: 'buying' as Tab, label: t('print:side_buying') }]
                    : []),
                  { value: 'history', label: t('glossary:history') },
                ]}
              />

              {tab === 'overview' ? buying.overviewCard : null}

              {tab === 'overview' && selling && mayViewOrders ? (
                <Card>
                  <div className="mz-stack">
                    <div
                      className="mz-row mz-row--between"
                      style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}
                    >
                      <h3 className="mz-heading">{t('customers:unpaid_first')}</h3>
                      {owing.data?.totals?.balance && owing.data.total > 0 ? (
                        <span className="mz-owed">
                          <DualAmount
                            amount_iqd={owing.data.totals.balance.owed_iqd}
                            amount_usd_cents={owing.data.totals.balance.owed_usd_cents}
                            primary={settlement}
                            kind="derived"
                          />
                        </span>
                      ) : null}
                    </div>
                    <QueryStates
                      query={owing}
                      isEmpty={(owing.data?.items.length ?? 0) === 0}
                      emptyTitle={t('customers:no_unpaid_orders')}
                      skeletonLines={3}
                    >
                      <div className="mz-stack">
                        <OrderTable rows={owing.data?.items ?? []} showCustomer={false} />
                        <Pager
                          page={owingPaging.page}
                          pageSize={owingPaging.pageSize}
                          total={owing.data?.total ?? 0}
                          onPage={owingPaging.setPage}
                          onPageSize={owingPaging.setPageSize}
                        />
                      </div>
                    </QueryStates>
                  </div>
                </Card>
              ) : null}

              {tab === 'orders' ? (
                <QueryStates
                  query={orders}
                  isEmpty={(orders.data?.items.length ?? 0) === 0}
                  emptyTitle={t('customers:no_orders')}
                  emptyAction={
                    <Can permission="orders.create">
                      <Link
                        to={`/orders/new?customer=${id}`}
                        className="mz-button mz-button--primary"
                      >
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

              {tab === 'purchases' ? buying.purchasesTab : null}
              {tab === 'buying' ? buying.accountTab : null}

              {tab === 'sales' ? (
                // What is ticked, or — with nothing ticked — the account for the dates chosen.
                <PrintButton
                  state={selectSales}
                  wholeLabel={t('print:print_statement')}
                  onPrintWhole={() => setSheet('print')}
                />
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
                      settlement_currency={
                        salesLedger.data?.customer.settlement_currency ?? settlement
                      }
                      landedVersion={landedVersion}
                      selection={selectSales.selection}
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
            direction="in"
            counterparty={customerName(data, t)}
            remainingLabel={t('companies:they_owe_us')}
            settleHint={t('companies:settle_in_full_hint')}
            remaining={Math.max(owedToUs, 0)}
            settlement_currency={settlement}
            rate={rate}
            saving={payment.isPending}
            needsExcessConfirmation={excessNeeded}
            error={excessNeeded ? undefined : errorOf(payment.error)}
            onClose={closeSheets}
            onEdit={payment.reset}
            onSave={(body) => payment.mutate(body)}
          />
        ) : null}

        {entrySheet ? (
          <LedgerEntrySheet
            kind={entrySheet}
            rate={rate}
            saving={entry.isPending}
            error={errorOf(entry.error)}
            onClose={closeSheets}
            onEdit={entry.reset}
            onSave={(body) => entry.mutate({ kind: entrySheet, body })}
          />
        ) : null}

        {sheet === 'edit' && data ? (
          <EditPartySheet
            party={data}
            saving={update.isPending}
            error={errorOf(update.error)}
            onClose={closeSheets}
            onEdit={update.reset}
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
            error={errorOf(setRate.error)}
            onClose={closeSheets}
            onEdit={setRate.reset}
            onSave={(body) => setRate.mutate(body)}
          />
        ) : null}

        {sheet === 'currency' && data ? (
          <SettlementCurrencySheet
            current={settlement}
            hasMoney={owedToUs !== 0}
            balance={owedToUs}
            rate={rate ?? ''}
            saving={setCurrency.isPending}
            error={errorOf(setCurrency.error)}
            rateRequired={rebaseRateRequired}
            onClose={closeSheets}
            onEdit={setCurrency.reset}
            onSave={(body) => setCurrency.mutate(body)}
          />
        ) : null}

        {sheet === 'print' ? (
          <PrintAccountSheet
            sides={[
              ...(selling && maySeeSelling && !walkIn ? (['sales'] as AccountSide[]) : []),
              ...(buying.maySeeOwed ? (['buying'] as AccountSide[]) : []),
            ]}
            onClose={closeSheets}
            onPrint={(range, sides) => {
              closeSheets();
              print([{ kind: 'statement', accountId: id, from: range.from, to: range.to, sides }]);
            }}
          />
        ) : null}

        {buying.sheets}

        {notice ? <SavedToast notice={notice} onDone={dismissNotice} /> : null}
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
        {/* Beside "We owe them", a bare "Settled" would not say which side (D-085). */}
        {direction === 'settled' ? t('companies:they_owe_nothing') : t(DIRECTION_LABELS[direction])}
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

/** What we owe them for what we bought (D-085), beside what they owe us; nothing for the walk-in. */
function PayableFigure({ party }: { party: CustomerRow }) {
  const { t } = useTranslation();
  const payable = party.payable;
  if (!payable || party.is_system) return null;
  const amount = payableAmount(payable);
  const label = payableLabel(amount);
  return (
    <div className="mz-stack" style={{ gap: 'var(--space-2)' }}>
      <span className={amount > 0 ? 'mz-figure__label mz-owed' : 'mz-figure__label'}>
        {t(label)}
      </span>
      <DualAmount
        amount_iqd={Math.abs(payable.amount_iqd)}
        amount_usd_cents={Math.abs(payable.amount_usd_cents)}
        primary={payable.currency}
        kind="derived"
        size="large"
      />
    </div>
  );
}

/**
 * What is left between us once both sides are set against each other — what they owe us less what
 * we owe them — in the account's currency (D-093). Both figures are kept in that currency, each
 * with its other side at the rates of its own entries, so the two pairs are subtracted as they
 * stand and nothing is converted again (rule 1). Only for a reader who sees both balances, and
 * never for the walk-in.
 */
function NetFigure({ party }: { party: CustomerRow }) {
  const { t } = useTranslation();
  const { balance, payable } = party;
  if (!balance || !payable || party.is_system) return null;
  const net = {
    amount_iqd: balance.amount_iqd - payable.amount_iqd,
    amount_usd_cents: balance.amount_usd_cents - payable.amount_usd_cents,
  };
  const inAccount = party.settlement_currency === 'USD' ? net.amount_usd_cents : net.amount_iqd;
  const label =
    inAccount > 0
      ? 'print:net_they_owe_us'
      : inAccount < 0
        ? 'print:net_we_owe_them'
        : 'companies:net_settled';
  return (
    <div className="mz-stack mz-net-figure" style={{ gap: 'var(--space-2)' }}>
      <span className="mz-figure__label">{t(label)}</span>
      <DualAmount
        amount_iqd={Math.abs(net.amount_iqd)}
        amount_usd_cents={Math.abs(net.amount_usd_cents)}
        primary={party.settlement_currency}
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
        ? t('customers:rate_changed', {
            old: formatter.rate(rate.old),
            new: formatter.rate(rate.new),
          })
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

function pathOf(kind: EntryKind): string {
  return `${kind}s`;
}

/**
 * "Print account" (D-086): the company's transactions between two dates — this year by default —
 * as one statement, a section per side the reader may see. Anything before the first date is
 * inside each section's opening balance.
 */
function PrintAccountSheet({
  sides,
  onClose,
  onPrint,
}: {
  sides: AccountSide[];
  onClose: () => void;
  onPrint: (range: { from: string; to: string }, sides: AccountSide[]) => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [range, setRange] = useState(() => thisYear(formatter.today()));
  const [chosen, setChosen] = useState<AccountSide[]>(sides);
  const valid = range.from !== '' && range.to !== '' && range.from <= range.to && chosen.length > 0;

  return (
    <BottomSheet
      title={t('print:statement_title')}
      open
      onClose={onClose}
      closeLabel={t('common:close')}
    >
      <div className="mz-stack">
        <p className="mz-muted">{t('print:statement_hint')}</p>
        <div className="mz-grid-2">
          <DateField
            label={t('print:statement_from')}
            value={range.from}
            max={range.to || formatter.today()}
            onChange={(event) => setRange({ ...range, from: event.target.value })}
          />
          <DateField
            label={t('print:statement_to')}
            value={range.to}
            max={formatter.today()}
            onChange={(event) => setRange({ ...range, to: event.target.value })}
          />
        </div>
        {sides.length > 1 ? (
          <fieldset className="mz-stack" style={{ gap: 0, border: 0, padding: 0, margin: 0 }}>
            <legend className="mz-field__label">{t('print:statement_sides')}</legend>
            {sides.map((side) => (
              <Checkbox
                key={side}
                label={t(side === 'sales' ? 'print:side_sales' : 'print:side_buying')}
                checked={chosen.includes(side)}
                onChange={(checked) =>
                  setChosen(
                    checked
                      ? sides.filter((one) => one === side || chosen.includes(one))
                      : chosen.filter((one) => one !== side),
                  )
                }
              />
            ))}
          </fieldset>
        ) : null}
        <Button block icon="print" disabled={!valid} onClick={() => onPrint(range, chosen)}>
          {t('print:print_statement')}
        </Button>
      </div>
    </BottomSheet>
  );
}

/**
 * Credit, refund and adjustment on the selling side (FR-504, FR-506). All three need a note,
 * because all three are somebody deciding to change a balance by hand. (An opening balance is
 * brought in by the import at go-live; the business had it taken off this page, D-080.)
 */
function LedgerEntrySheet({
  kind,
  rate,
  saving,
  error,
  onClose,
  onSave,
  onEdit,
}: {
  kind: EntryKind;
  rate: Rate | null;
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (body: unknown) => void;
  /** Any change to the inputs: the caller forgets the last refusal. */
  onEdit?: () => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [amount, setAmount] = useState<MoneyValue>({
    amount: null,
    currency: 'IQD',
    other_amount: null,
  });
  const [date, setDate] = useState(formatter.today());
  const [note, setNote] = useState('');
  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      onEdit?.();
      set(value);
    };

  return (
    <BottomSheet
      title={t(`customers:sheet.${kind}`)}
      open
      onClose={onClose}
      closeLabel={t('common:close')}
    >
      <div className="mz-stack">
        <MoneyInput
          label={t('customers:amount')}
          value={amount}
          rate={rate}
          onChange={edit(setAmount)}
          error={error}
        />
        <DateField
          label={t('common:date')}
          value={date}
          max={formatter.today()}
          onChange={(event) => edit(setDate)(event.target.value)}
        />
        <TextAreaField
          label={t('common:note')}
          value={note}
          hint={t('materials:note_required')}
          onChange={(event) => edit(setNote)(event.target.value)}
        />
        {kind === 'adjustment' ? (
          <p className="mz-caption">{t('customers:adjustment_hint')}</p>
        ) : null}
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

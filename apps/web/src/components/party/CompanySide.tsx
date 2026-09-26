import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet, Button, Card, Chip, DateField, SegmentedControl, TextField } from '@mizan/ui';
import type { MenuItem } from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { ApiError, apiRequest, newIdempotencyKey } from '../../lib/api.js';
import { Can } from '../Can.js';
import { DualAmount } from '../DualAmount.js';
import { LedgerList } from '../LedgerList.js';
import type { LedgerRow } from '../LedgerList.js';
import { MoneyInput } from '../MoneyInput.js';
import type { MoneyValue } from '../MoneyInput.js';
import { PaymentSheet } from '../PaymentSheet.js';
import { ShareDocumentSheet } from '../ShareDocumentSheet.js';
import { QueryStates } from '../states.js';
import { FilterChip } from '../../pages/MaterialsPage.js';
import { useFormatter, usePermission } from '../../lib/store.js';
import type { PurchaseRow } from '../../pages/PurchasesPage.js';

type EntryFilter = 'all' | 'payments' | 'adjustments' | 'credits' | 'purchases';
type Sheet = 'payment' | 'adjustment' | 'credit' | 'opening';

interface Allocation {
  purchases: { purchase_id: string; total: number; linked: number; allocated: number; remaining: number }[];
  general: number;
  balance: number;
}

interface Breakdown {
  settlement_currency: Currency;
  allocation: Allocation;
  purchases: { id: string; number: number; purchase_date: string; status: string }[];
  settled_count: number;
  owing_count: number;
  owing_total: number;
}

/**
 * The buying side of a business (FR-704 to FR-712, D-054): what we bought from it, what we owe
 * it with its running balance, what each purchase still owes (oldest-first, FR-712), and the
 * four ways the accountant moves that figure — a payment, an adjustment, a credit, the opening
 * debt. The record itself (name, rate, currency, assignment) belongs to the page around it.
 *
 * It is a hook, not a component, because its pieces land in different places on that page —
 * the buttons in the action bar, the lists in the tabs, the sheets at the end — while the
 * queries and mutations behind them are one set.
 */
export function useCompanySide(input: {
  id: string;
  /** False for a business we only sell to: then nothing here is fetched or shown. */
  enabled: boolean;
  tab: string;
  settlement: Currency;
  /** What we owe them now, in the settlement currency (the page's `payable`). */
  owed: number;
  /** The business's one rate, which every calculated amount here is filled at (2.3.3). */
  rate: string;
  onRecorded: (message: string) => void;
}) {
  const { id, enabled, tab, settlement, owed, rate } = input;
  const { t } = useTranslation();
  const formatter = useFormatter();
  const queryClient = useQueryClient();
  const maySeeBalance = usePermission('fields.see_company_balances');
  const mayRecordPayment = usePermission('companies.record_payment');
  const mayAdjust = usePermission('companies.adjust_owed');
  const mayCredit = usePermission('companies.record_credit');
  const mayOpening = usePermission('companies.opening_balance');

  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [entryFilter, setEntryFilter] = useState<EntryFilter>('all');
  /** The account tab asks for a page of the ledger, not an account's whole life (I2 review). */
  const [ledgerLimit, setLedgerLimit] = useState(100);
  /** Bumped by every write that puts a row in the ledger (signature moment 3, spec 3.6.2). */
  const [landedVersion, setLandedVersion] = useState(0);
  const [statement, setStatement] = useState(false);

  const ledger = useQuery({
    queryKey: ['companies', id, 'ledger', ledgerLimit],
    queryFn: () =>
      apiRequest<{
        company: { settlement_currency: Currency };
        balance: number;
        items: LedgerRow[];
        total: number;
        has_more: boolean;
      }>(`/companies/${id}/ledger?limit=${ledgerLimit}`),
    enabled: enabled && maySeeBalance && tab === 'account',
  });

  const breakdown = useQuery({
    queryKey: ['companies', id, 'breakdown'],
    queryFn: () => apiRequest<Breakdown>(`/companies/${id}/purchase-breakdown`),
    // The purchases tab needs it too: a purchase's remaining is its oldest-first share, not a
    // sum of what happens to name it (FR-712).
    enabled:
      enabled &&
      maySeeBalance &&
      (tab === 'account' || tab === 'purchases' || tab === 'overview' || sheet === 'payment'),
  });

  const purchases = useQuery({
    queryKey: ['companies', id, 'purchases'],
    queryFn: () => apiRequest<{ items: PurchaseRow[]; total: number }>(`/companies/${id}/purchases`),
    enabled: enabled && (tab === 'purchases' || tab === 'overview'),
  });

  const statementData = useQuery({
    queryKey: ['companies', id, 'statement'],
    queryFn: () => {
      const window = statementWindow();
      return apiRequest<{
        company: { name: string; settlement_currency: Currency };
        from: string | null;
        to: string | null;
        opening_balance: number;
        closing_balance: number;
        items: LedgerRow[];
        item_count: number;
        has_more: boolean;
      }>(`/companies/${id}/statement?from=${window.from}&to=${window.to}`);
    },
    enabled: enabled && statement,
  });

  const recorded = async (message: string) => {
    setSheet(null);
    input.onRecorded(message);
    await queryClient.invalidateQueries({ queryKey: ['companies'] });
    await queryClient.invalidateQueries({ queryKey: ['customers'] });
    await queryClient.invalidateQueries({ queryKey: ['purchases'] });
    setLandedVersion((version) => version + 1);
  };

  const payment = useMutation({
    mutationFn: (body: unknown) =>
      apiRequest(`/companies/${id}/payments`, { method: 'POST', body, idempotencyKey: newIdempotencyKey() }),
    onSuccess: () => recorded(t('companies:payment_recorded')),
  });

  const entry = useMutation({
    mutationFn: (request: { path: string; body: unknown }) =>
      apiRequest(`/companies/${id}/${request.path}`, {
        method: 'POST',
        body: request.body,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => recorded(t('companies:entry_recorded')),
  });

  const allocation = breakdown.data?.allocation ?? null;
  const purchaseNumbers = new Map((breakdown.data?.purchases ?? []).map((row) => [row.id, row.number]));
  const errorOf = (error: unknown) =>
    error instanceof ApiError ? t(error.messageKey, { defaultValue: t('errors:VALIDATION_FAILED') }) : undefined;

  const ledgerRows = (ledger.data?.items ?? []).filter((row) => {
    if (entryFilter === 'all') return true;
    if (entryFilter === 'payments') return row.entry_type === 'payment';
    if (entryFilter === 'adjustments') return row.entry_type === 'adjustment';
    if (entryFilter === 'credits') return row.entry_type === 'credit';
    return row.entry_type === 'purchase';
  });

  /** The one buying-side action that stays on the page: paying them. */
  const primaryAction: ReactNode =
    enabled && mayRecordPayment ? (
      <Button icon="check" onClick={() => setSheet('payment')}>
        {t('customers:make_payment')}
      </Button>
    ) : null;

  /** The rest, for the page's "More" menu. */
  const menuItems: MenuItem[] = enabled
    ? [
        ...(mayAdjust ? [{ label: t('companies:adjust_owed'), onSelect: () => setSheet('adjustment') }] : []),
        ...(mayCredit ? [{ label: t('customers:credit_from_them'), onSelect: () => setSheet('credit') }] : []),
        ...(mayOpening ? [{ label: t('customers:opening_ours'), onSelect: () => setSheet('opening') }] : []),
        ...(maySeeBalance
          ? [{ label: t('customers:statement_purchases'), onSelect: () => setStatement(true) }]
          : []),
      ]
    : [];

  const newPurchase = (
    <Can permission="purchases.create">
      <Link to={`/purchases/new?company=${id}`} className="mz-button mz-button--primary">
        {t('purchases:add_material')}
      </Link>
    </Can>
  );

  const purchaseList = (limit?: number) => (
    <QueryStates
      query={purchases}
      isEmpty={(purchases.data?.items.length ?? 0) === 0}
      emptyTitle={t('companies:no_purchases')}
      emptyAction={newPurchase}
      skeletonLines={3}
    >
      <ul className="mz-list">
        {(purchases.data?.items ?? []).slice(0, limit).map((purchase) => (
          <PurchaseListItem
            key={purchase.id}
            purchase={purchase}
            settlement={settlement}
            remaining={allocation?.purchases.find((row) => row.purchase_id === purchase.id)?.remaining ?? null}
          />
        ))}
      </ul>
    </QueryStates>
  );

  const account: ReactNode = (
    <>
      <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {(['payments', 'adjustments', 'credits', 'purchases'] as EntryFilter[]).map((filter) => (
          <FilterChip
            key={filter}
            active={entryFilter === filter}
            onClick={() => setEntryFilter(entryFilter === filter ? 'all' : filter)}
          >
            {t(`companies:entry.${singularOf(filter)}`)}
          </FilterChip>
        ))}
      </div>

      <QueryStates query={ledger} isEmpty={ledgerRows.length === 0} emptyTitle={t('companies:no_entries')}>
        <Card>
          <LedgerList
            items={ledgerRows}
            settlement_currency={ledger.data?.company.settlement_currency ?? settlement}
            namespace="companies"
            landedVersion={landedVersion}
          />
          {ledger.data?.has_more ? (
            <div className="mz-stack" style={{ marginBlockStart: 'var(--space-3)' }}>
              <span className="mz-caption">
                {t('companies:more_entries', {
                  shown: formatter.number(ledger.data.items.length),
                  total: formatter.number(ledger.data.total),
                })}
              </span>
              <Button variant="secondary" onClick={() => setLedgerLimit(ledgerLimit + 100)}>
                {t('companies:show_more')}
              </Button>
            </div>
          ) : null}
        </Card>
      </QueryStates>

      {/* FR-712: what we owe per purchase, with nothing linked by hand. */}
      {allocation ? (
        <Card>
          <h3 className="mz-heading">{t('companies:per_purchase')}</h3>
          <p className="mz-caption">{t('companies:per_purchase_hint')}</p>
          <ul className="mz-list">
            {allocation.purchases
              .filter((row) => row.remaining !== 0)
              .map((row) => (
                <li key={row.purchase_id}>
                  <Link to={`/purchases/${row.purchase_id}`} className="mz-list__item mz-list__item--interactive">
                    <span className="mz-list__body">
                      <span className="mz-list__title">
                        {t('purchases:number', {
                          number: formatter.number(purchaseNumbers.get(row.purchase_id) ?? 0),
                        })}
                      </span>
                    </span>
                    <span className="mz-list__end" data-tabular>
                      {formatter.money(row.remaining, settlement)}
                    </span>
                  </Link>
                </li>
              ))}
            {breakdown.data && breakdown.data.owing_count > allocation.purchases.length ? (
              <li className="mz-list__item">
                <span className="mz-list__body">
                  <span className="mz-caption">
                    {t('companies:more_entries', {
                      shown: formatter.number(allocation.purchases.length),
                      total: formatter.number(breakdown.data.owing_count),
                    })}
                  </span>
                </span>
                <span className="mz-list__end" data-tabular>
                  {formatter.money(breakdown.data.owing_total, settlement)}
                </span>
              </li>
            ) : null}
            {allocation.general !== 0 ? (
              <li className="mz-list__item">
                <span className="mz-list__body">
                  <span className="mz-list__title">{t('companies:general_bucket')}</span>
                </span>
                <span className="mz-list__end" data-tabular>
                  {formatter.money(allocation.general, settlement)}
                </span>
              </li>
            ) : null}
          </ul>
        </Card>
      ) : null}
    </>
  );

  const sheets: ReactNode = (
    <>
      {sheet === 'payment' ? (
        <PaymentSheet
          open
          title={t('companies:sheet.payment')}
          amountLabel={t('companies:amount_paid')}
          remainingLabel={t('companies:we_owe_them')}
          saveLabel={t('customers:make_payment')}
          remainingHint={t('companies:settle_in_full_hint')}
          remaining={Math.max(owed, 0)}
          settlement_currency={settlement}
          rate={rate}
          saving={payment.isPending}
          purchases={(allocation?.purchases ?? [])
            .filter((row) => row.remaining > 0)
            .map((row) => ({
              id: row.purchase_id,
              label: `${t('purchases:number', {
                number: formatter.number(purchaseNumbers.get(row.purchase_id) ?? 0),
              })} · ${formatter.money(row.remaining, settlement)}`,
            }))}
          error={errorOf(payment.error)}
          onClose={() => setSheet(null)}
          onSave={(body) => payment.mutate(body)}
        />
      ) : null}

      {statement && statementData.data ? (
        <ShareDocumentSheet
          title={t('customers:statement_purchases')}
          open
          onClose={() => setStatement(false)}
          text={`${statementData.data.company.name}: ${formatter.money(
            statementData.data.closing_balance,
            statementData.data.company.settlement_currency,
          )}`}
        >
          <div className="mz-receipt">
            <strong>
              <bdi>{statementData.data.company.name}</bdi>
            </strong>
            <p className="mz-caption">{t('common:statement_window')}</p>
            {statementData.data.has_more ? (
              <p className="mz-caption">
                {t('common:statement_capped', {
                  shown: statementData.data.items.length,
                  total: statementData.data.item_count,
                })}
              </p>
            ) : null}
            {/* A statement is a document for a period, so it says which one (D-025). */}
            <span className="mz-caption">
              {t('companies:statement_range', {
                from: statementData.data.from ? formatter.date(statementData.data.from) : '—',
                to: formatter.date(statementData.data.to ?? formatter.today()),
              })}
            </span>
            <div className="mz-receipt__line">
              <span>{t('glossary:opening_balance')}</span>
              <span data-tabular>
                {formatter.money(statementData.data.opening_balance, statementData.data.company.settlement_currency)}
              </span>
            </div>
            {statementData.data.items.map((row) => (
              <div key={row.entry_id} className="mz-receipt__line">
                <span>
                  {formatter.date(row.entry_date)} · {t(`companies:entry.${row.entry_type}`)}
                </span>
                <span data-tabular>
                  {formatter.money(
                    statementData.data.company.settlement_currency === 'IQD' ? row.amount_iqd : row.amount_usd_cents,
                    statementData.data.company.settlement_currency,
                  )}
                </span>
              </div>
            ))}
            <div className="mz-receipt__line">
              <strong>{t('glossary:balance')}</strong>
              <strong data-tabular>
                {formatter.money(statementData.data.closing_balance, statementData.data.company.settlement_currency)}
              </strong>
            </div>
          </div>
        </ShareDocumentSheet>
      ) : null}

      {sheet === 'adjustment' ? (
        <AdjustOwedSheet
          balance={owed}
          settlement_currency={settlement}
          rate={rate}
          saving={entry.isPending}
          error={errorOf(entry.error)}
          onClose={() => setSheet(null)}
          onSave={(body) => entry.mutate({ path: 'adjustments', body })}
        />
      ) : null}

      {sheet === 'credit' || sheet === 'opening' ? (
        <CompanyEntrySheet
          kind={sheet}
          rate={rate}
          saving={entry.isPending}
          error={errorOf(entry.error)}
          onClose={() => setSheet(null)}
          onSave={(body) => entry.mutate({ path: sheet === 'credit' ? 'credits' : 'opening-balance', body })}
        />
      ) : null}
    </>
  );

  return {
    primaryAction,
    menuItems,
    purchasesTab: purchaseList(),
    recentPurchases: purchaseList(5),
    accountTab: account,
    sheets,
  };
}

/**
 * A statement covers the last twelve months, not the whole history: asking for everything
 * returned 15.8 MB for a ten-year account (the system-wide review). Anything older is inside
 * the opening balance, which the server sums over the whole history.
 */
export function statementWindow(): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today);
  from.setFullYear(from.getFullYear() - 1);
  return { from: from.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) };
}

function singularOf(filter: EntryFilter): string {
  if (filter === 'payments') return 'payment';
  if (filter === 'adjustments') return 'adjustment';
  if (filter === 'credits') return 'credit';
  return 'purchase';
}

function PurchaseListItem({
  purchase,
  settlement,
  remaining,
}: {
  purchase: PurchaseRow;
  settlement: Currency;
  remaining: number | null;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  return (
    <li>
      <Link to={`/purchases/${purchase.id}`} className="mz-list__item mz-list__item--interactive mz-list__item--detail">
        <span className="mz-list__body">
          <span className="mz-list__title">{t('purchases:number', { number: formatter.number(purchase.number) })}</span>
          <span className="mz-caption" style={{ display: 'block' }}>
            {formatter.date(purchase.purchase_date)}
          </span>
          {remaining !== null && remaining > 0 ? (
            <span className="mz-caption mz-owed" style={{ display: 'block' }} data-tabular>
              {t('glossary:remaining')}: {formatter.money(remaining, settlement)}
            </span>
          ) : null}
        </span>
        <span className="mz-list__end">
          {purchase.doc_status === 'void' ? (
            <Chip tone="danger" icon="close">
              {t('glossary:void')}
            </Chip>
          ) : purchase.cost ? (
            <DualAmount
              amount_iqd={purchase.cost.total_iqd}
              amount_usd_cents={purchase.cost.total_usd_cents}
              primary={settlement}
            />
          ) : null}
        </span>
      </Link>
    </li>
  );
}

/**
 * "Change how much we owe" (FR-706): the accountant types the **new balance** or the change,
 * never both, and sees what it will become before saving. A note is required, because this is
 * somebody deciding a figure by hand.
 */
function AdjustOwedSheet({
  balance,
  settlement_currency,
  rate,
  saving,
  error,
  onClose,
  onSave,
}: {
  balance: number;
  settlement_currency: Currency;
  rate: string;
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (body: unknown) => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [mode, setMode] = useState<'new_balance' | 'delta'>('delta');
  const [amount, setAmount] = useState<MoneyValue>({ amount: null, currency: settlement_currency, other_amount: null });
  const [date, setDate] = useState(formatter.today());
  const [note, setNote] = useState('');

  const typed = amount.amount;
  const after = typed === null ? balance : mode === 'new_balance' ? typed : balance + typed;

  return (
    <BottomSheet title={t('companies:sheet.adjustment')} open onClose={onClose} closeLabel={t('common:close')}>
      <div className="mz-stack">
        <SegmentedControl
          label={t('companies:adjust_mode_hint')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'delta', label: t('companies:adjust_delta') },
            { value: 'new_balance', label: t('companies:adjust_new_balance') },
          ]}
        />
        <MoneyInput
          label={mode === 'new_balance' ? t('companies:adjust_new_balance') : t('companies:adjust_delta')}
          value={amount}
          rate={rate}
          onChange={setAmount}
          error={error}
        />
        <div className="mz-row mz-row--between">
          <span className="mz-caption">{t('companies:adjust_before')}</span>
          <span data-tabular>{formatter.money(balance, settlement_currency)}</span>
        </div>
        <div className="mz-row mz-row--between">
          <span className="mz-caption">{t('companies:adjust_after')}</span>
          <span data-tabular>{formatter.money(after, settlement_currency)}</span>
        </div>
        <DateField
          label={t('common:date')}
          value={date}
          max={formatter.today()}
          onChange={(event) => setDate(event.target.value)}
        />
        <TextField
          label={t('common:note')}
          value={note}
          hint={t('companies:note_required')}
          onChange={(event) => setNote(event.target.value)}
        />
        <Button
          block
          loading={saving}
          disabled={typed === null || note.trim().length < 3}
          onClick={() =>
            onSave({
              ...(mode === 'new_balance' ? { new_balance: typed } : { delta: typed }),
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

/** A credit for goods returned (FR-707) and the opening debt at go-live (FR-708). */
function CompanyEntrySheet({
  kind,
  rate,
  saving,
  error,
  onClose,
  onSave,
}: {
  kind: 'credit' | 'opening';
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
    <BottomSheet title={t(`companies:sheet.${kind}`)} open onClose={onClose} closeLabel={t('common:close')}>
      <div className="mz-stack">
        <MoneyInput label={t('companies:amount')} value={amount} rate={rate} onChange={setAmount} error={error} />
        <DateField
          label={t('common:date')}
          value={date}
          max={formatter.today()}
          onChange={(event) => setDate(event.target.value)}
        />
        <TextField
          label={t('common:note')}
          value={note}
          hint={t('companies:note_required')}
          onChange={(event) => setNote(event.target.value)}
        />
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

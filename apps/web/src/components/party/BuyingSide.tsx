import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet, Button, Card, DateField, IconButton, SegmentedControl, TextField } from '@mizan/ui';
import type { MenuItem } from '@mizan/ui';
import type { Currency, Rate } from '@mizan/money';
import { apiRequest } from '../../lib/api.js';
import { useIdempotencyKey } from '../../lib/idempotency.js';
import { usePaging, useKeepPageInRange } from '../../lib/paging.js';
import { useFormatter, usePermission } from '../../lib/store.js';
import { errorMessage } from '../../lib/errors.js';
import { invalidateMoneyViews } from '../../lib/invalidate.js';
import { documentOfLedgerRow, usePrint } from '../../lib/print.js';
import type { PurchaseRow } from '../../lib/purchases.js';
import { Can } from '../Can.js';
import { DualAmount } from '../DualAmount.js';
import { bothOf } from '../../lib/money.js';
import { LedgerList } from '../LedgerList.js';
import type { LedgerRow } from '../LedgerList.js';
import { MoneyInput } from '../MoneyInput.js';
import type { MoneyValue } from '../MoneyInput.js';
import { Pager } from '../Pager.js';
import { PaymentSheet } from '../PaymentSheet.js';
import { PrintSelectionBar, usePrintSelection } from '../PrintSelection.js';
import { PurchaseTable } from '../PurchaseTable.js';
import { paymentReceipt } from '../SavedToast.js';
import type { SavedNotice } from '../SavedToast.js';
import { QueryStates } from '../states.js';

type Sheet = 'payment' | 'adjustment' | 'credit';

/** "What we owe per purchase", oldest first (FR-712), a page at a time. */
interface Breakdown {
  settlement_currency: Currency;
  allocation: {
    purchases: { purchase_id: string; total: number; linked: number; allocated: number; remaining: number }[];
    general: number;
    balance: number;
  };
  purchases: { id: string; number: number; purchase_date: string; status: string }[];
  owing_count: number;
  owing_total: number;
  /** Over every purchase, not the page: only those with something left to pay (D-085). */
  still_owed_count: number;
  still_owed_total: number;
}

/**
 * The buying side of a company (D-085, FR-704 to FR-712): what we bought from it, what we owe
 * it — per purchase and as a running account — and the ways that figure moves: paying them, a
 * credit for goods sent back, and an adjustment with a note. Taken off the screens in D-062 and
 * brought back when the business said buying is most of what it uses the system for.
 *
 * A hook, not a component, because its pieces land in different places on the company's page —
 * the buttons in the action bar, the lists in the tabs, the sheets at the end — while the
 * queries and mutations behind them are one set.
 */
export function useBuyingSide(input: {
  id: string;
  /** The company's name, for the payment sheet's "Money out — to …" (D-088). */
  name: string;
  /** False for the walk-in customer, which nobody buys from: nothing here is fetched or shown. */
  enabled: boolean;
  tab: string;
  settlement: Currency;
  /** What we owe them now, in the account's currency (the page's `payable`). */
  owed: number;
  /** The account's rate — its own, else the system's — which every amount here is filled at. */
  rate: Rate | null;
  onRecorded: (notice: SavedNotice) => void;
}) {
  const { id, enabled, tab, settlement, owed, rate } = input;
  const { t } = useTranslation();
  const formatter = useFormatter();
  const queryClient = useQueryClient();
  const print = usePrint();
  const maySeeOwed = usePermission('fields.see_company_balances');
  const maySeePurchases = usePermission('purchases.view');
  const mayPay = usePermission('companies.record_payment');
  const mayAdjust = usePermission('companies.adjust_owed');
  const mayCredit = usePermission('companies.record_credit');

  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [landedVersion, setLandedVersion] = useState(0);

  // The account, a page at a time (D-058).
  const ledgerPaging = usePaging({ storageKey: 'account-ledger', prefix: 'buying_' });
  const ledger = useQuery({
    queryKey: ['companies', id, 'ledger', ledgerPaging.page, ledgerPaging.pageSize],
    queryFn: () =>
      apiRequest<{ company: { settlement_currency: Currency }; items: LedgerRow[]; total: number }>(
        `/companies/${id}/ledger?${ledgerPaging.query}`,
      ),
    enabled: enabled && maySeeOwed && tab === 'buying',
    placeholderData: keepPreviousData,
  });
  useKeepPageInRange(ledgerPaging, ledger);

  // What each purchase still owes: the largest page the API sends, oldest first, which is where
  // the money goes first. The Purchases tab, the overview and the payment sheet all read it.
  const owing = useQuery({
    queryKey: ['companies', id, 'breakdown', 'owing'],
    queryFn: () => apiRequest<Breakdown>(`/companies/${id}/purchase-breakdown?page_size=100`),
    enabled: enabled && maySeeOwed && (tab === 'overview' || tab === 'purchases' || tab === 'buying' || sheet === 'payment'),
  });

  const purchasesPaging = usePaging({ storageKey: 'account-purchases', prefix: 'purchases_' });
  const purchases = useQuery({
    queryKey: ['companies', id, 'purchases', purchasesPaging.page, purchasesPaging.pageSize],
    queryFn: () =>
      apiRequest<{ items: PurchaseRow[]; total: number }>(`/companies/${id}/purchases?${purchasesPaging.query}`),
    enabled: enabled && maySeePurchases && tab === 'purchases',
    placeholderData: keepPreviousData,
  });
  useKeepPageInRange(purchasesPaging, purchases);

  const owingRows = owing.data?.allocation.purchases ?? [];
  // What is actually still owed: a purchase overpaid through a payment that named it has a
  // negative remainder, which is money paid ahead, not a debt (review).
  const stillOwed = owingRows.filter((row) => row.remaining > 0);
  // The count and the total are the server's, over every purchase — the page above holds at most
  // a hundred, and a long-standing supplier has more (second review).
  const stillOwedCount = owing.data?.still_owed_count ?? stillOwed.length;
  const stillOwedTotal = owing.data?.still_owed_total ?? 0;
  /** A figure in the account's currency, with the other side at the account's rate (rule 7). */
  const owedAmount = (value: number) =>
    rate === null ? (
      <span data-tabular>{formatter.money(value, settlement)}</span>
    ) : (
      <DualAmount {...bothOf(value, settlement, rate)} primary={settlement} kind="derived" />
    );
  const owingNumbers = new Map((owing.data?.purchases ?? []).map((row) => [row.id, row]));
  /** A purchase not among the owing ones is paid — unless the owing list was cut short. */
  const remainingOf = (row: PurchaseRow): number | null => {
    if (!owing.data) return null;
    const found = owingRows.find((candidate) => candidate.purchase_id === row.id);
    if (found) return found.remaining;
    return owing.data.owing_count > owingRows.length ? null : 0;
  };

  const selectPurchases = usePrintSelection<PurchaseRow>(
    (row) => ({ kind: 'purchase', id: row.id }),
    (row) => row.id,
  );
  const selectEntries = usePrintSelection<LedgerRow>(
    (row) => documentOfLedgerRow('buying', id, row, maySeePurchases),
    (row) => row.entry_id,
  );

  const recorded = async (notice: SavedNotice) => {
    setSheet(null);
    input.onRecorded(notice);
    setLandedVersion((version) => version + 1);
    await queryClient.invalidateQueries({ queryKey: ['companies'] });
    await queryClient.invalidateQueries({ queryKey: ['customers'] });
    await queryClient.invalidateQueries({ queryKey: ['purchases'] });
    await invalidateMoneyViews(queryClient);
  };

  // One key per opening of a sheet, held across its retries (FR-1305).
  const paymentKey = useIdempotencyKey(`buying-payment:${id}:${sheet ?? ''}`);
  const entryKey = useIdempotencyKey(`buying-entry:${id}:${sheet ?? ''}`);

  const payment = useMutation({
    mutationFn: (body: unknown) =>
      apiRequest<unknown>(`/companies/${id}/payments`, { method: 'POST', body, idempotencyKey: paymentKey.key }),
    onSuccess: async (answer) => {
      paymentKey.renew();
      await recorded({ message: t('companies:payment_recorded'), receipt: paymentReceipt('buying', id, answer) });
    },
  });
  const entry = useMutation({
    mutationFn: (request: { path: string; body: unknown }) =>
      apiRequest<unknown>(`/companies/${id}/${request.path}`, {
        method: 'POST',
        body: request.body,
        idempotencyKey: entryKey.key,
      }),
    onSuccess: async (answer) => {
      entryKey.renew();
      await recorded({ message: t('companies:entry_recorded'), receipt: paymentReceipt('buying', id, answer) });
    },
  });

  const close = () => {
    setSheet(null);
    payment.reset();
    entry.reset();
  };
  const errorOf = (error: unknown) => errorMessage(t, error) ?? undefined;

  const primaryActions: ReactNode = enabled ? (
    <>
      {mayPay ? (
        <Button variant="money-out" icon="money-out" onClick={() => setSheet('payment')}>
          {t('common:we_paid_them')}
        </Button>
      ) : null}
      <Can permission="purchases.create">
        <Link to={`/purchases/new?company=${id}`} className="mz-button mz-button--secondary">
          {t('purchases:new_purchase')}
        </Link>
      </Can>
    </>
  ) : null;

  const menuItems: MenuItem[] = enabled
    ? [
        ...(mayCredit ? [{ label: t('companies:credit_from_them'), onSelect: () => setSheet('credit') }] : []),
        ...(mayAdjust ? [{ label: t('companies:adjust_owed'), onSelect: () => setSheet('adjustment') }] : []),
      ]
    : [];

  /** The purchases still owed, on the overview — what an accountant chases first. */
  const overviewCard: ReactNode =
    enabled && maySeeOwed ? (
      <Card>
        <h3 className="mz-heading">{t('companies:purchases_owed')}</h3>
        <QueryStates
          query={owing}
          isEmpty={stillOwedCount === 0}
          emptyTitle={t('companies:nothing_owed')}
          skeletonLines={3}
        >
          <ul className="mz-list">
            {stillOwed.slice(0, 5).map((row) => {
              const purchase = owingNumbers.get(row.purchase_id);
              return (
                <li key={row.purchase_id}>
                  <Link to={`/purchases/${row.purchase_id}`} className="mz-list__item mz-list__item--interactive">
                    <span className="mz-list__body">
                      <span className="mz-list__title">
                        {t('purchases:number', { number: formatter.identifier(purchase?.number ?? 0) })}
                      </span>
                      {purchase ? <span className="mz-caption">{formatter.date(purchase.purchase_date)}</span> : null}
                    </span>
                    <span className="mz-list__end mz-owed">{owedAmount(row.remaining)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {stillOwedCount > 5 ? (
            <p className="mz-caption mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <span>{t('companies:more_owed', { count: stillOwedCount - 5 })}</span>
              {owedAmount(stillOwedTotal)}
            </p>
          ) : null}
        </QueryStates>
      </Card>
    ) : null;

  const purchasesTab: ReactNode = (
    <>
      <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <PrintSelectionBar state={selectPurchases} />
      </div>
      <QueryStates
        query={purchases}
        isEmpty={(purchases.data?.items.length ?? 0) === 0}
        emptyTitle={t('companies:no_purchases')}
        emptyAction={
          <Can permission="purchases.create">
            <Link to={`/purchases/new?company=${id}`} className="mz-button mz-button--primary">
              {t('purchases:new_purchase')}
            </Link>
          </Can>
        }
      >
        <PurchaseTable
          rows={purchases.data?.items ?? []}
          showCompany={false}
          remainingOf={maySeeOwed ? remainingOf : undefined}
          selection={selectPurchases.selection}
        />
        <Pager
          page={purchasesPaging.page}
          pageSize={purchasesPaging.pageSize}
          total={purchases.data?.total ?? 0}
          onPage={purchasesPaging.setPage}
          onPageSize={purchasesPaging.setPageSize}
        />
      </QueryStates>
    </>
  );

  const accountTab: ReactNode = (
    <>
      <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <PrintSelectionBar state={selectEntries} />
      </div>
      <QueryStates
        query={ledger}
        isEmpty={(ledger.data?.items.length ?? 0) === 0}
        emptyTitle={t('companies:no_entries')}
      >
        <Card>
          <LedgerList
            items={ledger.data?.items ?? []}
            settlement_currency={ledger.data?.company.settlement_currency ?? settlement}
            namespace="companies"
            landedVersion={landedVersion}
            selection={selectEntries.selection}
            actions={(row) => (
              <IconButton
                icon="print"
                label={t('print:print_receipt')}
                onClick={() => print([documentOfLedgerRow('buying', id, row, maySeePurchases)])}
              />
            )}
          />
          <Pager
            page={ledgerPaging.page}
            pageSize={ledgerPaging.pageSize}
            total={ledger.data?.total ?? 0}
            onPage={ledgerPaging.setPage}
            onPageSize={ledgerPaging.setPageSize}
          />
        </Card>
      </QueryStates>
    </>
  );

  const sheets: ReactNode = (
    <>
      {sheet === 'payment' ? (
        <PaymentSheet
          open
          direction="out"
          counterparty={input.name}
          remainingLabel={t('companies:we_owe_them')}
          settleHint={t('companies:settle_in_full_hint')}
          remaining={Math.max(owed, 0)}
          settlement_currency={settlement}
          rate={rate}
          saving={payment.isPending}
          purchases={owingRows
            .filter((row) => row.remaining > 0)
            .map((row) => ({
              id: row.purchase_id,
              label: `${t('purchases:number', {
                number: formatter.identifier(owingNumbers.get(row.purchase_id)?.number ?? 0),
              })} · ${formatter.money(row.remaining, settlement)}`,
            }))}
          error={errorOf(payment.error)}
          onClose={close}
          onEdit={payment.reset}
          onSave={(body) => payment.mutate(body)}
        />
      ) : null}
      {sheet === 'adjustment' ? (
        <AdjustOwedSheet
          balance={owed}
          settlement={settlement}
          rate={rate}
          saving={entry.isPending}
          error={errorOf(entry.error)}
          onClose={close}
          onEdit={entry.reset}
          onSave={(body) => entry.mutate({ path: 'adjustments', body })}
        />
      ) : null}
      {sheet === 'credit' ? (
        <CreditSheet
          rate={rate}
          saving={entry.isPending}
          error={errorOf(entry.error)}
          onClose={close}
          onEdit={entry.reset}
          onSave={(body) => entry.mutate({ path: 'credits', body })}
        />
      ) : null}
    </>
  );

  return {
    /** Whether this reader may see what we owe them (`fields.see_company_balances`). */
    maySeeOwed: enabled && maySeeOwed,
    maySeePurchases: enabled && maySeePurchases,
    primaryActions,
    menuItems,
    overviewCard,
    purchasesTab,
    accountTab,
    sheets,
  };
}

/**
 * "Adjust what we owe" (FR-706): the accountant types the change or the new balance, never both,
 * and sees what it will become before saving. A note is required, because this is somebody
 * deciding a figure by hand.
 */
function AdjustOwedSheet({
  balance,
  settlement,
  rate,
  saving,
  error,
  onClose,
  onEdit,
  onSave,
}: {
  balance: number;
  settlement: Currency;
  rate: Rate | null;
  saving: boolean;
  error?: string;
  onClose: () => void;
  onEdit: () => void;
  onSave: (body: unknown) => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [mode, setMode] = useState<'delta' | 'new_balance'>('delta');
  const [amount, setAmount] = useState<MoneyValue>({ amount: null, currency: settlement, other_amount: null });
  const [date, setDate] = useState(formatter.today());
  const [note, setNote] = useState('');
  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      onEdit();
      set(value);
    };

  // The preview is in the account's currency; a figure typed in the other one is the server's to
  // convert, so the preview waits for it rather than guessing.
  const typed = amount.currency === settlement ? amount.amount : null;
  const after = typed === null ? null : mode === 'new_balance' ? typed : balance + typed;

  return (
    <BottomSheet title={t('companies:sheet.adjustment')} open onClose={onClose} closeLabel={t('common:close')}>
      <div className="mz-stack">
        <SegmentedControl
          label={t('companies:adjust_mode_hint')}
          value={mode}
          onChange={edit(setMode)}
          options={[
            { value: 'delta', label: t('companies:adjust_delta') },
            { value: 'new_balance', label: t('companies:adjust_new_balance') },
          ]}
        />
        <MoneyInput
          label={mode === 'new_balance' ? t('companies:adjust_new_balance') : t('companies:adjust_delta')}
          hint={mode === 'delta' ? t('companies:adjust_delta_hint') : undefined}
          value={amount}
          rate={rate}
          onChange={edit(setAmount)}
          error={error}
        />
        <div className="mz-row mz-row--between">
          <span className="mz-caption">{t('companies:adjust_before')}</span>
          <span data-tabular>{formatter.money(balance, settlement)}</span>
        </div>
        {after !== null ? (
          <div className="mz-row mz-row--between">
            <span className="mz-caption">{t('companies:adjust_after')}</span>
            <span data-tabular>{formatter.money(after, settlement)}</span>
          </div>
        ) : null}
        <DateField
          label={t('common:date')}
          value={date}
          max={formatter.today()}
          onChange={(event) => edit(setDate)(event.target.value)}
        />
        <TextField
          label={t('common:note')}
          value={note}
          hint={t('companies:note_required')}
          onChange={(event) => edit(setNote)(event.target.value)}
        />
        <Button
          block
          loading={saving}
          disabled={amount.amount === null || note.trim().length < 3}
          onClick={() =>
            onSave({
              ...(mode === 'new_balance' ? { new_balance: amount.amount } : { delta: amount.amount }),
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

/** A credit from them (FR-707) — goods sent back, or money they let us off — which lowers what we owe. */
function CreditSheet({
  rate,
  saving,
  error,
  onClose,
  onEdit,
  onSave,
}: {
  rate: Rate | null;
  saving: boolean;
  error?: string;
  onClose: () => void;
  onEdit: () => void;
  onSave: (body: unknown) => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [amount, setAmount] = useState<MoneyValue>({ amount: null, currency: 'IQD', other_amount: null });
  const [date, setDate] = useState(formatter.today());
  const [note, setNote] = useState('');
  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      onEdit();
      set(value);
    };

  return (
    <BottomSheet title={t('companies:sheet.credit')} open onClose={onClose} closeLabel={t('common:close')}>
      <div className="mz-stack">
        <p className="mz-muted">{t('companies:credit_hint')}</p>
        <MoneyInput label={t('companies:amount')} value={amount} rate={rate} onChange={edit(setAmount)} error={error} />
        <DateField
          label={t('common:date')}
          value={date}
          max={formatter.today()}
          onChange={(event) => edit(setDate)(event.target.value)}
        />
        <TextField
          label={t('common:note')}
          value={note}
          hint={t('companies:note_required')}
          onChange={(event) => edit(setNote)(event.target.value)}
        />
        <Button
          block
          loading={saving}
          disabled={amount.amount === null || amount.amount <= 0 || note.trim() === ''}
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

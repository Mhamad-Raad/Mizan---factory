import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BottomSheet, Button, DateField, NumberField, SegmentedControl, TextField, Toggle } from '@mizan/ui';
import { convert } from '@mizan/money';
import type { Currency, Rate } from '@mizan/money';
import { MoneyInput, parseMinor } from './MoneyInput.js';
import type { MoneyValue } from './MoneyInput.js';
import { DualAmount } from './DualAmount.js';
import { useFormatter } from '../lib/store.js';
import { bothOf } from '../lib/money.js';

export interface PaymentBody {
  amount: number;
  currency: Currency;
  other_amount?: number | null;
  entry_date: string;
  settle_in_full?: boolean;
  allow_excess?: boolean;
  method?: 'cash' | 'transfer' | 'other';
  split?: { amount: number; currency: Currency }[] | null;
  note?: string | null;
  /** The document this payment is *said* to be for (wireframe 3.4.2, "More"). */
  purchase_id?: string | null;
}

export interface PaymentSheetProps {
  open: boolean;
  onClose: () => void;
  /** What is still owed, in the settlement currency: the sheet pre-fills it (FR-606). */
  remaining: number;
  settlement_currency: Currency;
  /**
   * The account's rate — its own when it has one, else today's global rate, as the server
   * applies it. `null` when no rate is set: the previews then stay in the settlement currency.
   */
  rate: Rate | null;
  saving?: boolean;
  error?: string;
  /** Set when the API asked for a confirmation ("record the excess as customer credit"). */
  needsExcessConfirmation?: boolean;
  onSave: (body: PaymentBody) => void;
  /**
   * Called on every change to the sheet's inputs, so the caller can forget the last refusal —
   * above all "record the excess as credit?", which must not carry over to a different amount.
   */
  onEdit?: () => void;
  title?: string;
  /** Money out is worded differently from money in; the company side passes its own labels. */
  amountLabel?: string;
  remainingLabel?: string;
  saveLabel?: string;
  remainingHint?: string;
  /** What "Settle in full" closes — an order, a purchase, an account — worded by the caller. */
  settleHint?: string;
  /**
   * The open purchases of this company, for "More → link to a purchase" (wireframe 3.4.2).
   * Leaving a payment unlinked is the normal case: the oldest-first view allocates it anyway
   * (FR-712), so the picker is behind More and never required.
   */
  purchases?: { id: string; label: string }[];
}

/**
 * "Record payment" (FR-606, flow 3.5.4). The remaining amount is pre-filled; a smaller figure
 * is a part-payment; **Settle in full** writes the exact remainder with what was actually
 * handed over, so paying the last instalment in dollars leaves no five-dinar residue. The
 * split row is Proposed — not requested (FR-617).
 */
export function PaymentSheet({
  open,
  onClose,
  remaining,
  settlement_currency,
  rate,
  saving,
  error,
  needsExcessConfirmation,
  onSave,
  onEdit,
  title,
  amountLabel,
  remainingLabel,
  saveLabel,
  remainingHint,
  settleHint,
  purchases,
}: PaymentSheetProps) {
  const { t } = useTranslation();
  const formatter = useFormatter();

  const [amount, setAmountState] = useState<MoneyValue>({
    amount: remaining,
    currency: settlement_currency,
    other_amount: null,
  });
  const [date, setDateState] = useState(formatter.today());
  const [settleInFull, setSettleInFullState] = useState(false);
  const [method, setMethodState] = useState<'cash' | 'transfer' | 'other'>('cash');
  const [note, setNoteState] = useState('');
  const [splitting, setSplittingState] = useState(false);
  const [splitIqd, setSplitIqdState] = useState('');
  const [splitUsd, setSplitUsdState] = useState('');
  const [showMore, setShowMore] = useState(false);
  const [purchaseId, setPurchaseIdState] = useState('');

  // Every input goes through `edited`, so a changed payment is a new question to the server.
  const edited =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      onEdit?.();
      set(value);
    };
  const setAmount = edited(setAmountState);
  const setDate = edited(setDateState);
  const setSettleInFull = edited(setSettleInFullState);
  const setMethod = edited(setMethodState);
  const setNote = edited(setNoteState);
  const setSplitting = edited(setSplittingState);
  const setSplitIqd = edited(setSplitIqdState);
  const setSplitUsd = edited(setSplitUsdState);
  const setPurchaseId = edited(setPurchaseIdState);

  const splitParts = () => {
    const parts: { amount: number; currency: Currency }[] = [];
    const iqd = parseMinor(splitIqd, 'IQD');
    const usd = parseMinor(splitUsd, 'USD');
    if (iqd) parts.push({ amount: iqd, currency: 'IQD' });
    if (usd) parts.push({ amount: usd, currency: 'USD' });
    return parts;
  };

  const canSave = splitting ? splitParts().length >= 2 : amount.amount !== null && amount.amount > 0;

  /**
   * "After this payment" (wireframe 3.4.2): the remainder in the settlement currency, taking
   * the entered side as authoritative and converting only for the preview. Settle in full
   * lands on nothing owed by definition.
   */
  const inSettlement = (minor: number, currency: Currency, other?: number | null): number =>
    currency === settlement_currency ? minor : (other ?? (rate === null ? 0 : convert(minor, currency, rate)));
  const paidInSettlement = splitting
    ? splitParts().reduce((total, part) => total + inSettlement(part.amount, part.currency), 0)
    : amount.amount === null
      ? 0
      : inSettlement(amount.amount, amount.currency, amount.other_amount);
  const afterPayment = settleInFull ? 0 : remaining - paidInSettlement;

  return (
    <BottomSheet
      title={title ?? t('customers:record_payment')}
      open={open}
      onClose={onClose}
      closeLabel={t('common:close')}
    >
      <div className="mz-stack">
        <div className="mz-row mz-row--between">
          <span>{remainingLabel ?? t('orders:remaining')}</span>
          {/*
            * The counterpart is converted at this account's rate rather than left at zero:
            * a remainder of 3,050,000 IQD is not "$0.00", and rule 7 asks for both currencies
            * with ≈ on the figure that was derived rather than stored.
            */}
          <SettlementAmount amount={remaining} currency={settlement_currency} rate={rate} />
        </div>

        {!splitting ? (
          <>
            <MoneyInput
              label={amountLabel ?? t('customers:amount_received')}
              value={amount}
              rate={rate}
              onChange={setAmount}
              error={error}
            />
            <Toggle
              label={t('glossary:settle_in_full')}
              hint={settleHint ?? t('customers:settle_in_full_hint')}
              checked={settleInFull}
              onChange={setSettleInFull}
            />
          </>
        ) : (
          <div className="mz-grid-2">
            <NumberField
              label={`${t('customers:amount_received')} · ${t('glossary:iqd')}`}
              unit={t('common:iqd_symbol')}
              value={splitIqd}
              onChange={(event) => setSplitIqd(event.target.value)}
            />
            <NumberField
              label={`${t('customers:amount_received')} · ${t('glossary:usd')}`}
              unit={t('common:usd_symbol')}
              decimals={2}
              value={splitUsd}
              onChange={(event) => setSplitUsd(event.target.value)}
            />
          </div>
        )}

        {/* Proposed — not requested (FR-617): part dinars, part dollars, one note. */}
        <Button variant="ghost" onClick={() => setSplitting(!splitting)}>
          {splitting ? t('customers:split_off') : t('customers:split_on')}
        </Button>

        <DateField
          label={t('glossary:date_paid')}
          value={date}
          max={formatter.today()}
          onChange={(event) => setDate(event.target.value)}
        />

        {/* Proposed — not requested (FR-617). */}
        <SegmentedControl
          label={t('customers:method')}
          value={method}
          onChange={setMethod}
          options={[
            { value: 'cash', label: t('customers:method_cash') },
            { value: 'transfer', label: t('customers:method_transfer') },
            { value: 'other', label: t('customers:method_other') },
          ]}
        />

        <TextField label={t('common:note')} value={note} onChange={(event) => setNote(event.target.value)} />

        {purchases && purchases.length > 0 ? (
          <>
            <Button variant="ghost" onClick={() => setShowMore(!showMore)} aria-expanded={showMore}>
              {t('common:more')}
            </Button>
            {showMore ? (
              <label className="mz-field">
                <span className="mz-field__label">{t('companies:link_purchase')}</span>
                <select
                  className="mz-field__control"
                  value={purchaseId}
                  onChange={(event) => setPurchaseId(event.target.value)}
                >
                  <option value="">{t('companies:no_link')}</option>
                  {purchases.map((purchase) => (
                    <option key={purchase.id} value={purchase.id}>
                      {purchase.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </>
        ) : null}

        {/* The balance this payment leaves behind, live as the amount is typed (3.4.2). */}
        <div className="mz-row mz-row--between">
          <span className="mz-caption">{t('customers:after_payment')}</span>
          <SettlementAmount amount={afterPayment} currency={settlement_currency} rate={rate} />
        </div>

        {needsExcessConfirmation ? (
          <div className="mz-warning" role="alert">
            {t('customers:excess_warning', {
              remaining: formatter.money(remaining, settlement_currency),
            })}
          </div>
        ) : null}

        <Button
          block
          loading={saving}
          disabled={!canSave}
          onClick={() =>
            onSave({
              amount: splitting ? 0 : (amount.amount as number),
              currency: splitting ? settlement_currency : amount.currency,
              other_amount: splitting ? null : (amount.other_amount ?? null),
              entry_date: date,
              settle_in_full: splitting ? false : settleInFull,
              allow_excess: needsExcessConfirmation ? true : undefined,
              method,
              split: splitting ? splitParts() : null,
              note: note.trim() === '' ? null : note.trim(),
              purchase_id: purchaseId === '' ? null : purchaseId,
            })
          }
        >
          {needsExcessConfirmation
            ? t('customers:record_excess')
            : (saveLabel ?? t('customers:record_payment'))}
        </Button>

        <span className="mz-caption">
          {remainingHint ??
            t('customers:remaining_hint', { amount: formatter.money(remaining, settlement_currency) })}
        </span>
      </div>
    </BottomSheet>
  );
}

/**
 * A figure held in the settlement currency, with its counterpart converted at the account's
 * rate and marked ≈ as derived. Without a rate there is no counterpart to show, and the figure
 * says so rather than converting at a rate nobody set.
 */
function SettlementAmount({ amount, currency, rate }: { amount: number; currency: Currency; rate: Rate | null }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  if (rate === null) {
    return (
      <span className="mz-stack" style={{ gap: 0, alignItems: 'flex-end' }}>
        <bdi data-tabular>{formatter.money(amount, currency)}</bdi>
        <span className="mz-caption">{t('common:no_rate_set')}</span>
      </span>
    );
  }
  return <DualAmount {...bothOf(amount, currency, rate)} primary={currency} kind="derived" />;
}

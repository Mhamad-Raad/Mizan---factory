import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BottomSheet, Button, DateField, SegmentedControl, TextField, Toggle } from '@mizan/ui';
import { convert } from '@mizan/money';
import type { Currency, Rate } from '@mizan/money';
import { MoneyInput, centsToInput, parseMinor } from './MoneyInput.js';
import type { MoneyValue } from './MoneyInput.js';
import { DualAmount } from './DualAmount.js';
import { useFormatter } from '../lib/store.js';

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
  rate: Rate;
  saving?: boolean;
  error?: string;
  /** Set when the API asked for a confirmation ("record the excess as customer credit"). */
  needsExcessConfirmation?: boolean;
  onSave: (body: PaymentBody) => void;
  title?: string;
  /** Money out is worded differently from money in; the company side passes its own labels. */
  amountLabel?: string;
  remainingLabel?: string;
  saveLabel?: string;
  remainingHint?: string;
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
  title,
  amountLabel,
  remainingLabel,
  saveLabel,
  remainingHint,
  purchases,
}: PaymentSheetProps) {
  const { t } = useTranslation();
  const formatter = useFormatter();

  const [amount, setAmount] = useState<MoneyValue>({
    amount: remaining,
    currency: settlement_currency,
    other_amount: null,
  });
  const [date, setDate] = useState(formatter.today());
  const [settleInFull, setSettleInFull] = useState(false);
  const [method, setMethod] = useState<'cash' | 'transfer' | 'other'>('cash');
  const [note, setNote] = useState('');
  const [splitting, setSplitting] = useState(false);
  const [splitIqd, setSplitIqd] = useState('');
  const [splitUsd, setSplitUsd] = useState('');
  const [showMore, setShowMore] = useState(false);
  const [purchaseId, setPurchaseId] = useState('');

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
  const paidInSettlement = splitting
    ? splitParts().reduce(
        (total, part) =>
          total + (part.currency === settlement_currency ? part.amount : convert(part.amount, part.currency, rate)),
        0,
      )
    : amount.amount === null
      ? 0
      : amount.currency === settlement_currency
        ? amount.amount
        : (amount.other_amount ?? convert(amount.amount, amount.currency, rate));
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
          <DualAmount
            amount_iqd={settlement_currency === 'IQD' ? remaining : convert(remaining, 'USD', rate)}
            amount_usd_cents={settlement_currency === 'USD' ? remaining : convert(remaining, 'IQD', rate)}
            primary={settlement_currency}
            kind="derived"
          />
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
              hint={t('customers:settle_in_full_hint')}
              checked={settleInFull}
              onChange={setSettleInFull}
            />
          </>
        ) : (
          <div className="mz-grid-2">
            <TextField
              label={`${t('customers:amount_received')} · ${t('glossary:iqd')}`}
              inputMode="numeric"
              value={splitIqd}
              onChange={(event) => setSplitIqd(event.target.value)}
            />
            <TextField
              label={`${t('customers:amount_received')} · ${t('glossary:usd')}`}
              inputMode="decimal"
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
          <DualAmount
            amount_iqd={settlement_currency === 'IQD' ? afterPayment : convert(afterPayment, 'USD', rate)}
            amount_usd_cents={settlement_currency === 'USD' ? afterPayment : convert(afterPayment, 'IQD', rate)}
            primary={settlement_currency}
            kind="derived"
          />
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
            t('customers:remaining_hint', {
            amount:
              settlement_currency === 'USD'
                  ? `$${centsToInput(remaining)}`
                  : formatter.money(remaining, settlement_currency),
            })}
        </span>
      </div>
    </BottomSheet>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BottomSheet, Button, DateField, SegmentedControl, TextField, Toggle } from '@mizan/ui';
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

  const splitParts = () => {
    const parts: { amount: number; currency: Currency }[] = [];
    const iqd = parseMinor(splitIqd, 'IQD');
    const usd = parseMinor(splitUsd, 'USD');
    if (iqd) parts.push({ amount: iqd, currency: 'IQD' });
    if (usd) parts.push({ amount: usd, currency: 'USD' });
    return parts;
  };

  const canSave = splitting ? splitParts().length >= 2 : amount.amount !== null && amount.amount > 0;

  return (
    <BottomSheet
      title={title ?? t('customers:record_payment')}
      open={open}
      onClose={onClose}
      closeLabel={t('common:close')}
    >
      <div className="mz-stack">
        <div className="mz-row mz-row--between">
          <span>{t('orders:remaining')}</span>
          <DualAmount
            amount_iqd={settlement_currency === 'IQD' ? remaining : 0}
            amount_usd_cents={settlement_currency === 'USD' ? remaining : 0}
            primary={settlement_currency}
          />
        </div>

        {!splitting ? (
          <>
            <MoneyInput
              label={t('customers:amount_received')}
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
            })
          }
        >
          {needsExcessConfirmation ? t('customers:record_excess') : t('customers:record_payment')}
        </Button>

        <span className="mz-caption">
          {t('customers:remaining_hint', {
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

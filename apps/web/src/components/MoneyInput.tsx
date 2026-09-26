import { useTranslation } from 'react-i18next';
import { NumberField } from '@mizan/ui';
import { convert, impliedRate } from '@mizan/money';
import type { Currency, Rate } from '@mizan/money';
import { useFormatter } from '../lib/store.js';

/** What a money field holds: the side the user typed, and the other side if they overwrote it. */
export interface MoneyValue {
  amount: number | null;
  currency: Currency;
  /** Set only when the calculated side was overwritten by hand (spec 2.3.2 step 2). */
  other_amount?: number | null;
}

export interface MoneyInputProps {
  label: string;
  value: MoneyValue;
  /** The rate that fills the calculated side — the order's rate, or today's global rate. */
  rate: Rate;
  onChange: (value: MoneyValue) => void;
  hint?: string;
  error?: string;
  disabled?: boolean;
  /**
   * On by default: typing one currency fills the other at the rate. Off: the two sides are
   * independent — each is only ever what the user typed, and neither moves the other.
   */
  autoConvert?: boolean;
  /** A short, translated name for the rate in force ("the system rate", "the customer's rate"). */
  sourceLabel?: string;
}

/**
 * Type one currency, see the other (spec 2.3.2, component `MoneyInput` of 2.10.11).
 *
 * The side the employee types is authoritative and is the one sent to the API; the other side
 * is calculated here **for display only** — the server recomputes every stored value — and
 * becomes a stored fact with a manual rate if they overwrite it. Amounts are integers in minor
 * units the whole way: dinars have no decimals, dollars are entered as dollars and cents and
 * held as cents.
 */
export function MoneyInput({
  label,
  value,
  rate,
  onChange,
  hint,
  error,
  disabled,
  autoConvert,
  sourceLabel,
}: MoneyInputProps) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const auto = autoConvert !== false;

  const entered = value.amount;
  const overridden = value.other_amount !== undefined && value.other_amount !== null;

  // Which side holds each currency. In auto mode the side that was NOT typed shows the conversion
  // of the one that was; off, each side shows only what the user typed.
  const enteredIqd = value.currency === 'IQD';
  const typedThis = entered;
  const otherAuto = entered === null ? null : convert(entered, value.currency, rate);
  const iqd = enteredIqd ? typedThis : auto ? otherAuto : (value.other_amount ?? null);
  const usd = enteredIqd ? (auto ? otherAuto : (value.other_amount ?? null)) : typedThis;

  /** Auto: whichever side you type becomes the entered one and the other is converted at the rate. */
  const setAuto = (side: Currency, minor: number | null) =>
    onChange({ amount: minor, currency: side, other_amount: null });

  /**
   * Off: the two sides are independent. The first side typed is the primary (`amount`); the other
   * is stored as `other_amount`, so both are user-entered and neither is a conversion of the other.
   */
  const setManual = (side: Currency, minor: number | null) => {
    if (value.currency === side || value.amount === null) {
      onChange({ amount: minor, currency: side, other_amount: value.other_amount ?? null });
    } else {
      onChange({ ...value, other_amount: minor });
    }
  };

  const setSide = (side: Currency, minor: number | null) =>
    auto ? setAuto(side, minor) : setManual(side, minor);

  const note = !auto
    ? overridden && iqd !== null && usd !== null && usd !== 0
      ? t('common:manual_rate', { rate: formatter.rate(impliedRate(iqd, usd)) })
      : (hint ?? t('common:entered_separately'))
    : (hint ??
      (sourceLabel
        ? t('common:rate_at_source', { source: sourceLabel, rate: formatter.rate(rate) })
        : t('common:rate_used', { rate: formatter.rate(rate) })));

  return (
    <div className="mz-stack" style={{ gap: 'var(--space-2)' }}>
      {label ? <span className="mz-field__label">{label}</span> : null}
      <div className="mz-grid-2">
        <NumberField
          label={t('glossary:iqd')}
          unit={t('common:iqd_symbol')}
          value={iqd === null ? '' : String(iqd)}
          disabled={disabled}
          error={error}
          onChange={(event) => setSide('IQD', parseMinor(event.target.value, 'IQD'))}
        />
        <NumberField
          label={t('glossary:usd')}
          unit={t('common:usd_symbol')}
          decimals={2}
          value={usd === null ? '' : centsToInput(usd)}
          disabled={disabled}
          onChange={(event) => setSide('USD', parseMinor(event.target.value, 'USD'))}
        />
      </div>
      <span className="mz-field__hint">{note}</span>
    </div>
  );
}

/** Dinars are whole; dollars are typed as dollars and stored as cents (spec 2.3.1). */
export function parseMinor(text: string, currency: Currency): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed.replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  return currency === 'IQD' ? Math.round(value) : Math.round(value * 100);
}

export function centsToInput(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

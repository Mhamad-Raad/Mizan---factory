import { useState } from 'react';
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
  /**
   * The rate that fills the calculated side — the order's rate, or today's global rate. `null`
   * when no rate has been set: the other side is then left for the user, never invented.
   */
  rate: Rate | null;
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
  const otherAuto = entered === null || rate === null ? null : convert(entered, value.currency, rate);
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
    : rate === null
      ? (hint ?? t('common:no_rate_set'))
      : (hint ??
        (sourceLabel
          ? t('common:rate_at_source', { source: sourceLabel, rate: formatter.rate(rate) })
          : t('common:rate_used', { rate: formatter.rate(rate) })));

  return (
    <div className="mz-stack" style={{ gap: 'var(--space-2)' }}>
      {label ? <span className="mz-field__label">{label}</span> : null}
      <div className="mz-grid-2">
        <MoneySide
          label={t('glossary:iqd')}
          unit={t('common:iqd_symbol')}
          currency="IQD"
          minor={iqd}
          disabled={disabled}
          error={error}
          onChange={(minor) => setSide('IQD', minor)}
        />
        <MoneySide
          label={t('glossary:usd')}
          unit={t('common:usd_symbol')}
          currency="USD"
          minor={usd}
          disabled={disabled}
          onChange={(minor) => setSide('USD', minor)}
        />
      </div>
      <span className="mz-field__hint">{note}</span>
    </div>
  );
}

/**
 * One side of the pair. While somebody is typing in it, it shows **what they typed** — "12.",
 * "12.5", a lone "-" — and only reports the amount that text means; rebuilding the text from the
 * amount on every keystroke turned "1" into "1.00" and made a dollar amount impossible to type.
 * The typed text gives way to the amount when the amount changes from outside (the other side
 * was typed, a draft was restored) and when the field is left.
 */
function MoneySide({
  label,
  unit,
  currency,
  minor,
  disabled,
  error,
  onChange,
}: {
  label: string;
  unit: string;
  currency: Currency;
  minor: number | null;
  disabled?: boolean;
  error?: string;
  onChange: (minor: number | null) => void;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const shown = typed !== null && parseMinor(typed, currency) === minor ? typed : toInput(minor, currency);
  return (
    <NumberField
      label={label}
      unit={unit}
      decimals={currency === 'USD' ? 2 : 0}
      value={shown}
      disabled={disabled}
      error={error}
      onChange={(event) => {
        setTyped(event.target.value);
        onChange(parseMinor(event.target.value, currency));
      }}
      onBlur={() => setTyped(null)}
    />
  );
}

function toInput(minor: number | null, currency: Currency): string {
  if (minor === null) return '';
  return currency === 'USD' ? centsToInput(minor) : String(minor);
}

const EASTERN_DIGITS = /[٠-٩۰-۹]/g;

/**
 * Dinars are whole; dollars are typed as dollars and stored as cents (spec 2.3.1).
 *
 * The text is read as a decimal string — whole part and fraction apart — never through a
 * floating-point number, so "0.29" is 29 cents and not 28.999…. Anything that is not a plain
 * amount in that currency (a dinar fraction, a third decimal of a dollar, a lone "-") is `null`,
 * which the form treats as "not an amount yet".
 */
export function parseMinor(text: string, currency: Currency): number | null {
  const cleaned = text
    .trim()
    .replace(EASTERN_DIGITS, (digit) => {
      const code = digit.codePointAt(0) as number;
      return String(code - (code >= 0x06f0 ? 0x06f0 : 0x0660));
    })
    .replace(/[,٬\s]/g, '')
    .replace(/٫/g, '.');
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!match) return null;
  const [, sign, whole = '', fraction = ''] = match;
  if (whole === '' && fraction === '') return null;
  const places = currency === 'IQD' ? 0 : 2;
  if (fraction.length > places) return null;
  const digits = `${whole}${fraction.padEnd(places, '0')}`;
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) return null;
  return sign === '-' && value !== 0 ? -value : value;
}

export function centsToInput(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

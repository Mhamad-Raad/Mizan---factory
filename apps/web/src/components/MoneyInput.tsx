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
export function MoneyInput({ label, value, rate, onChange, hint, error, disabled }: MoneyInputProps) {
  const { t } = useTranslation();
  const formatter = useFormatter();

  const entered = value.amount;
  const overridden = value.other_amount !== undefined && value.other_amount !== null;
  const calculated =
    entered === null ? null : overridden ? (value.other_amount as number) : convert(entered, value.currency, rate);

  const iqd = value.currency === 'IQD' ? entered : calculated;
  const usd = value.currency === 'IQD' ? calculated : entered;

  const setSide = (currency: Currency, minor: number | null) => {
    // Typing in a side makes it the entered one and drops any override, because the pair is
    // now "this amount, converted" again.
    onChange({ amount: minor, currency, other_amount: null });
  };

  const overrideSide = (minor: number | null) => {
    onChange({ ...value, other_amount: minor });
  };

  return (
    <div className="mz-stack" style={{ gap: 'var(--space-2)' }}>
      <div className="mz-grid-2">
        <NumberField
          label={`${label} · ${t('glossary:iqd')}`}
          unit={t('common:iqd_symbol')}
          value={iqd === null ? '' : String(iqd)}
          disabled={disabled}
          error={error}
          onChange={(event) => {
            const minor = parseMinor(event.target.value, 'IQD');
            if (value.currency === 'IQD') setSide('IQD', minor);
            else overrideSide(minor);
          }}
        />
        <NumberField
          label={`${label} · ${t('glossary:usd')}`}
          unit={t('common:usd_symbol')}
          decimals={2}
          value={usd === null ? '' : centsToInput(usd)}
          disabled={disabled}
          onChange={(event) => {
            const minor = parseMinor(event.target.value, 'USD');
            if (value.currency === 'USD') setSide('USD', minor);
            else overrideSide(minor);
          }}
        />
      </div>
      <span className="mz-field__hint">
        {overridden && iqd !== null && usd !== null && usd !== 0
          ? t('common:manual_rate', { rate: formatter.rate(impliedRate(iqd, usd)) })
          : (hint ?? t('common:rate_used', { rate: formatter.rate(rate) }))}
      </span>
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

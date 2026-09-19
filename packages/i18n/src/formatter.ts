import type { Currency } from '@mizan/money';
import { numeralsFor } from './digits.js';
import type { Numerals } from './digits.js';
import { formatBusinessDate, formatMonth, formatTimestamp, todayInBaghdad, weekdayOrder } from './dates.js';
import type { WeekStart } from './dates.js';
import { APPROX, formatMinorUnits, formatMoney, formatNumber, formatRate } from './numbers.js';
import { directionOf } from './locales.js';
import type { Direction, Locale } from './locales.js';
import { pluralCategory } from './plural.js';
import type { PluralCategory } from './plural.js';

export interface FormatterOptions {
  locale: Locale;
  numerals: Numerals;
  weekStart?: WeekStart;
}

export interface DualAmountInput {
  amount_iqd: number;
  amount_usd_cents: number;
  /** The currency shown first: the counterparty's settlement currency, or the entered one. */
  primary_currency: Currency;
  /**
   * `stored` — both sides are recorded facts, no marker.
   * `derived` — the secondary side was converted at a current rate, so it carries "≈"
   * (spec 2.3.6, FR-1302).
   */
  kind?: 'stored' | 'derived';
}

export interface DualAmountParts {
  primary: string;
  secondary: string;
  /** True when the secondary figure is a conversion, not a stored value. */
  approximate: boolean;
}

/**
 * One formatting service per language (spec 2.10.4). Every screen and every report goes
 * through it; no component calls `Intl` (an ESLint rule enforces that outside this package).
 */
export interface Formatter {
  readonly locale: Locale;
  readonly numerals: Numerals;
  readonly direction: Direction;
  number(value: number | string, decimals?: number): string;
  money(minor: number, currency: Currency): string;
  minorUnits(minor: number, currency: Currency): string;
  rate(rate: string): string;
  date(isoDate: string): string;
  timestamp(instant: Date): string;
  month(isoMonth: string): string;
  weekdays(): readonly string[];
  today(): string;
  plural(count: number): PluralCategory;
  dualAmount(input: DualAmountInput): DualAmountParts;
}

export function createFormatter(options: FormatterOptions): Formatter {
  const { locale } = options;
  const numerals = numeralsFor(locale, options.numerals);
  const weekStart: WeekStart = options.weekStart ?? 'sat';

  return {
    locale,
    numerals,
    direction: directionOf(locale),
    number: (value, decimals = 0) => formatNumber(value, numerals, decimals),
    money: (minor, currency) => formatMoney(minor, currency, locale, numerals),
    minorUnits: (minor, currency) => formatMinorUnits(minor, currency === 'IQD' ? 0 : 2, numerals),
    rate: (rate) => formatRate(rate, locale, numerals),
    date: (isoDate) => formatBusinessDate(isoDate, numerals),
    timestamp: (instant) => formatTimestamp(instant, numerals),
    month: (isoMonth) => formatMonth(isoMonth, locale, numerals),
    weekdays: () => weekdayOrder(weekStart, locale),
    today: () => todayInBaghdad(),
    plural: (count) => pluralCategory(count, locale),
    dualAmount: (input) => {
      const secondaryCurrency: Currency = input.primary_currency === 'IQD' ? 'USD' : 'IQD';
      const primaryMinor = input.primary_currency === 'IQD' ? input.amount_iqd : input.amount_usd_cents;
      const secondaryMinor = secondaryCurrency === 'IQD' ? input.amount_iqd : input.amount_usd_cents;
      const approximate = input.kind === 'derived';
      const secondary = formatMoney(secondaryMinor, secondaryCurrency, locale, numerals);
      return {
        primary: formatMoney(primaryMinor, input.primary_currency, locale, numerals),
        secondary: approximate ? `${APPROX}\u00A0${secondary}` : secondary,
        approximate,
      };
    },
  };
}

import { describe, expect, it } from 'vitest';
import {
  DIRECTION,
  LOCALES,
  createFormatter,
  dirFactor,
  formatMinorUnits,
  formatMoney,
  monthName,
  normalizeDigitsToAscii,
  numeralsFor,
  pluralCategory,
  shapeDigits,
  todayInBaghdad,
  weekdayOrder,
} from './index.js';
import type { Locale } from './index.js';

describe('locales and direction (FR-1202, spec 2.10.6)', () => {
  it('has three first-class languages with Kurdish RTL first', () => {
    expect(LOCALES).toEqual(['ckb-IQ', 'ar-IQ', 'en']);
    expect(DIRECTION).toEqual({ 'ckb-IQ': 'rtl', 'ar-IQ': 'rtl', en: 'ltr' });
  });

  it('exposes --dir so animations and gestures follow the reading direction', () => {
    expect(dirFactor('ckb-IQ')).toBe(1);
    expect(dirFactor('ar-IQ')).toBe(1);
    expect(dirFactor('en')).toBe(-1);
  });
});

describe('numerals (FR-1105, spec 3.7.4)', () => {
  it('uses Persian/Kurdish shapes for ckb and Arabic-Indic for ar — they differ', () => {
    expect(shapeDigits('456', 'arabext')).toBe('۴۵۶');
    expect(shapeDigits('456', 'arab')).toBe('٤٥٦');
    expect(shapeDigits('456', 'arabext')).not.toBe(shapeDigits('456', 'arab'));
  });

  it('English always shows Western digits whatever the preference', () => {
    expect(numeralsFor('en', 'arab')).toBe('latn');
    expect(numeralsFor('ckb-IQ', 'arab')).toBe('arabext');
    expect(numeralsFor('ar-IQ', 'arab')).toBe('arab');
    expect(numeralsFor('ckb-IQ', 'latn')).toBe('latn');
  });

  it('accepts either digit set on input and normalises to ASCII', () => {
    expect(normalizeDigitsToAscii('١٢٣٤٥')).toBe('12345');
    expect(normalizeDigitsToAscii('۱۲۳٫۵')).toBe('123.5');
    expect(normalizeDigitsToAscii('12,500')).toBe('12,500');
  });
});

describe('money formatting — the table in spec 2.10.4/2.10.5', () => {
  it('IQD has no decimals, USD has two', () => {
    expect(formatMinorUnits(1_250_000, 0, 'latn')).toBe('1,250,000');
    expect(formatMinorUnits(95_350, 2, 'latn')).toBe('953.50');
  });

  it('places the symbol after the number in RTL and before it in English', () => {
    expect(formatMoney(1_250_000, 'IQD', 'ar-IQ', 'latn')).toBe('1,250,000 د.ع');
    expect(formatMoney(1_250_000, 'IQD', 'ckb-IQ', 'latn')).toBe('1,250,000 د.ع');
    expect(formatMoney(1_250_000, 'IQD', 'en', 'latn')).toBe('IQD 1,250,000');
    expect(formatMoney(95_350, 'USD', 'ar-IQ', 'latn')).toBe('953.50 $');
    expect(formatMoney(95_350, 'USD', 'en', 'latn')).toBe('$ 953.50');
  });

  it('renders Eastern digits with the Arabic separators', () => {
    expect(formatMoney(1_250_050, 'USD', 'ar-IQ', 'arab')).toBe('١٢٬٥٠٠٫٥٠ $');
    expect(formatMoney(1_250_000, 'IQD', 'ckb-IQ', 'arabext')).toBe('۱٬۲۵۰٬۰۰۰ د.ع');
  });

  it('uses a leading minus sign, never parentheses (spec 2.10.5)', () => {
    expect(formatMoney(-500_000, 'IQD', 'ar-IQ', 'latn')).toBe('−500,000 د.ع');
    expect(formatMoney(-500_000, 'IQD', 'ar-IQ', 'latn')).not.toContain('(');
  });

  it('never loses a fil: zero and single-unit amounts render exactly', () => {
    expect(formatMinorUnits(0, 2, 'latn')).toBe('0.00');
    expect(formatMinorUnits(5, 2, 'latn')).toBe('0.05');
    expect(formatMinorUnits(-5, 2, 'latn')).toBe('−0.05');
  });
});

describe('dual amounts (FR-1302, spec 2.3.6)', () => {
  const formatter = createFormatter({ locale: 'ckb-IQ', numerals: 'latn' });

  it('shows a stored pair with no marker — both sides are facts', () => {
    const parts = formatter.dualAmount({
      amount_iqd: 801_250,
      amount_usd_cents: 61_164,
      primary_currency: 'IQD',
      kind: 'stored',
    });
    expect(parts.primary).toBe('801,250 د.ع');
    expect(parts.secondary).toBe('611.64 $');
    expect(parts.approximate).toBe(false);
  });

  it('marks a converted balance with ≈', () => {
    const parts = formatter.dualAmount({
      amount_iqd: 4_500_000,
      amount_usd_cents: 343_511,
      primary_currency: 'IQD',
      kind: 'derived',
    });
    expect(parts.secondary.startsWith('≈')).toBe(true);
    expect(parts.approximate).toBe(true);
  });

  it('puts the settlement currency first for a USD-settled counterparty', () => {
    const parts = formatter.dualAmount({
      amount_iqd: 4_500_000,
      amount_usd_cents: 343_511,
      primary_currency: 'USD',
    });
    expect(parts.primary).toBe('3,435.11 $');
    expect(parts.secondary).toBe('4,500,000 د.ع');
  });
});

describe('dates and months (FR-1108, FR-1011, spec 2.10.4)', () => {
  it('uses the Iraqi Arabic month names, not the ones Intl returns', () => {
    expect(monthName(1, 'ar-IQ')).toBe('كانون الثاني');
    expect(monthName(9, 'ar-IQ')).toBe('أيلول');
    expect(monthName(1, 'ar-IQ')).not.toBe('يناير');
  });

  it('has Kurdish month names, which Intl does not provide at all', () => {
    expect(monthName(9, 'ckb-IQ')).toBe('ئەیلوول');
    expect(monthName(12, 'ckb-IQ')).toBe('کانوونی یەکەم');
  });

  it('starts the week on Saturday in every language', () => {
    expect(weekdayOrder('sat', 'ar-IQ')[0]).toBe('السبت');
    expect(weekdayOrder('sat', 'ckb-IQ')[0]).toBe('شەممە');
    expect(weekdayOrder('sat', 'en')[0]).toBe('Saturday');
    expect(weekdayOrder('mon', 'en')[0]).toBe('Monday');
  });

  it('renders business dates dd/MM/yyyy and shapes the digits', () => {
    const ckb = createFormatter({ locale: 'ckb-IQ', numerals: 'arabext' });
    expect(createFormatter({ locale: 'en', numerals: 'latn' }).date('2026-09-18')).toBe('18/09/2026');
    expect(ckb.date('2026-09-18')).toBe('۱۸/۰۹/۲۰۲۶');
  });

  it('computes "today" in Asia/Baghdad, not in the server time zone', () => {
    // 2026-09-18 22:30 UTC is already the 19th in Baghdad (UTC+3).
    expect(todayInBaghdad(new Date('2026-09-18T22:30:00Z'))).toBe('2026-09-19');
    expect(todayInBaghdad(new Date('2026-09-18T20:00:00Z'))).toBe('2026-09-18');
  });

  it('formats a month header in the interface language', () => {
    expect(createFormatter({ locale: 'ar-IQ', numerals: 'latn' }).month('2026-09')).toBe('أيلول 2026');
  });
});

describe('plural rules (spec 2.10.3)', () => {
  it('uses our own rule for Kurdish, because Intl silently falls back for ckb', () => {
    expect(pluralCategory(1, 'ckb-IQ')).toBe('one');
    expect(pluralCategory(0, 'ckb-IQ')).toBe('other');
    expect(pluralCategory(11, 'ckb-IQ')).toBe('other');
  });

  it('uses the full CLDR set for Arabic', () => {
    expect(pluralCategory(0, 'ar-IQ')).toBe('zero');
    expect(pluralCategory(1, 'ar-IQ')).toBe('one');
    expect(pluralCategory(2, 'ar-IQ')).toBe('two');
    expect(pluralCategory(3, 'ar-IQ')).toBe('few');
    expect(pluralCategory(11, 'ar-IQ')).toBe('many');
  });

  it('uses one/other for English', () => {
    expect(pluralCategory(1, 'en')).toBe('one');
    expect(pluralCategory(2, 'en')).toBe('other');
  });
});

describe('the formatting service covers every locale', () => {
  it.each(LOCALES)('formats money, dates and rates in %s without throwing', (locale: Locale) => {
    const formatter = createFormatter({ locale, numerals: 'arab' });
    expect(formatter.money(801_250, 'IQD')).toBeTruthy();
    expect(formatter.date('2026-09-18')).toBeTruthy();
    expect(formatter.rate('1310.0000')).toContain('=');
    expect(formatter.weekdays()).toHaveLength(7);
    expect(formatter.timestamp(new Date('2026-09-18T11:02:00Z'))).toBeTruthy();
  });
});

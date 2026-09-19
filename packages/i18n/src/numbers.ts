import type { Currency } from '@mizan/money';
import { separatorsFor, shapeDigits } from './digits.js';
import type { Numerals } from './digits.js';
import type { Locale } from './locales.js';

/** Display minus is U+2212, never a hyphen and never parentheses (spec 2.10.5). */
const MINUS = '−';
/** Thin space between a number and its currency symbol (spec 2.10.5). */
const THIN_SPACE = ' ';

export const CURRENCY_DECIMALS: Readonly<Record<Currency, number>> = { IQD: 0, USD: 2 };

export const CURRENCY_SYMBOLS: Readonly<Record<Locale, Record<Currency, string>>> = {
  'ckb-IQ': { IQD: 'د.ع', USD: '$' },
  'ar-IQ': { IQD: 'د.ع', USD: '$' },
  en: { IQD: 'IQD', USD: '$' },
};

function groupInteger(digits: string, group: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, group);
}

/**
 * Formats an integer amount in minor units. The amount never becomes a float on the way:
 * the integer is turned into a string and the decimal point is inserted by slicing.
 */
export function formatMinorUnits(minor: number, decimals: number, numerals: Numerals): string {
  const { group, decimal } = separatorsFor(numerals);
  const negative = minor < 0;
  const raw = Math.abs(minor).toString().padStart(decimals + 1, '0');
  const whole = decimals === 0 ? raw : raw.slice(0, raw.length - decimals);
  const fraction = decimals === 0 ? '' : raw.slice(raw.length - decimals);
  const body = groupInteger(whole, group) + (fraction ? decimal + fraction : '');
  return (negative ? MINUS : '') + shapeDigits(body, numerals);
}

/** A plain number (quantities, counts). `decimals` is the exact scale to render. */
export function formatNumber(value: number | string, numerals: Numerals, decimals = 0): string {
  const text = typeof value === 'number' ? value.toFixed(decimals) : value;
  const negative = text.trimStart().startsWith('-');
  const [whole = '0', fraction] = text.replace('-', '').split('.');
  const { group, decimal } = separatorsFor(numerals);
  const body = groupInteger(whole, group) + (fraction ? decimal + fraction : '');
  return (negative ? MINUS : '') + shapeDigits(body, numerals);
}

/**
 * Currency placement per locale (spec 2.10.4/2.10.5): in RTL the symbol follows the number
 * after a thin space, in English the code or `$` precedes it.
 */
export function formatMoney(
  minor: number,
  currency: Currency,
  locale: Locale,
  numerals: Numerals,
): string {
  const number = formatMinorUnits(minor, CURRENCY_DECIMALS[currency], numerals);
  const symbol = CURRENCY_SYMBOLS[locale][currency];
  return locale === 'en' ? `${symbol}${THIN_SPACE}${number}` : `${number}${THIN_SPACE}${symbol}`;
}

/** Rates read "1 $ = 1,310 د.ع" and are never shown as a bare number (glossary row 54). */
export function formatRate(rate: string, locale: Locale, numerals: Numerals): string {
  const trimmed = rate.replace(/\.?0+$/, '');
  return `${shapeDigits('1', numerals)}${THIN_SPACE}${CURRENCY_SYMBOLS[locale].USD} = ${formatNumber(
    trimmed,
    numerals,
  )}${THIN_SPACE}${CURRENCY_SYMBOLS[locale].IQD}`;
}

export const APPROX = '≈';

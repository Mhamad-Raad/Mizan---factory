import { convert } from '@mizan/money';
import type { Currency, Rate } from '@mizan/money';
import type { MoneyValue } from '../components/MoneyInput.js';

/**
 * A figure held in one currency — what is still owed, in the settlement currency — with its
 * counterpart converted at the given rate, for a `DualAmount` marked derived (rule 7).
 */
export function bothOf(
  amount: number,
  currency: Currency,
  rate: Rate,
): { amount_iqd: number; amount_usd_cents: number } {
  return currency === 'IQD'
    ? { amount_iqd: amount, amount_usd_cents: convert(amount, 'IQD', rate) }
    : { amount_iqd: convert(amount, 'USD', rate), amount_usd_cents: amount };
}

/** A typed money value as the API takes it, or null when nothing was typed. */
export function toMoneyBody(
  value: MoneyValue,
): { amount: number; currency: Currency; other_amount: number | null } | null {
  return value.amount === null
    ? null
    : { amount: value.amount, currency: value.currency, other_amount: value.other_amount ?? null };
}

/**
 * A rate as typed, when it is one: digits, up to four decimals (the stored scale), above zero.
 * Anything else — "", "0", ".", "1500." half-way through typing — is null, and the caller keeps
 * the rate it had: the conversion kernel throws on a rate that is not above zero, and a render
 * that throws replaces the whole screen with the error page.
 */
export function usableRate(text: string): Rate | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(trimmed)) return null;
  return Number(trimmed) > 0 ? trimmed : null;
}

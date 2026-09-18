import { assertSafeAmount } from './decimal.js';
import { convert, impliedRate } from './convert.js';
import type { Currency, MoneyPair, Rate, RateSource } from './types.js';

export interface CompletePairInput {
  amount: number;
  currency: Currency;
  rate: Rate;
  rate_source: RateSource;
  /** The calculated side, when the user overwrote it (spec 2.3.2 step 2). */
  other_amount?: number | null;
}

/**
 * Builds the stored pair from the side the user typed. When the calculated side is
 * overwritten the pair becomes self-describing: `rate_source = manual` and the rate
 * is the one the two amounts imply, so nothing later has to guess (spec 2.3.2).
 */
export function completePair(input: CompletePairInput): MoneyPair {
  assertSafeAmount(input.amount, 'amount');
  const overridden = input.other_amount !== undefined && input.other_amount !== null;
  const other = overridden
    ? assertSafeAmount(input.other_amount as number, 'other_amount')
    : convert(input.amount, input.currency, input.rate);

  const amount_iqd = input.currency === 'IQD' ? input.amount : other;
  const amount_usd_cents = input.currency === 'IQD' ? other : input.amount;

  const useImplied = overridden && amount_usd_cents !== 0;
  return {
    amount_iqd,
    amount_usd_cents,
    entered_currency: input.currency,
    rate_iqd_per_usd: useImplied ? impliedRate(amount_iqd, amount_usd_cents) : input.rate,
    rate_source: overridden ? 'manual' : input.rate_source,
  };
}

/** A reversal is the exact negation of the row it reverses, so entry + reversal = 0 (spec 2.4.1 rule 3). */
export function negatePair(pair: MoneyPair): MoneyPair {
  return {
    ...pair,
    amount_iqd: assertSafeAmount(-pair.amount_iqd),
    amount_usd_cents: assertSafeAmount(-pair.amount_usd_cents),
  };
}

/**
 * Totals are sums per currency, never a conversion of the other total (spec 2.3.4).
 * This is the only way document totals and report totals are produced.
 */
export function sumAmounts(amounts: readonly number[]): number {
  return assertSafeAmount(amounts.reduce((total, amount) => total + assertSafeAmount(amount), 0));
}

export function pairIsZero(pair: Pick<MoneyPair, 'amount_iqd' | 'amount_usd_cents'>): boolean {
  return pair.amount_iqd === 0 && pair.amount_usd_cents === 0;
}

export function amountIn(
  pair: Pick<MoneyPair, 'amount_iqd' | 'amount_usd_cents'>,
  currency: Currency,
): number {
  return currency === 'IQD' ? pair.amount_iqd : pair.amount_usd_cents;
}

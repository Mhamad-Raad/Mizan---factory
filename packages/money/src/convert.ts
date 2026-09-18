import { Decimal } from './decimal.js';
import { roundHalfAwayFromZero } from './round.js';
import type { Currency, Rate } from './types.js';

export function parseRate(rate: Rate): Decimal {
  const d = new Decimal(rate);
  if (d.lessThanOrEqualTo(0)) throw new RangeError(`rate must be greater than zero, received ${rate}`);
  return d;
}

/** Rates are stored as `numeric(14,4)`; formatting one keeps the stored form stable. */
export function formatRate(rate: Decimal | string | number): Rate {
  return new Decimal(rate).toFixed(4);
}

/** `usd_cents = round(amount_iqd × 100 / rate)` (spec 2.3.4). */
export function iqdToUsdCents(amountIqd: number, rate: Rate): number {
  return roundHalfAwayFromZero(new Decimal(amountIqd).times(100).dividedBy(parseRate(rate)));
}

/** `amount_iqd = round(usd_cents × rate / 100)` (spec 2.3.4). */
export function usdCentsToIqd(amountUsdCents: number, rate: Rate): number {
  return roundHalfAwayFromZero(new Decimal(amountUsdCents).times(parseRate(rate)).dividedBy(100));
}

export function convert(amount: number, from: Currency, rate: Rate): number {
  return from === 'IQD' ? iqdToUsdCents(amount, rate) : usdCentsToIqd(amount, rate);
}

/**
 * The rate two typed amounts imply, rounded to the stored scale (spec 2.3.2 step 2):
 * `rate = amount_iqd / (amount_usd_cents / 100)`.
 */
export function impliedRate(amountIqd: number, amountUsdCents: number): Rate {
  if (amountUsdCents === 0) throw new RangeError('cannot derive a rate from a zero USD amount');
  return formatRate(new Decimal(amountIqd).dividedBy(new Decimal(amountUsdCents).dividedBy(100)));
}

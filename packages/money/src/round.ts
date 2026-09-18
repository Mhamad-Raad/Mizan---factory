import { Decimal, assertSafeAmount } from './decimal.js';

/**
 * The single rounding rule of the system: half away from zero (spec 2.3.4, A-10).
 * decimal.js ROUND_HALF_UP rounds away from zero on a tie, which is what the
 * specification means — 0.5 → 1 and −0.5 → −1, so `round(x) + round(−x) = 0`.
 */
export function roundHalfAwayFromZero(value: Decimal | string | number): number {
  const rounded = new Decimal(value).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return assertSafeAmount(rounded.toNumber());
}

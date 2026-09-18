import { Decimal } from 'decimal.js';

/**
 * Money arithmetic never runs through JavaScript's binary floating point (rule 1).
 * Every intermediate value is an arbitrary-precision decimal; only the rounded,
 * integer result in minor units leaves this module (spec 2.3.1, 2.3.4).
 */
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -30, toExpPos: 30 });

export { Decimal };

/**
 * The largest amount the system may hold in a minor unit. Amounts are integers;
 * JavaScript integers are exact to 2^53 - 1 = 9.007e15, four orders of magnitude
 * beyond the design point of NFR-13 (decision D-005). Every boundary asserts it.
 */
export const MAX_SAFE_AMOUNT = Number.MAX_SAFE_INTEGER;

export function assertSafeAmount(value: number, what = 'amount'): number {
  if (!Number.isInteger(value)) {
    throw new RangeError(`${what} must be an integer in minor units, received ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${what} exceeds the safe integer range: ${value}`);
  }
  return value;
}

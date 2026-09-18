import { convert } from './convert.js';
import { completePair } from './pair.js';
import type { Currency, MoneyPair, Rate, RateSource } from './types.js';
import { SETTLEMENT_TOLERANCE_DEFAULTS } from './types.js';

export interface Tolerance {
  settle_tolerance_iqd: number;
  settle_tolerance_usd_cents: number;
}

export function toleranceFor(currency: Currency, tolerance: Tolerance = SETTLEMENT_TOLERANCE_DEFAULTS): number {
  return currency === 'IQD' ? tolerance.settle_tolerance_iqd : tolerance.settle_tolerance_usd_cents;
}

export function withinTolerance(
  difference: number,
  currency: Currency,
  tolerance: Tolerance = SETTLEMENT_TOLERANCE_DEFAULTS,
): boolean {
  return Math.abs(difference) <= toleranceFor(currency, tolerance);
}

export interface SettleInFullInput {
  /** What is still owed, in the counterparty's settlement currency. */
  remaining: number;
  settlement_currency: Currency;
  /** The currency physically handed over. */
  received_currency: Currency;
  /** What was physically handed over, in `received_currency`. */
  received_amount: number;
  rate: Rate;
  rate_source: RateSource;
  tolerance?: Tolerance;
}

export type SettleInFullResult =
  | {
      /** Received in the *other* currency: one entry, exact remainder, manual-rate pair. */
      kind: 'manual_rate_pair';
      entry: MoneyPair;
    }
  | {
      /** Received short in the settlement currency: payment as received + residue row. */
      kind: 'payment_with_residue';
      entry: MoneyPair;
      residue: MoneyPair;
    };

/**
 * "Settle in full" (FR-606, FR-705). Two shapes, both bounded by the settlement tolerance:
 *
 * - paid in the other currency → the settlement side is the exact remaining amount and the
 *   other side is what was actually handed over, stored as a manual-rate pair, so the order
 *   or purchase lands on zero with no residue;
 * - paid short in the settlement currency itself → the payment records what was received and
 *   an automatic residue row (a customer credit or a company adjustment) closes the rest, so
 *   the daily cash-up still counts exactly the cash that arrived.
 *
 * A difference larger than the tolerance is not a rate: it is a discount or a credit, and the
 * caller must refuse it (`RECEIVED_AMOUNT_OUT_OF_TOLERANCE`, spec 2.9.2).
 */
export function settleInFull(input: SettleInFullInput): SettleInFullResult {
  const tolerance = input.tolerance ?? SETTLEMENT_TOLERANCE_DEFAULTS;

  if (input.received_currency === input.settlement_currency) {
    const shortfall = input.remaining - input.received_amount;
    if (!withinTolerance(shortfall, input.settlement_currency, tolerance)) {
      throw new RangeError(
        `shortfall ${shortfall} exceeds the settlement tolerance for ${input.settlement_currency}`,
      );
    }
    const entry = completePair({
      amount: -input.received_amount,
      currency: input.settlement_currency,
      rate: input.rate,
      rate_source: input.rate_source,
    });
    const residue = completePair({
      amount: -shortfall,
      currency: input.settlement_currency,
      rate: input.rate,
      rate_source: input.rate_source,
    });
    return { kind: 'payment_with_residue', entry, residue };
  }

  const expected = convert(input.remaining, input.settlement_currency, input.rate);
  const difference = expected - input.received_amount;
  if (!withinTolerance(difference, input.received_currency, tolerance)) {
    throw new RangeError(
      `received ${input.received_amount} differs from ${expected} by more than the tolerance for ${input.received_currency}`,
    );
  }
  const entry = completePair({
    amount: -input.remaining,
    currency: input.settlement_currency,
    rate: input.rate,
    rate_source: input.rate_source,
    other_amount: -input.received_amount,
  });
  return { kind: 'manual_rate_pair', entry };
}

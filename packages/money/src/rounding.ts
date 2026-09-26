import { convert } from './convert.js';
import type { DocumentTotals } from './line.js';
import type { Rate } from './types.js';

/** An order's dinar total rounds up to a multiple of this (client review, D-065). */
export const ORDER_ROUNDING_IQD = 250;

export interface RoundedTotals extends DocumentTotals {
  /** What was added to the dinar total to reach the round figure: 0 when it already was one. */
  rounding_iqd: number;
  /** The same amount in cents, at the order's own rate — so the dollar total moves with it. */
  rounding_usd_cents: number;
}

/**
 * An order's total, rounded **up** to the next 250 dinars: 630 becomes 750, 1,000 stays 1,000,
 * 1,001 becomes 1,250. Only the document's total rounds — a line keeps the price it was sold at.
 *
 * The amount added is kept beside the total in both currencies (rule 1): the dinars exactly, and
 * the dollars as that amount converted at the order's rate, once, by the same `convert` every
 * other derived figure uses. A total of zero or less is left as it is.
 */
export function roundOrderTotals(totals: DocumentTotals, rate: Rate, step = ORDER_ROUNDING_IQD): RoundedTotals {
  if (totals.total_iqd <= 0 || step <= 1) {
    return { ...totals, rounding_iqd: 0, rounding_usd_cents: 0 };
  }
  const remainder = totals.total_iqd % step;
  const rounding_iqd = remainder === 0 ? 0 : step - remainder;
  const rounding_usd_cents = rounding_iqd === 0 ? 0 : convert(rounding_iqd, 'IQD', rate);
  return {
    total_iqd: totals.total_iqd + rounding_iqd,
    total_usd_cents: totals.total_usd_cents + rounding_usd_cents,
    rounding_iqd,
    rounding_usd_cents,
  };
}

import { convert } from './convert.js';
import { Decimal } from './decimal.js';
import { pricedQuantity } from './line.js';
import { roundHalfAwayFromZero } from './round.js';
import type { Currency, Measure, Rate } from './types.js';

/**
 * "Margin vs. month price" (FR-1005, spec 2.11).
 *
 * The margin of an order line is computed **once**, in the currency the price was entered in,
 * and the other currency is that figure converted at the line's own stored rate. Doing it once
 * is the whole point: two independent subtractions of two rounded pairs can disagree in sign —
 * a line can look profitable in dinars and loss-making in dollars — and a report that
 * contradicts itself is worse than no report.
 *
 * The cost is the snapshot **stored on the line** when it was saved (A-42), so a margin already
 * reported cannot move when somebody edits a past month's price. A line whose snapshot is empty
 * (`cost_source = 'none'`) has no margin at all: it is listed separately as "no cost price" and
 * excluded from the sum, rather than counted as pure profit.
 */

export interface MarginLine {
  priced_measure: Measure;
  qty_count: number | null;
  qty_kg: string | null;
  unit_price_iqd: number;
  unit_price_usd_cents: number;
  /** The side the price was typed in; the margin is computed there (2.3.4). */
  price_entered_currency: Currency;
  /** The line's own rate, so the other currency follows the deal and not today's rate. */
  rate_iqd_per_usd: Rate;
  /** The bought-price snapshot; null when the material had no month price at save time. */
  cost_unit_iqd: number | null;
  cost_unit_usd_cents: number | null;
  cost_source: 'month' | 'fallback' | 'none';
}

export interface LineMargin {
  margin_iqd: number;
  margin_usd_cents: number;
  /** True when the cost came from an earlier month, which every row carrying it is flagged with. */
  price_fallback: boolean;
}

export function lineMargin(line: MarginLine): LineMargin | null {
  if (line.cost_source === 'none' || line.cost_unit_iqd === null || line.cost_unit_usd_cents === null) {
    return null;
  }

  const quantity = pricedQuantity(line);
  const entered = line.price_entered_currency;
  const unitPrice = entered === 'IQD' ? line.unit_price_iqd : line.unit_price_usd_cents;
  const unitCost = entered === 'IQD' ? line.cost_unit_iqd : line.cost_unit_usd_cents;

  const marginEntered = roundHalfAwayFromZero(new Decimal(unitPrice).minus(unitCost).times(quantity));
  const marginOther = convert(marginEntered, entered, line.rate_iqd_per_usd);

  return {
    margin_iqd: entered === 'IQD' ? marginEntered : marginOther,
    margin_usd_cents: entered === 'IQD' ? marginOther : marginEntered,
    price_fallback: line.cost_source === 'fallback',
  };
}

export interface MarginTotals {
  margin_iqd: number;
  margin_usd_cents: number;
  /** Lines with no cost snapshot: counted and named, never silently included (FR-1005). */
  lines_without_cost: number;
  /** Lines whose cost came from an earlier month, so the group can be flagged. */
  lines_with_fallback: number;
  lines: number;
}

/** The margin of a group of lines: the sum of margins computed per line, per currency. */
export function marginTotals(lines: readonly MarginLine[]): MarginTotals {
  const totals: MarginTotals = {
    margin_iqd: 0,
    margin_usd_cents: 0,
    lines_without_cost: 0,
    lines_with_fallback: 0,
    lines: 0,
  };

  for (const line of lines) {
    const margin = lineMargin(line);
    totals.lines += 1;
    if (!margin) {
      totals.lines_without_cost += 1;
      continue;
    }
    totals.margin_iqd += margin.margin_iqd;
    totals.margin_usd_cents += margin.margin_usd_cents;
    if (margin.price_fallback) totals.lines_with_fallback += 1;
  }

  return totals;
}

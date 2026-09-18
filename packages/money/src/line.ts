import { Decimal } from './decimal.js';
import { roundHalfAwayFromZero } from './round.js';
import { convert, impliedRate } from './convert.js';
import { sumAmounts } from './pair.js';
import type { Currency, Measure, Quantity, Rate, RateSource } from './types.js';

export interface LineInput extends Quantity {
  /** Snapshot of the item's pricing unit; the measure that drives the price. */
  priced_measure: Measure;
  unit_price_iqd: number;
  unit_price_usd_cents: number;
  price_entered_currency: Currency;
  /** True when the user typed *both* unit prices, which makes each total its own product. */
  both_prices_typed?: boolean;
  /** "Rate for this document" (spec 2.3.3). */
  document_rate: Rate;
  document_rate_source: RateSource;
}

export interface LineTotals {
  line_total_iqd: number;
  line_total_usd_cents: number;
  rate_iqd_per_usd: Rate;
  rate_source: RateSource;
}

/** The exact quantity that drives the price, as a decimal — kg keeps its three decimals. */
export function pricedQuantity(line: Pick<LineInput, 'priced_measure' | 'qty_count' | 'qty_kg'>): Decimal {
  if (line.priced_measure === 'count') {
    if (line.qty_count === null || line.qty_count === undefined) {
      throw new RangeError('a line priced per piece must carry qty_count');
    }
    return new Decimal(line.qty_count);
  }
  if (line.qty_kg === null || line.qty_kg === undefined) {
    throw new RangeError('a line priced per kg must carry qty_kg');
  }
  return new Decimal(line.qty_kg);
}

/**
 * The entered currency of a line is authoritative (spec 2.3.4, A-41).
 *
 * The typed side's total is `unit price × priced measure`, rounded once. The other
 * side is that *total* converted at the document rate — never the rounded other unit
 * price times the quantity, which drifts on large quantities: 850 IQD/kg at 1,310 is
 * 64.89¢, and 65¢ × 5,000 kg would report $3,250 instead of $3,244.27.
 *
 * When the user typed both unit prices, each currency's total is its own product and
 * the line carries the implied rate as `manual`.
 */
export function computeLineTotals(line: LineInput): LineTotals {
  const quantity = pricedQuantity(line);
  const iqdProduct = () => roundHalfAwayFromZero(new Decimal(line.unit_price_iqd).times(quantity));
  const usdProduct = () => roundHalfAwayFromZero(new Decimal(line.unit_price_usd_cents).times(quantity));

  if (line.both_prices_typed) {
    const line_total_iqd = iqdProduct();
    const line_total_usd_cents = usdProduct();
    return {
      line_total_iqd,
      line_total_usd_cents,
      rate_iqd_per_usd:
        line_total_usd_cents === 0 ? line.document_rate : impliedRate(line_total_iqd, line_total_usd_cents),
      rate_source: 'manual',
    };
  }

  if (line.price_entered_currency === 'IQD') {
    const line_total_iqd = iqdProduct();
    return {
      line_total_iqd,
      line_total_usd_cents: convert(line_total_iqd, 'IQD', line.document_rate),
      rate_iqd_per_usd: line.document_rate,
      rate_source: line.document_rate_source,
    };
  }

  const line_total_usd_cents = usdProduct();
  return {
    line_total_iqd: convert(line_total_usd_cents, 'USD', line.document_rate),
    line_total_usd_cents,
    rate_iqd_per_usd: line.document_rate,
    rate_source: line.document_rate_source,
  };
}

/**
 * The unit price of the side the user did not type. Stored rounded and shown with "≈"
 * for information only — it is never multiplied by a quantity (spec 2.3.4).
 */
export function calculatedUnitPrice(
  typed: number,
  typedCurrency: Currency,
  rate: Rate,
): number {
  return convert(typed, typedCurrency, rate);
}

/**
 * Changing "rate for this document" recomputes the calculated side of every line whose
 * `rate_source ≠ manual` — every line where only one unit price was typed, whatever its
 * `price_source` — and leaves lines with two typed prices alone (spec 2.3.3).
 */
export function recomputeLineForDocumentRate<T extends LineInput & LineTotals>(
  line: T,
  newRate: Rate,
  newRateSource: RateSource,
): T {
  if (line.rate_source === 'manual') return line;
  const recomputed = computeLineTotals({ ...line, document_rate: newRate, document_rate_source: newRateSource });
  const calculatedCurrency: Currency = line.price_entered_currency === 'IQD' ? 'USD' : 'IQD';
  const unitPrice = calculatedUnitPrice(
    line.price_entered_currency === 'IQD' ? line.unit_price_iqd : line.unit_price_usd_cents,
    line.price_entered_currency,
    newRate,
  );
  return {
    ...line,
    ...recomputed,
    unit_price_iqd: calculatedCurrency === 'IQD' ? unitPrice : line.unit_price_iqd,
    unit_price_usd_cents: calculatedCurrency === 'USD' ? unitPrice : line.unit_price_usd_cents,
  };
}

export interface DocumentTotals {
  total_iqd: number;
  total_usd_cents: number;
}

/**
 * `total = Σ line totals − discount`, per currency. Never a conversion of the other
 * total: because each line was rounded on its own, the two totals can differ from a
 * direct conversion by a few cents, and that is what the screen says (spec 2.3.4).
 */
export function documentTotals(
  lines: readonly Pick<LineTotals, 'line_total_iqd' | 'line_total_usd_cents'>[],
  discount: { discount_iqd?: number; discount_usd_cents?: number } = {},
): DocumentTotals {
  return {
    total_iqd: sumAmounts(lines.map((l) => l.line_total_iqd)) - (discount.discount_iqd ?? 0),
    total_usd_cents:
      sumAmounts(lines.map((l) => l.line_total_usd_cents)) - (discount.discount_usd_cents ?? 0),
  };
}

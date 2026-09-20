import { convert } from './convert.js';
import type { Currency, Rate } from './types.js';

/**
 * The monthly price list (FR-305, FR-306, FR-609) and the cost snapshot a line keeps for the
 * Profit report (FR-602, A-42). Both are pure functions over price rows so that the API, the
 * reports and the client agree by construction.
 */

export type PriceSide = 'bought' | 'sale';

/** One row of `item_month_prices` as far as this module is concerned (spec 2.2.3). */
export interface MonthPriceRow {
  id: string;
  /** First day of the month, `YYYY-MM-01`. */
  month: string;
  bought_iqd: number | null;
  bought_usd_cents: number | null;
  bought_entered_currency: Currency | null;
  bought_rate: Rate | null;
  sale_iqd: number | null;
  sale_usd_cents: number | null;
  sale_entered_currency: Currency | null;
  sale_rate: Rate | null;
}

/** The stored pair of one side of a price row, or null when that side has no price. */
export interface MonthPriceValue {
  amount_iqd: number;
  amount_usd_cents: number;
  /** The side the user typed; the other was calculated at `rate` when the price was entered. */
  entered_currency: Currency;
  rate: Rate;
}

/**
 * Where a price came from. `month` = the document's own month, `fallback` = the most recent
 * earlier month (shown as a quiet "from July" marker, never a warning — on a floor with
 * thousands of materials a warning on every line is noise), `none` = no month has a price
 * and the field must be typed (FR-306).
 */
export type PriceSource = 'month' | 'fallback' | 'none';

export interface MonthPriceSelection {
  source: PriceSource;
  row: MonthPriceRow | null;
  value: MonthPriceValue | null;
  /** The month the price was taken from, for the marker on the line. */
  from_month: string | null;
}

/** `2026-09-18` → `2026-09-01`; a month is always stored as its first day (spec 2.2.3). */
export function firstOfMonth(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(isoDate);
  if (!match) throw new RangeError(`not an ISO date: ${isoDate}`);
  return `${match[1]}-${match[2]}-01`;
}

export function priceSideOf(row: MonthPriceRow, side: PriceSide): MonthPriceValue | null {
  const amount_iqd = side === 'bought' ? row.bought_iqd : row.sale_iqd;
  const amount_usd_cents = side === 'bought' ? row.bought_usd_cents : row.sale_usd_cents;
  const entered_currency = side === 'bought' ? row.bought_entered_currency : row.sale_entered_currency;
  const rate = side === 'bought' ? row.bought_rate : row.sale_rate;
  if (amount_iqd === null || amount_usd_cents === null || entered_currency === null || rate === null) {
    return null;
  }
  return { amount_iqd, amount_usd_cents, entered_currency, rate };
}

/**
 * The price that applies to a document in a given month: that month's own price, else the
 * most recent earlier month that has one, else nothing (FR-306).
 *
 * The two sides are chosen independently on purpose: a material whose September row carries
 * only a sale price still takes its bought price from August, which is what the fallback is
 * for, and is what keeps the cost snapshot of a September order meaningful.
 */
export function selectMonthPrice(
  rows: readonly MonthPriceRow[],
  side: PriceSide,
  documentDate: string,
): MonthPriceSelection {
  const month = firstOfMonth(documentDate);
  const withValue = rows
    .filter((row) => row.month <= month && priceSideOf(row, side) !== null)
    .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));

  const row = withValue[0];
  if (!row) return { source: 'none', row: null, value: null, from_month: null };

  return {
    source: row.month === month ? 'month' : 'fallback',
    row,
    value: priceSideOf(row, side),
    from_month: row.month,
  };
}

export interface DefaultedLinePrice {
  unit_price_iqd: number;
  unit_price_usd_cents: number;
  /** The currency the month price was entered in stays the authoritative side (FR-609). */
  price_entered_currency: Currency;
  month_price_id: string;
  price_source: 'month';
  from_month: string;
  /** True when the price came from an earlier month, for the "from July" marker. */
  carried_forward: boolean;
}

/**
 * A new line's unit price, defaulted from the month price list (FR-609, 2.3.3).
 *
 * The price is taken **in the currency it was entered in** and the other side is calculated
 * **at the document rate** — not at the rate stored on the price row. That is what makes a
 * per-deal rate ("today's dollar is 1,300") apply to the whole order, while the price list
 * keeps showing the pair it was typed with.
 */
export function defaultLinePrice(
  selection: MonthPriceSelection,
  documentRate: Rate,
): DefaultedLinePrice | null {
  if (!selection.row || !selection.value) return null;
  const typed = selection.value.entered_currency === 'IQD' ? selection.value.amount_iqd : selection.value.amount_usd_cents;
  const other = convert(typed, selection.value.entered_currency, documentRate);

  return {
    unit_price_iqd: selection.value.entered_currency === 'IQD' ? typed : other,
    unit_price_usd_cents: selection.value.entered_currency === 'IQD' ? other : typed,
    price_entered_currency: selection.value.entered_currency,
    month_price_id: selection.row.id,
    price_source: 'month',
    from_month: selection.row.month,
    carried_forward: selection.source === 'fallback',
  };
}

export interface CostSnapshot {
  cost_unit_iqd: number | null;
  cost_unit_usd_cents: number | null;
  cost_month_price_id: string | null;
  /** `month`, `fallback` or `none`, mirroring where the bought price came from. */
  cost_source: PriceSource;
}

/**
 * The cost snapshot a line keeps for the Profit report (FR-602, A-42).
 *
 * It copies the bought-price **pair as stored on the price row**, not a conversion at the
 * document rate: the report's margin must be reproducible from what was true in that month,
 * and editing a past month's price later must not move it (FR-305, 2.5.3 step 3).
 */
export function costSnapshotOf(selection: MonthPriceSelection): CostSnapshot {
  if (!selection.row || !selection.value) {
    return { cost_unit_iqd: null, cost_unit_usd_cents: null, cost_month_price_id: null, cost_source: 'none' };
  }
  return {
    cost_unit_iqd: selection.value.amount_iqd,
    cost_unit_usd_cents: selection.value.amount_usd_cents,
    cost_month_price_id: selection.row.id,
    cost_source: selection.source,
  };
}

/** True when a month price is "stale enough" to prompt for a new global rate (FR-1106). */
export function rateIsStale(effectiveFrom: Date, now: Date, staleDays: number): boolean {
  const days = (now.getTime() - effectiveFrom.getTime()) / 86_400_000;
  return days > staleDays;
}

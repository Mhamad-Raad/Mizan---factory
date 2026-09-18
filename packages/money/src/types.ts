export type Currency = 'IQD' | 'USD';

/** Where the rate that filled the calculated side came from (spec 2.2.2 `rate_source`). */
export type RateSource = 'company' | 'global' | 'manual';

/** The measure a line is priced by (spec 2.2.2 `measure`). */
export type Measure = 'count' | 'kg';

/** A rate is IQD per 1 USD, `numeric(14,4)`, carried as a string so it never touches a float. */
export type Rate = string;

/**
 * Every money value in Mizan is a pair plus a rate (spec 2.3.2). `entered_currency`
 * is the side the user typed and is therefore authoritative; the other side was
 * calculated at `rate_iqd_per_usd` and is stored, never recomputed later.
 */
export interface MoneyPair {
  amount_iqd: number;
  amount_usd_cents: number;
  entered_currency: Currency | null;
  rate_iqd_per_usd: Rate;
  rate_source: RateSource;
}

export interface Quantity {
  /** Whole pieces; `null` when this movement did not carry the measure (spec 2.2.3). */
  qty_count: number | null;
  /** Kilograms with three decimals, as a string so it never becomes a float. */
  qty_kg: string | null;
}

export const SETTLEMENT_TOLERANCE_DEFAULTS = {
  settle_tolerance_iqd: 250,
  settle_tolerance_usd_cents: 25,
} as const;

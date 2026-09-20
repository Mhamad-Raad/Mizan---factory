import type { Currency, Measure, PriceSource, Rate } from '@mizan/money';

export type PricingUnit = 'per_piece' | 'per_kg';

export interface ItemRow {
  id: string;
  name: string;
  name_normalized: string;
  code: string | null;
  pricing_unit: PricingUnit;
  min_stock_count: number | null;
  min_stock_kg: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  version: number;
}

/** A stored price pair as it leaves the API: two integers, the side typed, and the rate. */
export interface PricePairDto {
  amount_iqd: number;
  amount_usd_cents: number;
  entered_currency: Currency;
  rate_iqd_per_usd: Rate;
  /** The month the price was taken from — "from August" when it was carried forward. */
  from_month: string;
  /** `month` = this month's own price, `fallback` = carried forward quietly (FR-306). */
  source: Exclude<PriceSource, 'none'>;
}

export interface ItemStockDto {
  stock_count: number;
  stock_kg: string;
  count_complete: boolean;
  kg_complete: boolean;
  /** The measure the material is priced by; the figure the card leads with (FR-303). */
  priced_measure: Measure;
  priced_quantity: string;
  /** False when that measure is not summable for this material, so the screen shows "—". */
  priced_complete: boolean;
  /** Proposed — not requested (FR-310): the "Low" badge. */
  is_low: boolean;
}

/**
 * What a material looks like in a response. `bought` is a single key on purpose: the
 * field-level interceptor strips it wherever it appears for a user without
 * `fields.see_bought_price` (FR-103, spec 2.6.2), so no list, detail or price row can leak it.
 */
export interface ItemDto {
  id: string;
  name: string;
  code: string | null;
  pricing_unit: PricingUnit;
  notes: string | null;
  is_active: boolean;
  min_stock_count: number | null;
  min_stock_kg: string | null;
  stock: ItemStockDto;
  first_bought_on: string | null;
  last_sold_on: string | null;
  /** This month's prices, with the fallback marker (FR-305, FR-306). */
  sale: PricePairDto | null;
  bought: PricePairDto | null;
  version: number;
}

export interface MonthPriceDto {
  id: string;
  month: string;
  sale: Omit<PricePairDto, 'from_month' | 'source'> | null;
  bought: Omit<PricePairDto, 'from_month' | 'source'> | null;
  note: string | null;
  version: number;
  updated_at: string;
  updated_by_name: string | null;
}

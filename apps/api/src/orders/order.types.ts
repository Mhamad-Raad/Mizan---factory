import type { Currency, Measure, Rate, RateSource } from '@mizan/money';
import type { OrderStatus } from '@mizan/ledger';

export type PaymentType = 'cash' | 'borrowed';
export type PriceSource = 'month' | 'override';

export interface OrderRow {
  id: string;
  number: string;
  customer_id: string;
  order_date: string;
  acting_user_id: string;
  payment_type: PaymentType;
  notes: string | null;
  rate_iqd_per_usd: string;
  rate_source: RateSource;
  status: 'active' | 'void';
  void_reason: string | null;
  voided_by: string | null;
  voided_at: Date | null;
  discount_iqd: string;
  discount_usd_cents: string;
  total_iqd: string;
  total_usd_cents: string;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  version: number;
}

export interface OrderLineRow {
  id: string;
  order_id: string;
  line_no: number;
  item_id: string;
  qty_count: number | null;
  qty_kg: string | null;
  priced_measure: Measure;
  unit_price_iqd: string;
  unit_price_usd_cents: string;
  price_entered_currency: Currency;
  price_source: PriceSource;
  month_price_id: string | null;
  rate_iqd_per_usd: string;
  rate_source: RateSource;
  line_total_iqd: string;
  line_total_usd_cents: string;
  cost_unit_iqd: string | null;
  cost_unit_usd_cents: string | null;
  cost_month_price_id: string | null;
  cost_source: 'month' | 'fallback' | 'none';
  note: string | null;
  item_name?: string;
  item_pricing_unit?: 'per_piece' | 'per_kg';
  /** The month the defaulted price came from, for the "from August" marker (FR-306). */
  price_month?: string | null;
}

/**
 * A line as it leaves the API. The cost snapshot lives under one `cost` key so the
 * field-level interceptor can strip it for a caller without `fields.see_bought_price`
 * (FR-602, spec 2.6.2).
 */
export interface OrderLineDto {
  id: string;
  line_no: number;
  item_id: string;
  item_name: string;
  qty_count: number | null;
  qty_kg: string | null;
  priced_measure: Measure;
  unit_price_iqd: number;
  unit_price_usd_cents: number;
  price_entered_currency: Currency;
  price_source: PriceSource;
  month_price_id: string | null;
  /** Set when the price was carried forward from an earlier month (FR-306). */
  price_from_month: string | null;
  line_total_iqd: number;
  line_total_usd_cents: number;
  rate_iqd_per_usd: Rate;
  rate_source: RateSource;
  note: string | null;
  cost: {
    unit_iqd: number;
    unit_usd_cents: number;
    month_price_id: string | null;
    source: 'month' | 'fallback';
  } | null;
}

export interface OrderDto {
  id: string;
  number: number;
  customer_id: string;
  customer_name: string;
  customer_is_system: boolean;
  settlement_currency: Currency;
  order_date: string;
  payment_type: PaymentType;
  acting_user_id: string;
  acting_user_name: string | null;
  notes: string | null;
  rate_iqd_per_usd: Rate;
  rate_source: RateSource;
  /** Proposed — not requested (FR-616). */
  discount_iqd: number;
  discount_usd_cents: number;
  total_iqd: number;
  total_usd_cents: number;
  status: OrderStatus;
  doc_status: 'active' | 'void';
  void_reason: string | null;
  voided_by_name: string | null;
  voided_at: string | null;
  /** What is still owed, in the customer's settlement currency (FR-607). */
  remaining: number;
  /** The currency the customer handed over on a cash order (FR-604). */
  received_currency: Currency | null;
  lines: OrderLineDto[];
  version: number;
  created_at: string;
  /** Stock warnings raised while saving, so the screen can show them on the line (FR-303). */
  stock_warnings?: { item_id: string; item_name: string; available: string; requested: string; measure: Measure }[];
  /** Proposed — not requested (FR-616): shown, never enforced. */
  credit_limit_warning?: { limit: number; balance_after: number; currency: Currency } | null;
}

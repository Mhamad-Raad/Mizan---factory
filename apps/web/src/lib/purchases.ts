import type { Currency, Measure } from '@mizan/money';

/*
 * The shapes of a buy (a purchase) as the API sends them. The Purchases list itself gave its
 * place to the accountant page (D-062): buying is done in Materials now, and the buys of a
 * period are listed on /accounts.
 */

export interface PurchaseRow {
  id: string;
  number: number;
  company_id: string | null;
  company_name: string | null;
  settlement_currency: Currency | null;
  purchase_date: string;
  acting_user_id: string;
  acting_user_name: string | null;
  notes: string | null;
  rate_iqd_per_usd: string;
  rate_source: 'global' | 'manual' | 'company';
  doc_status: 'active' | 'void';
  void_reason: string | null;
  voided_by_name: string | null;
  voided_at: string | null;
  line_count: number;
  /** The materials bought, by name (D-062). */
  item_names?: string | null;
  /** Absent for a caller without `fields.see_bought_price` (FR-460, spec 2.6.2). */
  cost?: {
    discount_iqd: number;
    discount_usd_cents: number;
    total_iqd: number;
    total_usd_cents: number;
  } | null;
  version: number;
  created_at: string;
}

export interface PurchaseDetail extends PurchaseRow {
  lines: {
    id: string;
    line_no: number;
    item_id: string;
    item_name: string;
    qty_count: number | null;
    qty_kg: string | null;
    priced_measure: Measure;
    rate_iqd_per_usd: string;
    rate_source: 'global' | 'manual' | 'company';
    note: string | null;
    cost?: {
      unit_price_iqd: number;
      unit_price_usd_cents: number;
      price_entered_currency: Currency;
      price_source: 'month' | 'override';
      price_from_month: string | null;
      line_total_iqd: number;
      line_total_usd_cents: number;
    } | null;
  }[];
  duplicate_item_warning?: { item_id: string; item_name: string }[];
}

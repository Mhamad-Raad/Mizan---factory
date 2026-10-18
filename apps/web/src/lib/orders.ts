import type { Currency, Rate, RateSource } from '@mizan/money';

/** An order as the lists send it — Buying & selling, a company's Orders tab, Today (D-089). */
export interface OrderRow {
  id: string;
  number: number;
  customer_id: string;
  customer_name: string;
  customer_is_system: boolean;
  settlement_currency: Currency;
  order_date: string;
  payment_type: 'cash' | 'borrowed';
  acting_user_name: string | null;
  notes: string | null;
  /** Who takes it to the company (D-105). */
  driver_id: string | null;
  driver_name: string | null;
  rate_iqd_per_usd: Rate;
  rate_source: RateSource;
  discount_iqd: number;
  discount_usd_cents: number;
  total_iqd: number;
  total_usd_cents: number;
  status: 'unpaid' | 'partially_paid' | 'paid' | 'void';
  doc_status: 'active' | 'void';
  void_reason: string | null;
  remaining: number;
  received_currency: Currency | null;
  version: number;
}

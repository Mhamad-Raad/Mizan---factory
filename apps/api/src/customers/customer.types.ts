import type { Currency, Rate } from '@mizan/money';

export interface CustomerRow {
  id: string;
  name: string;
  name_normalized: string;
  phone: string | null;
  phone_normalized: string | null;
  address: string | null;
  notes: string | null;
  settlement_currency: Currency;
  assigned_user_id: string | null;
  is_system: boolean;
  credit_limit_iqd: string | null;
  credit_limit_usd_cents: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  version: number;
}

/**
 * A balance as it leaves the API (spec 2.3.6): the settlement-currency sum is the fact, and
 * the other currency is a conversion at *today's* rate, marked so the screen can prefix "≈".
 * It is never the sum of the other column — that would mix historical rates.
 */
export interface BalanceDto {
  amount_iqd: number;
  amount_usd_cents: number;
  currency: Currency;
  rate_iqd_per_usd: Rate;
  kind: 'derived';
}

export interface CustomerDto {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  settlement_currency: Currency;
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  /** True for the walk-in customer: no ledger tab, no assignment, cash orders only (A-33). */
  is_system: boolean;
  /** Proposed — not requested (FR-616): warns on a borrowed order, never blocks. */
  credit_limit: { amount_iqd: number; amount_usd_cents: number } | null;
  is_active: boolean;
  /** Stripped for a caller without `fields.see_customer_balances` (FR-503). */
  balance: BalanceDto | null;
  version: number;
}

/** One row of a customer's ledger, already grouped per the presentation rules of 2.4.5. */
export interface LedgerGroupDto {
  kind: string;
  entry_id: string;
  entry_type: string;
  entry_date: string;
  amount_iqd: number;
  amount_usd_cents: number;
  entered_currency: Currency | null;
  rate_iqd_per_usd: Rate;
  rate_source: string;
  balance_after: number;
  note: string | null;
  order_id: string | null;
  performed_by_user_id: string | null;
  performed_by_name: string | null;
  voucher_number: number | null;
  method: string | null;
  received_currency: Currency | null;
  hidden_by_default: boolean;
  created_at: string;
  /** The underlying rows of a collapsed group, for "expand to see who/when/note". */
  rows: {
    id: string;
    entry_type: string;
    entry_date: string;
    amount_iqd: number;
    amount_usd_cents: number;
    note: string | null;
    balance_after: number;
    created_at: string;
    performed_by_name: string | null;
  }[];
}

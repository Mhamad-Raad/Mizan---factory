import type { Currency, MoneyPair, Rate, RateSource } from '@mizan/money';

/** The three append-only ledgers (spec 2.4.1). */
export type LedgerKind = 'customer' | 'company' | 'stock';

/**
 * A row as it is stored. There is deliberately no `updated_by` and no `deleted_at`:
 * a ledger row is never updated and never deleted, so a correction is a `reversal` row
 * that negates it exactly (spec 2.2.1, rule 2 of CLAUDE.md).
 */
export interface LedgerEntry {
  id: string;
  /** The counterparty the balance belongs to (customer id, company id, item id). */
  owner_id: string;
  entry_type: string;
  amount_iqd: number;
  amount_usd_cents: number;
  entered_currency: Currency | null;
  rate_iqd_per_usd: Rate;
  rate_source: RateSource;
  /**
   * Posting order. `created_at` cannot serve: rows written inside one transaction share it,
   * so the running balance would be ambiguous exactly where it matters (spec 2.2.6, 2.4.1).
   */
  posting_seq: number;
  /** The business date, which may be earlier than the posting date on a back-dated entry. */
  entry_date: string;
  reverses_entry_id: string | null;
  performed_by_user_id: string | null;
  created_by: string;
  created_at: Date;
  note: string | null;
  /** Document links (`order_id`, `purchase_id`, `damage_id`, …) used by per-document views. */
  refs: Readonly<Record<string, string | null>>;
  /** Printed voucher number, on money rows only (Proposed — not requested, FR-614). */
  voucher_number?: number | null;
  /** `cash` / `transfer` / `other` (Proposed — not requested, FR-617). */
  method?: string | null;
}

export interface NewLedgerEntry {
  owner_id: string;
  entry_type: string;
  money: Pick<MoneyPair, 'amount_iqd' | 'amount_usd_cents' | 'entered_currency' | 'rate_iqd_per_usd' | 'rate_source'>;
  entry_date: string;
  created_by: string;
  performed_by_user_id?: string | null;
  note?: string | null;
  reverses_entry_id?: string | null;
  refs?: Readonly<Record<string, string | null>>;
  /** Ask the store for the next voucher number (Proposed — not requested, FR-614). */
  assign_voucher_number?: boolean;
  /** Proposed — not requested (FR-617); null on rows that are not money moving. */
  method?: string | null;
  /** Makes a retried write idempotent at the row level (spec 2.9.1, unique where not null). */
  idempotency_key?: string | null;
}

/** Entry types that cannot be written without a note (spec 2.4.1 rule 4). */
export const NOTE_REQUIRED_TYPES: readonly string[] = [
  'adjustment',
  'credit',
  'refund',
  'opening',
  'reversal',
  'settlement_change',
];

export interface BalanceChange {
  before: number;
  after: number;
  currency: Currency;
}

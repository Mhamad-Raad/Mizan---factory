import { Injectable } from '@nestjs/common';
import type { LedgerEntry, LedgerStore, NewLedgerEntry } from '@mizan/ledger';
import type { Db } from '../database/pool.js';

interface CustomerLedgerRow {
  id: string;
  customer_id: string;
  entry_type: string;
  amount_iqd: string;
  amount_usd_cents: string;
  entered_currency: 'IQD' | 'USD' | null;
  rate_iqd_per_usd: string;
  rate_source: 'company' | 'global' | 'manual';
  posting_seq: string;
  entry_date: string;
  order_id: string | null;
  damage_id: string | null;
  reverses_entry_id: string | null;
  performed_by_user_id: string;
  created_by: string;
  created_at: Date;
  note: string | null;
  voucher_number: string | null;
  method: string | null;
}

const COLUMNS = `id, customer_id, entry_type::text AS entry_type, amount_iqd::text AS amount_iqd,
                 amount_usd_cents::text AS amount_usd_cents, entered_currency::text AS entered_currency,
                 rate_iqd_per_usd::text AS rate_iqd_per_usd, rate_source::text AS rate_source,
                 posting_seq::text AS posting_seq, to_char(entry_date, 'YYYY-MM-DD') AS entry_date,
                 order_id, damage_id, reverses_entry_id, performed_by_user_id, created_by, created_at,
                 note, voucher_number::text AS voucher_number, method::text AS method`;

/** `bigint` leaves PostgreSQL as text so it never passes through a float (spec 2.3.1). */
function toAmount(value: string): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new RangeError(`amount outside the safe range: ${value}`);
  return amount;
}

export function toLedgerEntry(row: CustomerLedgerRow): LedgerEntry {
  return {
    id: row.id,
    owner_id: row.customer_id,
    entry_type: row.entry_type,
    amount_iqd: toAmount(row.amount_iqd),
    amount_usd_cents: toAmount(row.amount_usd_cents),
    entered_currency: row.entered_currency,
    rate_iqd_per_usd: row.rate_iqd_per_usd,
    rate_source: row.rate_source,
    posting_seq: Number(row.posting_seq),
    entry_date: row.entry_date,
    reverses_entry_id: row.reverses_entry_id,
    performed_by_user_id: row.performed_by_user_id,
    created_by: row.created_by,
    created_at: row.created_at,
    note: row.note,
    refs: { order_id: row.order_id, damage_id: row.damage_id },
    voucher_number: row.voucher_number === null ? null : Number(row.voucher_number),
    method: row.method,
  };
}

/**
 * The kernel's `LedgerStore` against PostgreSQL, bound to one transaction (spec 2.9.5): the
 * caller opens the transaction and locks the customer row, so the balance the writer computes
 * for the audit entry cannot be overtaken between the read and the insert.
 *
 * There is no `update` and no `delete` here, and the database role has neither privilege
 * (migration 0007). A correction is a reversal row.
 */
@Injectable()
export class CustomerLedgerStore implements LedgerStore {
  constructor(private readonly tx: Db) {}

  /** The rows of one customer, in posting order. */
  async entriesFor(customerId: string): Promise<LedgerEntry[]> {
    const { rows } = await this.tx.query<CustomerLedgerRow>(
      `SELECT ${COLUMNS} FROM customer_ledger WHERE customer_id = $1 ORDER BY posting_seq ASC`,
      [customerId],
    );
    return rows.map(toLedgerEntry);
  }

  async append(entry: NewLedgerEntry): Promise<LedgerEntry> {
    const { rows } = await this.tx.query<CustomerLedgerRow>(
      `INSERT INTO customer_ledger
         (customer_id, entry_type, amount_iqd, amount_usd_cents, entered_currency,
          rate_iqd_per_usd, rate_source, entry_date, order_id, damage_id, reverses_entry_id,
          performed_by_user_id, note, idempotency_key, voucher_number, method, created_by)
       VALUES ($1, $2::customer_entry_type, $3, $4, $5::currency, $6, $7::rate_source, $8::date,
               $9, $10, $11, $12, $13, $14,
               CASE WHEN $15::boolean THEN nextval('voucher_number_seq') ELSE NULL END,
               $16::payment_method, $17)
       RETURNING ${COLUMNS}`,
      [
        entry.owner_id,
        entry.entry_type,
        entry.money.amount_iqd,
        entry.money.amount_usd_cents,
        entry.money.entered_currency,
        entry.money.rate_iqd_per_usd,
        entry.money.rate_source,
        entry.entry_date,
        entry.refs?.order_id ?? null,
        entry.refs?.damage_id ?? null,
        entry.reverses_entry_id ?? null,
        entry.performed_by_user_id ?? entry.created_by,
        entry.note ?? null,
        entry.idempotency_key ?? null,
        entry.assign_voucher_number ?? false,
        entry.method ?? null,
        entry.created_by,
      ],
    );
    return toLedgerEntry(rows[0] as CustomerLedgerRow);
  }
}

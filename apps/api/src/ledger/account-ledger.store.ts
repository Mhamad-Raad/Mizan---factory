import type { LedgerEntry, LedgerStore, NewLedgerEntry } from '@mizan/ledger';
import type { Db } from '../database/pool.js';

/**
 * What tells one money ledger from the other (spec 2.2.3): the table, the column naming the
 * counterparty, the enum its types come from, and the document it can point at. Everything
 * else about a ledger row is identical on both sides, which is the whole reason this file
 * exists (D-019).
 */
export interface LedgerShape {
  table: 'customer_ledger' | 'company_ledger';
  ownerColumn: 'customer_id' | 'company_id';
  entryTypeEnum: 'customer_entry_type' | 'company_entry_type';
  /** The document a row may belong to: an order on the customer side, a purchase on the other. */
  documentColumn: 'order_id' | 'purchase_id';
  /** The table holding the counterparty, locked before a balance is computed (2.9.5). */
  ownerTable: 'customers' | 'companies';
}

interface LedgerRow {
  id: string;
  owner_id: string;
  entry_type: string;
  amount_iqd: string;
  amount_usd_cents: string;
  entered_currency: 'IQD' | 'USD' | null;
  rate_iqd_per_usd: string;
  rate_source: 'company' | 'global' | 'manual';
  posting_seq: string;
  entry_date: string;
  document_id: string | null;
  damage_id: string | null;
  reverses_entry_id: string | null;
  performed_by_user_id: string;
  created_by: string;
  created_at: Date;
  note: string | null;
  voucher_number: string | null;
  method: string | null;
}

/** `bigint` leaves PostgreSQL as text so it never passes through a float (spec 2.3.1). */
function toAmount(value: string): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new RangeError(`amount outside the safe range: ${value}`);
  return amount;
}

/**
 * The kernel's `LedgerStore` against PostgreSQL, bound to one transaction (spec 2.9.5): the
 * caller opens the transaction and locks the counterparty, so the balance the writer computes
 * for the audit row cannot be overtaken between the read and the insert.
 *
 * There is no `update` and no `delete` here, and the database role has neither privilege
 * (migrations 0007 and 0009). A correction is a reversal row.
 */
export class AccountLedgerStore implements LedgerStore {
  constructor(
    private readonly tx: Db,
    private readonly shape: LedgerShape,
  ) {}

  private columns(): string {
    const { ownerColumn, documentColumn } = this.shape;
    return `id, ${ownerColumn} AS owner_id, entry_type::text AS entry_type,
            amount_iqd::text AS amount_iqd, amount_usd_cents::text AS amount_usd_cents,
            entered_currency::text AS entered_currency, rate_iqd_per_usd::text AS rate_iqd_per_usd,
            rate_source::text AS rate_source, posting_seq::text AS posting_seq,
            to_char(entry_date, 'YYYY-MM-DD') AS entry_date, ${documentColumn} AS document_id,
            damage_id, reverses_entry_id, performed_by_user_id, created_by, created_at, note,
            voucher_number::text AS voucher_number, method::text AS method`;
  }

  private toEntry(row: LedgerRow): LedgerEntry {
    return {
      id: row.id,
      owner_id: row.owner_id,
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
      refs: { [this.shape.documentColumn]: row.document_id, damage_id: row.damage_id },
      voucher_number: row.voucher_number === null ? null : Number(row.voucher_number),
      method: row.method,
    };
  }

  /** The rows of one counterparty, in posting order. */
  async entriesFor(ownerId: string): Promise<LedgerEntry[]> {
    const { rows } = await this.tx.query<LedgerRow>(
      `SELECT ${this.columns()} FROM ${this.shape.table}
        WHERE ${this.shape.ownerColumn} = $1
        ORDER BY posting_seq ASC`,
      [ownerId],
    );
    return rows.map((row) => this.toEntry(row));
  }

  async append(entry: NewLedgerEntry): Promise<LedgerEntry> {
    const { table, ownerColumn, entryTypeEnum, documentColumn } = this.shape;
    const { rows } = await this.tx.query<LedgerRow>(
      `INSERT INTO ${table}
         (${ownerColumn}, entry_type, amount_iqd, amount_usd_cents, entered_currency,
          rate_iqd_per_usd, rate_source, entry_date, ${documentColumn}, damage_id,
          reverses_entry_id, performed_by_user_id, note, idempotency_key, voucher_number,
          method, created_by)
       VALUES ($1, $2::${entryTypeEnum}, $3, $4, $5::currency, $6, $7::rate_source, $8::date,
               $9, $10, $11, $12, $13, $14,
               CASE WHEN $15::boolean THEN nextval('voucher_number_seq') ELSE NULL END,
               $16::payment_method, $17)
       RETURNING ${this.columns()}`,
      [
        entry.owner_id,
        entry.entry_type,
        entry.money.amount_iqd,
        entry.money.amount_usd_cents,
        entry.money.entered_currency,
        entry.money.rate_iqd_per_usd,
        entry.money.rate_source,
        entry.entry_date,
        entry.refs?.[documentColumn] ?? null,
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
    return this.toEntry(rows[0] as LedgerRow);
  }
}

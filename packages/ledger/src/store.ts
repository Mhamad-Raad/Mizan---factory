import type { LedgerEntry, NewLedgerEntry } from './types.js';

/**
 * The port the writer needs. The API implements it against PostgreSQL inside the request's
 * transaction; the tests implement it in memory, so the same cases run against both
 * (spec 2.12, "Vitest against an in-memory ledger model, then the same cases against PostgreSQL").
 */
export interface LedgerStore {
  /** Rows of one counterparty, for the balance. Must be read under a row lock (spec 2.9.5). */
  entriesFor(ownerId: string): Promise<LedgerEntry[]>;
  /** Appends one row, assigning `posting_seq` from the ledger's sequence. Never updates. */
  append(entry: NewLedgerEntry): Promise<LedgerEntry>;
}

export class InMemoryLedgerStore implements LedgerStore {
  private readonly rows: LedgerEntry[] = [];
  private sequence = 0;
  private ids = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async entriesFor(ownerId: string): Promise<LedgerEntry[]> {
    return this.rows.filter((row) => row.owner_id === ownerId);
  }

  async append(entry: NewLedgerEntry): Promise<LedgerEntry> {
    this.sequence += 1;
    this.ids += 1;
    const row: LedgerEntry = {
      id: `e${this.ids}`,
      owner_id: entry.owner_id,
      entry_type: entry.entry_type,
      amount_iqd: entry.money.amount_iqd,
      amount_usd_cents: entry.money.amount_usd_cents,
      entered_currency: entry.money.entered_currency,
      rate_iqd_per_usd: entry.money.rate_iqd_per_usd,
      rate_source: entry.money.rate_source,
      posting_seq: this.sequence,
      entry_date: entry.entry_date,
      reverses_entry_id: entry.reverses_entry_id ?? null,
      performed_by_user_id: entry.performed_by_user_id ?? null,
      created_by: entry.created_by,
      created_at: this.now(),
      note: entry.note ?? null,
      refs: entry.refs ?? {},
    };
    this.rows.push(row);
    return row;
  }

  /** Test helper: the rows as they were written, in posting order. */
  all(): readonly LedgerEntry[] {
    return [...this.rows].sort((a, b) => a.posting_seq - b.posting_seq);
  }
}

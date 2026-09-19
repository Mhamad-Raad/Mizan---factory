import { amountIn } from '@mizan/money';
import type { Currency } from '@mizan/money';
import { balanceOf } from './balance.js';
import { liveEntries, reversalOf } from './reversal.js';
import type { LedgerStore } from './store.js';
import { NOTE_REQUIRED_TYPES } from './types.js';
import type { BalanceChange, LedgerEntry, NewLedgerEntry } from './types.js';

export class LedgerWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerWriteError';
  }
}

export interface WriteResult {
  entry: LedgerEntry;
  /** What History records as old → new for this balance (spec 2.4.1 rule 5, 2.4.2). */
  balance: BalanceChange;
}

/**
 * The only way a ledger row is ever written (spec 2.4.1).
 *
 * It appends — never updates, never deletes — and computes the balance before and after
 * *inside the caller's transaction*, so the audit row can carry them and the running balance
 * on screen can never disagree with History. The caller is responsible for opening the
 * transaction and locking the counterparty row (spec 2.9.5); this class does the rest.
 */
export class LedgerWriter {
  constructor(
    private readonly store: LedgerStore,
    private readonly settlementCurrency: (ownerId: string) => Promise<Currency> | Currency,
  ) {}

  async write(entry: NewLedgerEntry): Promise<WriteResult> {
    if (NOTE_REQUIRED_TYPES.includes(entry.entry_type) && !entry.note?.trim()) {
      throw new LedgerWriteError(`entry type "${entry.entry_type}" requires a note`);
    }
    if (entry.entry_type === 'reversal' && !entry.reverses_entry_id) {
      throw new LedgerWriteError('a reversal must name the row it reverses');
    }
    if (entry.entry_type !== 'reversal' && entry.reverses_entry_id) {
      throw new LedgerWriteError('only a reversal row may name a row it reverses');
    }

    const currency = await this.settlementCurrency(entry.owner_id);
    const existing = await this.store.entriesFor(entry.owner_id);
    const before = balanceOf(existing, currency);
    const written = await this.store.append(entry);

    return {
      entry: written,
      balance: { before, after: before + amountIn(written, currency), currency },
    };
  }

  /** Reverses one row: the exact negation, refused if that row was already reversed. */
  async reverse(
    ownerId: string,
    entryId: string,
    options: { created_by: string; note: string; entry_date?: string },
  ): Promise<WriteResult> {
    const existing = await this.store.entriesFor(ownerId);
    const target = existing.find((entry) => entry.id === entryId);
    if (!target) throw new LedgerWriteError(`ledger entry ${entryId} does not belong to ${ownerId}`);
    return this.write(reversalOf(target, existing, options));
  }

  /**
   * "Reverse everything live, then write the new version" — the first half of the edit and
   * void algorithm (spec 2.5.3 step 2), used from I1 onwards by orders and purchases.
   */
  async reverseAllLive(
    ownerId: string,
    predicate: (entry: LedgerEntry) => boolean,
    options: { created_by: string; note: string; entry_date?: string },
  ): Promise<WriteResult[]> {
    const existing = await this.store.entriesFor(ownerId);
    const results: WriteResult[] = [];
    for (const entry of liveEntries(existing).filter(predicate)) {
      results.push(await this.reverse(ownerId, entry.id, options));
    }
    return results;
  }
}

/** The `changes` payload of a ledger audit row, exactly as specification 2.4.2 shows it. */
export function ledgerAuditChanges(result: WriteResult): Record<string, unknown> {
  return {
    balance: {
      before: { amount: result.balance.before, currency: result.balance.currency },
      after: { amount: result.balance.after, currency: result.balance.currency },
    },
    entry: {
      type: result.entry.entry_type,
      amount_iqd: result.entry.amount_iqd,
      amount_usd_cents: result.entry.amount_usd_cents,
      rate: result.entry.rate_iqd_per_usd,
      rate_source: result.entry.rate_source,
    },
  };
}

import { negatePair } from '@mizan/money';
import type { LedgerEntry, NewLedgerEntry } from './types.js';

export class AlreadyReversedError extends Error {
  constructor(public readonly entryId: string) {
    super(`ledger entry ${entryId} has already been reversed`);
    this.name = 'AlreadyReversedError';
  }
}

export class ReversalNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReversalNotAllowedError';
  }
}

/** A row is "live" when nothing reverses it; only live rows are reversed on edit or void. */
export function isLive(entry: LedgerEntry, all: readonly LedgerEntry[]): boolean {
  if (entry.entry_type === 'reversal') return false;
  return !all.some((other) => other.reverses_entry_id === entry.id);
}

export function liveEntries(all: readonly LedgerEntry[]): LedgerEntry[] {
  return all.filter((entry) => isLive(entry, all));
}

/**
 * The reversal of a row: the exact negation, so `entry + reversal = 0` in both currencies
 * by construction, carrying the same rate so the pair stays self-describing (spec 2.4.1).
 * A row may be reversed at most once — the database enforces it with a unique index on
 * `reverses_entry_id`, and this is the check that produces the friendly error first.
 */
export function reversalOf(
  entry: LedgerEntry,
  all: readonly LedgerEntry[],
  options: { created_by: string; note: string; entry_date?: string },
): NewLedgerEntry {
  if (entry.entry_type === 'reversal') {
    throw new ReversalNotAllowedError('a reversal row cannot itself be reversed');
  }
  if (entry.entry_type === 'settlement_change') {
    // A re-basing row is never reversed; a mistake is corrected by another currency change
    // (spec 2.3.5), because reversing it would resurrect a mixed-rate column.
    throw new ReversalNotAllowedError('a settlement change is corrected by another change, never reversed');
  }
  if (!options.note || options.note.trim().length === 0) {
    throw new ReversalNotAllowedError('a reversal requires a note');
  }
  if (all.some((other) => other.reverses_entry_id === entry.id)) {
    throw new AlreadyReversedError(entry.id);
  }

  const negated = negatePair({
    amount_iqd: entry.amount_iqd,
    amount_usd_cents: entry.amount_usd_cents,
    entered_currency: entry.entered_currency,
    rate_iqd_per_usd: entry.rate_iqd_per_usd,
    rate_source: entry.rate_source,
  });

  return {
    owner_id: entry.owner_id,
    entry_type: 'reversal',
    money: negated,
    entry_date: options.entry_date ?? entry.entry_date,
    created_by: options.created_by,
    performed_by_user_id: entry.performed_by_user_id,
    note: options.note,
    reverses_entry_id: entry.id,
    refs: entry.refs,
  };
}

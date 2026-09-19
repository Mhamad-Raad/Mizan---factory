import { amountIn } from '@mizan/money';
import type { Currency } from '@mizan/money';
import type { LedgerEntry } from './types.js';

/**
 * *The* balance: the sum of the settlement-currency column (spec 2.2.6, 2.3.4).
 * The other column is never summed into a displayed balance — a sum of amounts converted
 * at different historical rates is not a balance in that currency.
 */
export function balanceOf(entries: readonly LedgerEntry[], currency: Currency): number {
  return entries.reduce((total, entry) => total + amountIn(entry, currency), 0);
}

export function byPostingOrder(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort((a, b) => a.posting_seq - b.posting_seq);
}

export interface EntryWithRunningBalance {
  entry: LedgerEntry;
  balance_after: number;
}

/**
 * The running balance runs in **posting order**, so each row's "after" value is exactly the
 * before/after recorded in its audit row and the ledger screen can never disagree with
 * History (spec 2.2.6 `ledger_running`, 2.4.1 rule 5).
 */
export function runningBalances(
  entries: readonly LedgerEntry[],
  currency: Currency,
): EntryWithRunningBalance[] {
  let balance = 0;
  return byPostingOrder(entries).map((entry) => {
    balance += amountIn(entry, currency);
    return { entry, balance_after: balance };
  });
}

/**
 * When a ledger is sorted by business date the running column becomes "balance as of this
 * date" — Σ entries with `entry_date ≤ date` — because a back-dated row would otherwise make
 * the running column jump (spec 2.2.6, A-43).
 */
export function balanceAsOf(
  entries: readonly LedgerEntry[],
  currency: Currency,
  isoDate: string,
): number {
  return balanceOf(
    entries.filter((entry) => entry.entry_date <= isoDate),
    currency,
  );
}

/** The balance of one document: the rows that carry its id (spec 2.4.3). */
export function balanceOfRef(
  entries: readonly LedgerEntry[],
  refKey: string,
  refId: string,
  currency: Currency,
): number {
  return balanceOf(
    entries.filter((entry) => entry.refs[refKey] === refId),
    currency,
  );
}

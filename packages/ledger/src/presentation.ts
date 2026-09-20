import { runningBalances } from './balance.js';
import type { EntryWithRunningBalance } from './balance.js';
import type { LedgerEntry } from './types.js';
import type { Currency } from '@mizan/money';

/**
 * Ledger presentation rules (spec 2.4.5).
 *
 * The ledgers are correct by construction but noisy by nature: a cash order writes two rows,
 * every edit writes a reversal plus a replacement, an undo leaves a pair forever. Nothing is
 * ever hidden from the truth — `?raw=true` returns every row — but the screens group rows so
 * that a customer's ledger reads like a statement instead of a journal.
 *
 * Grouping is presentation only: no row is changed, and a group always sits at the position
 * of its latest row and shows that row's running balance, so the column still agrees with
 * the before/after recorded in History (2.4.1 rule 5).
 */

export type LedgerGroupKind =
  /** One ordinary row. */
  | 'entry'
  /** (entry, reversal, replacement…): shown as one row labelled "edited". */
  | 'edited'
  /** (entry, reversal) with no replacement: greyed "undone by …". */
  | 'undone'
  /** An `order` row and its automatic `cash_settlement`: "Cash order #1043 · paid in IQD". */
  | 'cash_order'
  /** A `settlement_change` marker: "Settlement currency changed IQD → USD at 1,310". */
  | 'rebase';

export interface LedgerGroup {
  kind: LedgerGroupKind;
  /** The rows behind the group, in posting order; expanding shows them with who/when/note. */
  rows: EntryWithRunningBalance[];
  /** The latest row: the group's position and running balance (2.4.5). */
  anchor: EntryWithRunningBalance;
  /** What the group shows: the current version's amounts, or the order total for a cash pair. */
  amount_iqd: number;
  amount_usd_cents: number;
  /** An undo pair is hidden until the user asks for "show undone" (2.4.5). */
  hidden_by_default: boolean;
  order_id: string | null;
  /** On a cash-order group: the currency the customer physically handed over (FR-604). */
  received_currency: Currency | null;
}

/** The reversal note the 8-second undo writes (FR-610), which hides the pair by default. */
const UNDO_NOTE = 'undo';

/** Row types that are money actually moving, for the "money movements only" toggle (2.4.5). */
export const MONEY_MOVEMENT_TYPES: readonly string[] = [
  'payment',
  'cash_settlement',
  'credit',
  'refund',
  'adjustment',
];

/**
 * Only a *document* entry is ever replaced: an edit rewrites the order row and its cash
 * settlement. A reversed payment is undone, not edited — a later payment against the same
 * order is a new payment, and grouping the two as one "edited" row would hide both facts.
 */
const REPLACEABLE_TYPES: readonly string[] = ['order', 'cash_settlement', 'purchase'];

function keyOf(entry: LedgerEntry): string | null {
  if (!REPLACEABLE_TYPES.includes(entry.entry_type)) return null;
  const documentId = entry.refs.order_id ?? entry.refs.purchase_id ?? null;
  return documentId ? `${entry.entry_type}|${documentId}` : null;
}

/**
 * Groups one counterparty's rows for display. Input may be in any order; the output is in
 * posting order (oldest first), which the API reverses for a newest-first screen.
 */
export function groupLedger(entries: readonly LedgerEntry[], settlementCurrency: Currency): LedgerGroup[] {
  const rows = runningBalances(entries, settlementCurrency);
  const reversalOf = new Map<string, EntryWithRunningBalance>();
  for (const row of rows) {
    if (row.entry.reverses_entry_id) reversalOf.set(row.entry.reverses_entry_id, row);
  }

  const consumed = new Set<string>();
  const groups: LedgerGroup[] = [];

  for (const row of rows) {
    const entry = row.entry;
    if (consumed.has(entry.id)) continue;
    if (entry.entry_type === 'reversal') continue; // reached through the row it reverses

    if (entry.entry_type === 'settlement_change') {
      consumed.add(entry.id);
      groups.push(single('rebase', row));
      continue;
    }

    const chain: EntryWithRunningBalance[] = [row];
    let current = row;
    let reversal = reversalOf.get(entry.id);

    // Follow (entry → reversal → replacement) as far as it goes: an order edited twice is
    // three versions and two reversals, and it is still one line on the screen.
    while (reversal) {
      const reversalRow = reversal;
      chain.push(reversalRow);
      const key = keyOf(current.entry);
      const replacement = key
        ? rows.find(
            (candidate) =>
              candidate.entry.posting_seq > reversalRow.entry.posting_seq &&
              candidate.entry.entry_type !== 'reversal' &&
              !consumed.has(candidate.entry.id) &&
              keyOf(candidate.entry) === key,
          )
        : undefined;
      if (!replacement) break;
      chain.push(replacement);
      current = replacement;
      reversal = reversalOf.get(replacement.entry.id);
    }

    for (const member of chain) consumed.add(member.entry.id);

    if (chain.length === 1) {
      groups.push(single('entry', row));
      continue;
    }

    const lastReversal = [...chain].reverse().find((member) => member.entry.entry_type === 'reversal');
    const replaced = chain[chain.length - 1] as EntryWithRunningBalance;
    const isUndone = replaced.entry.entry_type === 'reversal';

    if (isUndone) {
      groups.push({
        kind: 'undone',
        rows: chain,
        anchor: replaced,
        // The pair nets to zero; the screen greys it and names who undid it.
        amount_iqd: 0,
        amount_usd_cents: 0,
        hidden_by_default: (lastReversal?.entry.note ?? '').trim().toLowerCase() === UNDO_NOTE,
        order_id: (entry.refs.order_id as string | undefined) ?? null,
        received_currency: null,
      });
      continue;
    }

    groups.push({
      kind: 'edited',
      rows: chain,
      anchor: replaced,
      amount_iqd: replaced.entry.amount_iqd,
      amount_usd_cents: replaced.entry.amount_usd_cents,
      hidden_by_default: false,
      order_id: (replaced.entry.refs.order_id as string | undefined) ?? null,
      received_currency: null,
    });
  }

  return collapseCashOrders(groups).sort((a, b) => a.anchor.entry.posting_seq - b.anchor.entry.posting_seq);
}

/**
 * A cash order is an `order` row plus an immediate `cash_settlement` for the same amount
 * (A-24). Two rows for one event, so the default view shows one — and only while both are
 * plain single rows: once either side has been edited or undone, the group that explains
 * *that* is the more useful one to show.
 */
function collapseCashOrders(groups: LedgerGroup[]): LedgerGroup[] {
  const settlements = new Map<string, LedgerGroup>();
  for (const group of groups) {
    if (group.kind !== 'entry') continue;
    const entry = group.anchor.entry;
    if (entry.entry_type === 'cash_settlement' && entry.refs.order_id) {
      settlements.set(entry.refs.order_id, group);
    }
  }

  const merged: LedgerGroup[] = [];
  const consumed = new Set<LedgerGroup>();

  for (const group of groups) {
    if (consumed.has(group)) continue;
    const entry = group.anchor.entry;
    const orderId = entry.refs.order_id as string | undefined;

    if (group.kind === 'entry' && entry.entry_type === 'order' && orderId) {
      const settlement = settlements.get(orderId);
      if (settlement) {
        consumed.add(group);
        consumed.add(settlement);
        const later =
          settlement.anchor.entry.posting_seq > group.anchor.entry.posting_seq ? settlement : group;
        merged.push({
          kind: 'cash_order',
          rows: [...group.rows, ...settlement.rows].sort(
            (a, b) => a.entry.posting_seq - b.entry.posting_seq,
          ),
          anchor: later.anchor,
          // The row shows what the sale was; its net effect on the balance is zero.
          amount_iqd: entry.amount_iqd,
          amount_usd_cents: entry.amount_usd_cents,
          hidden_by_default: false,
          order_id: orderId,
          received_currency: settlement.anchor.entry.entered_currency,
        });
        continue;
      }
    }

    merged.push(group);
  }

  return merged;
}

function single(kind: LedgerGroupKind, row: EntryWithRunningBalance): LedgerGroup {
  return {
    kind,
    rows: [row],
    anchor: row,
    amount_iqd: row.entry.amount_iqd,
    amount_usd_cents: row.entry.amount_usd_cents,
    hidden_by_default: false,
    order_id: (row.entry.refs.order_id as string | undefined) ?? null,
    received_currency: row.entry.entry_type === 'cash_settlement' ? row.entry.entered_currency : null,
  };
}

/** The "money movements only" toggle: drop the groups that are documents, not money (2.4.5). */
export function moneyMovementsOnly(groups: readonly LedgerGroup[]): LedgerGroup[] {
  return groups.filter((group) =>
    group.rows.some((row) => MONEY_MOVEMENT_TYPES.includes(row.entry.entry_type)),
  );
}

/** The order's History tab: the API's answer and the one timeline the page draws from it. */

export interface OrderHistory {
  items: {
    id: string;
    action: string;
    entity_type: string;
    occurred_at: string;
    actor_display_name: string | null;
    note: string | null;
    changes: {
      /** A money entry's own figures — present on `ledger_entry` rows (payments, reversals). */
      entry?: { type: string; amount_iqd: number; amount_usd_cents: number };
    } | null;
    related: { ledger_entry_id?: string } | null;
  }[];
  payment_type_changes: {
    id: string;
    from_type: string;
    to_type: string;
    note: string;
    changed_at: string;
    changed_by_name: string | null;
  }[];
  ledger_entries: {
    id: string;
    entry_type: string;
    entry_date: string;
    amount_iqd: number;
    amount_usd_cents: number;
    note: string | null;
    voucher_number: number | null;
    reverses_entry_id: string | null;
  }[];
}

/** The rows an order posts itself, whose reversals are part of an edit rather than money. */
const POSTINGS = new Set(['order', 'cash_settlement']);

export type TimelineRow =
  | { kind: 'audit'; at: string; entry: OrderHistory['items'][number] }
  | { kind: 'type_change'; at: string; change: OrderHistory['payment_type_changes'][number] };

/**
 * The order's History as one timeline, newest first: its own rows, the payments and reversals
 * recorded against it, the damage reported from it, and the payment-type changes.
 *
 * The money entries that only *post the order* are left out: the debt it adds when created, and
 * the reversals an edit, a void or a change to borrowed makes of that debt or of a cash order's
 * settlement. "Created", "changed", "voided" and the type change already say those, and listing
 * them again would read as money that changed hands. A reversed *payment* stays.
 */
export function timelineOf(history: OrderHistory | undefined): TimelineRow[] {
  if (!history) return [];
  const ledger = new Map(history.ledger_entries.map((entry) => [entry.id, entry]));
  const postsTheOrder = (item: OrderHistory['items'][number]): boolean => {
    const own = ledger.get(item.related?.ledger_entry_id ?? '');
    if (!own) return item.changes?.entry?.type === 'order';
    if (own.entry_type === 'order') return true;
    const reversed = own.reverses_entry_id ? ledger.get(own.reverses_entry_id) : undefined;
    return own.entry_type === 'reversal' && POSTINGS.has(reversed?.entry_type ?? '');
  };
  const rows: TimelineRow[] = [
    ...history.items
      .filter((entry) => !postsTheOrder(entry))
      .map((entry) => ({ kind: 'audit' as const, at: entry.occurred_at, entry })),
    ...history.payment_type_changes.map((change) => ({
      kind: 'type_change' as const,
      at: change.changed_at,
      change,
    })),
  ];
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

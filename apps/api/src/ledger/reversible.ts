import type { LedgerEntry } from '@mizan/ledger';
import { ApiError } from '../common/errors.js';
import type { RequestContext } from '../common/request-context.js';

/**
 * The rows the ledger's own "reverse" may undo: money that moved on its own. A document's row —
 * an order or a purchase, its cash settlement, a damage charge — belongs to the document and is
 * undone by editing or voiding it; reversing it alone erased a debt while the order stayed
 * active with its stock gone (review).
 */
const REVERSIBLE = new Set(['payment', 'credit', 'refund', 'adjustment', 'opening']);

/**
 * Who may reverse what (spec 1.5.2): an admin any reversible row; anybody else only a payment
 * they recorded themselves today — the "I typed it wrong" of the counter, nothing more (review).
 */
/**
 * Whether a payment may be taken back by this person (spec 2.4.1): an administrator, or the one
 * who recorded it, on the day. A purchase's void asks it of the payment made with the purchase.
 */
export function mayReversePayment(entry: LedgerEntry, context: RequestContext, today: string): boolean {
  if (context.role === 'admin') return true;
  return entry.entry_type === 'payment' && entry.created_by === context.userId && entry.entry_date === today;
}

export function assertMayReverse(entry: LedgerEntry, context: RequestContext, today: string): void {
  if (!REVERSIBLE.has(entry.entry_type)) {
    throw ApiError.validation([
      { path: 'entry_id', code: 'NOT_REVERSIBLE', message_key: 'errors:entry_not_reversible', params: {} },
    ]);
  }
  if (!mayReversePayment(entry, context, today)) throw ApiError.permissionDenied('admin');
}

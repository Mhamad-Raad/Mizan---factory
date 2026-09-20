import { balanceOfRef } from './balance.js';
import type { LedgerEntry } from './types.js';
import type { Currency } from '@mizan/money';

/**
 * Derived statuses (spec 2.4.3, FR-607). A status is never stored: it is read from the
 * ledger, so an order cannot be "Paid" while its entries say otherwise.
 */

export type OrderStatus = 'void' | 'paid' | 'partially_paid' | 'unpaid';

export interface OrderStatusInput {
  voided: boolean;
  /** The order total in the customer's settlement currency. */
  total: number;
  /** Σ of the customer's ledger rows carrying this `order_id`, same currency. */
  remaining: number;
}

/**
 * `void` → nothing else matters; otherwise nothing owed is `paid`, everything still owed is
 * `unpaid`, and anything between is `partially_paid`.
 *
 * `remaining ≤ 0` counts as paid rather than only `= 0`: an order can end up over-settled
 * (a credit linked to it, a manual adjustment), and "partially paid" would be a plainly
 * wrong word for an order that owes nothing.
 */
export function orderStatus(input: OrderStatusInput): OrderStatus {
  if (input.voided) return 'void';
  if (input.remaining <= 0) return 'paid';
  if (input.remaining >= input.total) return 'unpaid';
  return 'partially_paid';
}

/** What is still owed on one order: the sum of the rows that carry its id (2.4.3). */
export function orderRemaining(
  entries: readonly LedgerEntry[],
  orderId: string,
  settlementCurrency: Currency,
): number {
  return balanceOfRef(entries, 'order_id', orderId, settlementCurrency);
}

export function orderStatusFromEntries(input: {
  entries: readonly LedgerEntry[];
  order_id: string;
  voided: boolean;
  total: number;
  settlement_currency: Currency;
}): { status: OrderStatus; remaining: number } {
  const remaining = orderRemaining(input.entries, input.order_id, input.settlement_currency);
  return {
    status: orderStatus({ voided: input.voided, total: input.total, remaining }),
    remaining,
  };
}

import { amountIn } from '@mizan/money';
import type { Currency } from '@mizan/money';
import { isLive } from './reversal.js';
import type { LedgerEntry } from './types.js';

/**
 * "How much we owe per purchase" (FR-704, FR-712, A-29).
 *
 * Supplier accounts are running accounts: nobody links a lump-sum payment to an invoice, so a
 * payment that names no purchase is applied to the **oldest purchase first** — for display
 * only. The balance is, as always, the sum of every entry; this function just decides how to
 * *show* that sum per purchase, which is why A-29 calls the allocation a hedge: the rule can
 * change without touching a single stored row.
 *
 * What is never allocated: opening balances, unlinked adjustments, re-basing markers and
 * anything belonging to a voided purchase. Those form the "General" bucket, and the identity
 * that must always hold — and is property-tested — is
 *
 *     Σ remaining (active purchases) + general = the company balance.
 */

export interface AllocationPurchase {
  id: string;
  /** The purchase total in the company's settlement currency. */
  total: number;
  /** Business date, which is what "oldest" means here. */
  purchase_date: string;
  /** A voided purchase is never allocated against; its entries fall into General. */
  voided: boolean;
  /** Ordering tie-break, so two purchases on one day allocate in the order they were made. */
  number: number;
}

export interface PurchaseAllocation {
  purchase_id: string;
  total: number;
  /** Payments, credits and adjustments explicitly naming this purchase. */
  linked: number;
  /** This purchase's share of the payments and credits that named no purchase. */
  allocated: number;
  /** `total + linked + allocated` — negative when more was paid against it than it was worth. */
  remaining: number;
}

export interface AllocationResult {
  purchases: PurchaseAllocation[];
  /** Everything not attributable to an active purchase (A-29). */
  general: number;
  /** The company balance: Σ remaining + general, and the sum of the ledger. */
  balance: number;
}

/** Entry types that a lump sum can be spread over: money that reduces what we owe. */
const ALLOCATABLE_TYPES: readonly string[] = ['payment', 'credit'];

export function allocateOldestFirst(
  entries: readonly LedgerEntry[],
  purchases: readonly AllocationPurchase[],
  settlementCurrency: Currency,
): AllocationResult {
  const live = entries.filter((entry) => isLive(entry, entries));
  const balance = entries.reduce((total, entry) => total + amountIn(entry, settlementCurrency), 0);

  const active = [...purchases]
    .filter((purchase) => !purchase.voided)
    .sort((a, b) =>
      a.purchase_date === b.purchase_date
        ? a.number - b.number
        : a.purchase_date < b.purchase_date
          ? -1
          : 1,
    );
  const activeIds = new Set(active.map((purchase) => purchase.id));

  const allocations = new Map<string, PurchaseAllocation>(
    active.map((purchase) => [
      purchase.id,
      { purchase_id: purchase.id, total: purchase.total, linked: 0, allocated: 0, remaining: purchase.total },
    ]),
  );

  let unlinked = 0;
  let general = 0;

  for (const entry of live) {
    const amount = amountIn(entry, settlementCurrency);
    if (amount === 0) continue;

    const purchaseId = (entry.refs.purchase_id as string | null) ?? null;

    // The purchase's own entry is its total, which the allocation already starts from.
    if (entry.entry_type === 'purchase') continue;

    if (purchaseId && activeIds.has(purchaseId)) {
      // An explicit link always wins over the automatic allocation (FR-712).
      const allocation = allocations.get(purchaseId) as PurchaseAllocation;
      allocation.linked += amount;
      continue;
    }

    if (purchaseId && !activeIds.has(purchaseId)) {
      // An entry of a voided purchase belongs to General, not to a purchase nobody sees.
      general += amount;
      continue;
    }

    if (ALLOCATABLE_TYPES.includes(entry.entry_type)) {
      unlinked += amount;
      continue;
    }

    // Opening balances, unlinked adjustments and re-basing markers are never spread.
    general += amount;
  }

  // Oldest first, and never past zero: what a purchase cannot absorb flows to the next one,
  // and whatever is left over after the last purchase stays in General.
  let remainingToSpread = unlinked;
  for (const purchase of active) {
    const allocation = allocations.get(purchase.id) as PurchaseAllocation;
    const owedNow = allocation.total + allocation.linked;
    if (owedNow <= 0 || remainingToSpread === 0) {
      allocation.remaining = owedNow;
      continue;
    }
    // `remainingToSpread` is negative (payments reduce what we owe), so the share is the
    // smaller magnitude of the two.
    const share = Math.max(remainingToSpread, -owedNow);
    allocation.allocated = share;
    allocation.remaining = owedNow + share;
    remainingToSpread -= share;
  }
  general += remainingToSpread;

  return { purchases: [...allocations.values()], general, balance };
}

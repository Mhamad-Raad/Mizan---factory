import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { completePair } from '@mizan/money';
import { allocateOldestFirst } from './index.js';
import type { AllocationPurchase, LedgerEntry } from './index.js';

const RATE = '1310.0000';
let sequence = 0;

function entry(
  overrides: Partial<LedgerEntry> & Pick<LedgerEntry, 'entry_type'> & { amount: number },
): LedgerEntry {
  sequence += 1;
  const { amount, ...rest } = overrides;
  const pair = completePair({ amount, currency: 'IQD', rate: RATE, rate_source: 'company' });
  return {
    id: `e${sequence}`,
    owner_id: 'al-noor',
    amount_iqd: pair.amount_iqd,
    amount_usd_cents: pair.amount_usd_cents,
    entered_currency: pair.entered_currency,
    rate_iqd_per_usd: pair.rate_iqd_per_usd,
    rate_source: pair.rate_source,
    posting_seq: sequence,
    entry_date: '2026-09-18',
    reverses_entry_id: null,
    performed_by_user_id: 'sara',
    created_by: 'sara',
    created_at: new Date('2026-09-18T10:00:00Z'),
    note: null,
    refs: {},
    ...rest,
  };
}

function purchase(id: string, total: number, date: string, number: number, voided = false): AllocationPurchase {
  return { id, total, purchase_date: date, number, voided };
}

describe('per-purchase allocation, oldest first (FR-704, FR-712, A-29)', () => {
  it('spreads an unlinked payment over the oldest purchases first', () => {
    const purchases = [
      purchase('p1', 1_000_000, '2026-09-01', 1001),
      purchase('p2', 600_000, '2026-09-10', 1002),
    ];
    const entries = [
      entry({ entry_type: 'purchase', amount: 1_000_000, refs: { purchase_id: 'p1' } }),
      entry({ entry_type: 'purchase', amount: 600_000, refs: { purchase_id: 'p2' } }),
      // A lump sum that names no purchase — which is how supplier accounts are actually paid.
      entry({ entry_type: 'payment', amount: -1_200_000 }),
    ];

    const result = allocateOldestFirst(entries, purchases, 'IQD');

    expect(result.purchases).toEqual([
      { purchase_id: 'p1', total: 1_000_000, linked: 0, allocated: -1_000_000, remaining: 0 },
      { purchase_id: 'p2', total: 600_000, linked: 0, allocated: -200_000, remaining: 400_000 },
    ]);
    expect(result.general).toBe(0);
    expect(result.balance).toBe(400_000);
  });

  it('lets an explicit link win over the allocation', () => {
    const purchases = [
      purchase('p1', 1_000_000, '2026-09-01', 1001),
      purchase('p2', 600_000, '2026-09-10', 1002),
    ];
    const entries = [
      entry({ entry_type: 'purchase', amount: 1_000_000, refs: { purchase_id: 'p1' } }),
      entry({ entry_type: 'purchase', amount: 600_000, refs: { purchase_id: 'p2' } }),
      // Named the *newer* purchase deliberately: the allocation must not steal it.
      entry({ entry_type: 'payment', amount: -600_000, refs: { purchase_id: 'p2' } }),
    ];

    const result = allocateOldestFirst(entries, purchases, 'IQD');

    expect(result.purchases[0]).toMatchObject({ purchase_id: 'p1', remaining: 1_000_000, allocated: 0 });
    expect(result.purchases[1]).toMatchObject({ purchase_id: 'p2', linked: -600_000, remaining: 0 });
    expect(result.general).toBe(0);
  });

  it('keeps an opening balance, an unlinked adjustment and a re-basing marker in General', () => {
    const purchases = [purchase('p1', 500_000, '2026-09-01', 1001)];
    const entries = [
      entry({ entry_type: 'opening', amount: 300_000, note: 'owed at go-live' }),
      entry({ entry_type: 'purchase', amount: 500_000, refs: { purchase_id: 'p1' } }),
      entry({ entry_type: 'adjustment', amount: -50_000, note: 'agreed discount' }),
      entry({ entry_type: 'payment', amount: -200_000 }),
    ];

    const result = allocateOldestFirst(entries, purchases, 'IQD');

    expect(result.purchases[0]).toMatchObject({ remaining: 300_000, allocated: -200_000 });
    // 300,000 opening + (−50,000) adjustment: neither is ever spread over a purchase.
    expect(result.general).toBe(250_000);
    expect(result.balance).toBe(550_000);
  });

  it('puts the entries of a voided purchase in General, not on a purchase nobody sees', () => {
    const purchases = [
      purchase('p1', 400_000, '2026-09-01', 1001),
      purchase('p2', 700_000, '2026-09-05', 1002, true),
    ];
    const entries = [
      entry({ entry_type: 'purchase', amount: 400_000, refs: { purchase_id: 'p1' } }),
      // The voided purchase's own rows were reversed, but a payment made against it stands.
      entry({ entry_type: 'payment', amount: -100_000, refs: { purchase_id: 'p2' } }),
    ];

    const result = allocateOldestFirst(entries, purchases, 'IQD');

    expect(result.purchases).toHaveLength(1);
    expect(result.purchases[0]).toMatchObject({ purchase_id: 'p1', remaining: 400_000 });
    expect(result.general).toBe(-100_000);
    expect(result.balance).toBe(300_000);
  });

  it('ignores a reversed payment, because the money went back', () => {
    const purchases = [purchase('p1', 500_000, '2026-09-01', 1001)];
    const payment = entry({ entry_type: 'payment', amount: -500_000 });
    const entries = [
      entry({ entry_type: 'purchase', amount: 500_000, refs: { purchase_id: 'p1' } }),
      payment,
      entry({ entry_type: 'reversal', amount: 500_000, reverses_entry_id: payment.id, note: 'wrong company' }),
    ];

    const result = allocateOldestFirst(entries, purchases, 'IQD');

    expect(result.purchases[0]).toMatchObject({ remaining: 500_000, allocated: 0 });
    expect(result.balance).toBe(500_000);
  });

  it('shows an over-linked purchase as negative rather than pushing the excess elsewhere', () => {
    const purchases = [purchase('p1', 300_000, '2026-09-01', 1001)];
    const entries = [
      entry({ entry_type: 'purchase', amount: 300_000, refs: { purchase_id: 'p1' } }),
      entry({ entry_type: 'payment', amount: -500_000, refs: { purchase_id: 'p1' } }),
    ];

    const result = allocateOldestFirst(entries, purchases, 'IQD');

    expect(result.purchases[0]).toMatchObject({ remaining: -200_000 });
    expect(result.general).toBe(0);
    expect(result.balance).toBe(-200_000);
  });

  it('property: Σ remaining over active purchases + General = the company balance', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 5_000_000 }), { minLength: 0, maxLength: 6 }),
        fc.array(fc.integer({ min: 1, max: 6_000_000 }), { minLength: 0, maxLength: 6 }),
        fc.array(fc.integer({ min: -2_000_000, max: 2_000_000 }), { minLength: 0, maxLength: 4 }),
        fc.boolean(),
        (purchaseTotals, payments, others, voidLast) => {
          const purchases = purchaseTotals.map((total, index) =>
            purchase(
              `p${index}`,
              total,
              `2026-09-${String((index % 28) + 1).padStart(2, '0')}`,
              1001 + index,
              voidLast && index === purchaseTotals.length - 1,
            ),
          );

          const entries: LedgerEntry[] = [
            ...purchases.map((row) =>
              entry({ entry_type: 'purchase', amount: row.total, refs: { purchase_id: row.id } }),
            ),
            ...payments.map((amount) => entry({ entry_type: 'payment', amount: -amount })),
            ...others.map((amount) =>
              entry({ entry_type: 'adjustment', amount, note: 'correction' }),
            ),
          ];
          // A voided purchase's own entry is reversed, as the void algorithm does (2.5.3).
          const voided = purchases.find((row) => row.voided);
          if (voided) {
            const own = entries.find((row) => row.refs.purchase_id === voided.id) as LedgerEntry;
            entries.push(
              entry({
                entry_type: 'reversal',
                amount: -voided.total,
                reverses_entry_id: own.id,
                note: 'voided',
                refs: { purchase_id: voided.id },
              }),
            );
          }

          const result = allocateOldestFirst(entries, purchases, 'IQD');
          const sum = result.purchases.reduce((total, row) => total + row.remaining, 0) + result.general;
          expect(sum).toBe(result.balance);
        },
      ),
      { numRuns: 300 },
    );
  });
});

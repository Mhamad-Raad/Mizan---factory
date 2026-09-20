import { describe, expect, it } from 'vitest';
import { completePair } from '@mizan/money';
import { groupLedger, moneyMovementsOnly } from './index.js';
import type { LedgerEntry } from './index.js';

const RATE = '1310.0000';
let sequence = 0;

function row(overrides: Partial<LedgerEntry> & Pick<LedgerEntry, 'entry_type'> & { amount?: number }): LedgerEntry {
  sequence += 1;
  const { amount = 0, ...rest } = overrides;
  const pair = completePair({ amount, currency: 'IQD', rate: RATE, rate_source: 'global' });
  return {
    id: `e${sequence}`,
    owner_id: 'kawa',
    amount_iqd: pair.amount_iqd,
    amount_usd_cents: pair.amount_usd_cents,
    entered_currency: pair.entered_currency,
    rate_iqd_per_usd: pair.rate_iqd_per_usd,
    rate_source: pair.rate_source,
    posting_seq: sequence,
    entry_date: '2026-09-18',
    reverses_entry_id: null,
    performed_by_user_id: 'rebaz',
    created_by: 'rebaz',
    created_at: new Date('2026-09-18T10:00:00Z'),
    note: null,
    refs: {},
    ...rest,
  };
}

describe('ledger presentation (spec 2.4.5)', () => {
  it('shows an ordinary payment as one row with its running balance', () => {
    const groups = groupLedger(
      [
        row({ entry_type: 'order', amount: 801_250, refs: { order_id: 'o1' } }),
        row({ entry_type: 'payment', amount: -300_000, refs: { order_id: 'o1' } }),
      ],
      'IQD',
    );

    expect(groups.map((group) => group.kind)).toEqual(['entry', 'entry']);
    expect(groups[1]?.anchor.balance_after).toBe(501_250);
  });

  it('collapses a cash order and its settlement into one row naming the currency received', () => {
    const groups = groupLedger(
      [
        row({ entry_type: 'order', amount: 100_000, refs: { order_id: 'o2' } }),
        row({
          entry_type: 'cash_settlement',
          amount: -100_000,
          entered_currency: 'USD',
          refs: { order_id: 'o2' },
        }),
      ],
      'IQD',
    );

    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group?.kind).toBe('cash_order');
    expect(group?.amount_iqd).toBe(100_000);
    expect(group?.received_currency).toBe('USD');
    expect(group?.rows).toHaveLength(2);
    // The pair nets to zero, and the group sits where its later row sits.
    expect(group?.anchor.balance_after).toBe(0);
  });

  it('shows an edited order as one row carrying the new amounts, expandable to three', () => {
    const original = row({ entry_type: 'order', amount: 801_250, refs: { order_id: 'o3' } });
    const reversal = row({
      entry_type: 'reversal',
      amount: -801_250,
      reverses_entry_id: original.id,
      note: 'order edited',
      refs: { order_id: 'o3' },
    });
    const replacement = row({ entry_type: 'order', amount: 750_000, refs: { order_id: 'o3' } });

    const groups = groupLedger([original, reversal, replacement], 'IQD');

    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('edited');
    expect(groups[0]?.amount_iqd).toBe(750_000);
    expect(groups[0]?.rows.map((r) => r.entry.id)).toEqual([original.id, reversal.id, replacement.id]);
    expect(groups[0]?.anchor.balance_after).toBe(750_000);
  });

  it('keeps an order edited twice as one row with the latest amounts', () => {
    const first = row({ entry_type: 'order', amount: 800_000, refs: { order_id: 'o4' } });
    const reverseFirst = row({
      entry_type: 'reversal',
      amount: -800_000,
      reverses_entry_id: first.id,
      note: 'edited',
      refs: { order_id: 'o4' },
    });
    const second = row({ entry_type: 'order', amount: 700_000, refs: { order_id: 'o4' } });
    const reverseSecond = row({
      entry_type: 'reversal',
      amount: -700_000,
      reverses_entry_id: second.id,
      note: 'edited again',
      refs: { order_id: 'o4' },
    });
    const third = row({ entry_type: 'order', amount: 650_000, refs: { order_id: 'o4' } });

    const groups = groupLedger([first, reverseFirst, second, reverseSecond, third], 'IQD');

    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('edited');
    expect(groups[0]?.amount_iqd).toBe(650_000);
    expect(groups[0]?.rows).toHaveLength(5);
  });

  it('greys an undone entry, and hides only the 8-second undo by default', () => {
    const payment = row({ entry_type: 'payment', amount: -300_000 });
    const mistake = row({
      entry_type: 'reversal',
      amount: 300_000,
      reverses_entry_id: payment.id,
      note: 'wrong customer',
    });
    const undoneOrder = row({ entry_type: 'order', amount: 500_000, refs: { order_id: 'o5' } });
    const undo = row({
      entry_type: 'reversal',
      amount: -500_000,
      reverses_entry_id: undoneOrder.id,
      note: 'undo',
      refs: { order_id: 'o5' },
    });

    const groups = groupLedger([payment, mistake, undoneOrder, undo], 'IQD');

    expect(groups.map((group) => group.kind)).toEqual(['undone', 'undone']);
    expect(groups[0]?.hidden_by_default).toBe(false);
    expect(groups[1]?.hidden_by_default).toBe(true);
    expect(groups.every((group) => group.amount_iqd === 0)).toBe(true);
  });

  it('renders a settlement-currency change as its own marker row', () => {
    const groups = groupLedger(
      [
        row({ entry_type: 'order', amount: 100_000, refs: { order_id: 'o6' } }),
        row({
          entry_type: 'settlement_change',
          amount: -100_000,
          note: 'agreed with the customer',
          rate_source: 'manual',
        }),
      ],
      'IQD',
    );

    expect(groups.map((group) => group.kind)).toEqual(['entry', 'rebase']);
  });

  it('leaves the running balance of every group equal to its latest row', () => {
    const groups = groupLedger(
      [
        row({ entry_type: 'opening', amount: 450_000, note: 'go-live' }),
        row({ entry_type: 'order', amount: 801_250, refs: { order_id: 'o7' } }),
        row({ entry_type: 'payment', amount: -300_000, refs: { order_id: 'o7' } }),
      ],
      'IQD',
    );

    expect(groups.map((group) => group.anchor.balance_after)).toEqual([450_000, 1_251_250, 951_250]);
  });

  it('drops document rows for the "money movements only" toggle', () => {
    const groups = groupLedger(
      [
        row({ entry_type: 'order', amount: 801_250, refs: { order_id: 'o8' } }),
        row({ entry_type: 'payment', amount: -300_000, refs: { order_id: 'o8' } }),
        row({ entry_type: 'credit', amount: -1_000, note: 'settlement tolerance', refs: { order_id: 'o8' } }),
      ],
      'IQD',
    );

    const money = moneyMovementsOnly(groups);
    expect(money.map((group) => group.anchor.entry.entry_type)).toEqual(['payment', 'credit']);
  });
});

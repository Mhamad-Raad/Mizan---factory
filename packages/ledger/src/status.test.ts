import { describe, expect, it } from 'vitest';
import { completePair } from '@mizan/money';
import { InMemoryLedgerStore, LedgerWriter, orderStatus, orderStatusFromEntries } from './index.js';

const RATE = '1310.0000';
const TOTAL = 801_250;

describe('order status is derived, never set (FR-607, spec 2.4.3)', () => {
  it('names each state from the remaining amount', () => {
    expect(orderStatus({ voided: false, total: TOTAL, remaining: TOTAL })).toBe('unpaid');
    expect(orderStatus({ voided: false, total: TOTAL, remaining: 501_250 })).toBe('partially_paid');
    expect(orderStatus({ voided: false, total: TOTAL, remaining: 0 })).toBe('paid');
    expect(orderStatus({ voided: true, total: TOTAL, remaining: TOTAL })).toBe('void');
  });

  it('calls an over-settled order paid, because "partially paid" would be plainly wrong', () => {
    expect(orderStatus({ voided: false, total: TOTAL, remaining: -50_000 })).toBe('paid');
  });

  it('follows a borrowed order from unpaid through partial to paid', async () => {
    const store = new InMemoryLedgerStore();
    const writer = new LedgerWriter(store, () => 'IQD');
    const money = (amount: number) => completePair({ amount, currency: 'IQD', rate: RATE, rate_source: 'global' });

    await writer.write({
      owner_id: 'kawa',
      entry_type: 'order',
      money: money(TOTAL),
      entry_date: '2026-09-18',
      created_by: 'rebaz',
      refs: { order_id: 'o1' },
    });
    const unpaid = orderStatusFromEntries({
      entries: store.all(),
      order_id: 'o1',
      voided: false,
      total: TOTAL,
      settlement_currency: 'IQD',
    });
    expect(unpaid).toEqual({ status: 'unpaid', remaining: TOTAL });

    await writer.write({
      owner_id: 'kawa',
      entry_type: 'payment',
      money: money(-300_000),
      entry_date: '2026-09-19',
      created_by: 'rebaz',
      performed_by_user_id: 'rebaz',
      refs: { order_id: 'o1' },
    });
    expect(
      orderStatusFromEntries({
        entries: store.all(),
        order_id: 'o1',
        voided: false,
        total: TOTAL,
        settlement_currency: 'IQD',
      }),
    ).toEqual({ status: 'partially_paid', remaining: 501_250 });

    await writer.write({
      owner_id: 'kawa',
      entry_type: 'payment',
      money: money(-501_250),
      entry_date: '2026-09-20',
      created_by: 'rebaz',
      performed_by_user_id: 'rebaz',
      refs: { order_id: 'o1' },
    });
    expect(
      orderStatusFromEntries({
        entries: store.all(),
        order_id: 'o1',
        voided: false,
        total: TOTAL,
        settlement_currency: 'IQD',
      }),
    ).toEqual({ status: 'paid', remaining: 0 });
  });

  it('ignores entries of other orders and general payments not linked to one', async () => {
    const store = new InMemoryLedgerStore();
    const writer = new LedgerWriter(store, () => 'IQD');
    const money = (amount: number) => completePair({ amount, currency: 'IQD', rate: RATE, rate_source: 'global' });

    await writer.write({
      owner_id: 'kawa',
      entry_type: 'order',
      money: money(TOTAL),
      entry_date: '2026-09-18',
      created_by: 'rebaz',
      refs: { order_id: 'o1' },
    });
    // A payment recorded from the customer profile carries no order (FR-606, Q-10): it lowers
    // the balance and deliberately leaves every order's status alone (D-012).
    await writer.write({
      owner_id: 'kawa',
      entry_type: 'payment',
      money: money(-400_000),
      entry_date: '2026-09-19',
      created_by: 'rebaz',
      performed_by_user_id: 'rebaz',
    });

    expect(
      orderStatusFromEntries({
        entries: store.all(),
        order_id: 'o1',
        voided: false,
        total: TOTAL,
        settlement_currency: 'IQD',
      }),
    ).toEqual({ status: 'unpaid', remaining: TOTAL });
  });

  it('reads a cash order as paid the moment its settlement lands', async () => {
    const store = new InMemoryLedgerStore();
    const writer = new LedgerWriter(store, () => 'IQD');
    await writer.write({
      owner_id: 'walk-in',
      entry_type: 'order',
      money: completePair({ amount: 100_000, currency: 'IQD', rate: RATE, rate_source: 'global' }),
      entry_date: '2026-09-18',
      created_by: 'rebaz',
      refs: { order_id: 'o2' },
    });
    await writer.write({
      owner_id: 'walk-in',
      entry_type: 'cash_settlement',
      // Paid in dollars: the settlement side is the exact order total, the other side is what
      // was handed over, stored as a manual-rate pair (FR-604).
      money: completePair({
        amount: -100_000,
        currency: 'IQD',
        rate: RATE,
        rate_source: 'global',
        other_amount: -7_600,
      }),
      entry_date: '2026-09-18',
      created_by: 'rebaz',
      performed_by_user_id: 'rebaz',
      refs: { order_id: 'o2' },
    });

    const status = orderStatusFromEntries({
      entries: store.all(),
      order_id: 'o2',
      voided: false,
      total: 100_000,
      settlement_currency: 'IQD',
    });
    expect(status).toEqual({ status: 'paid', remaining: 0 });
  });
});

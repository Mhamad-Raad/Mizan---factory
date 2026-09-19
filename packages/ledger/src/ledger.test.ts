import { beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { completePair } from '@mizan/money';
import {
  AlreadyReversedError,
  InMemoryLedgerStore,
  LedgerWriteError,
  LedgerWriter,
  ReversalNotAllowedError,
  balanceAsOf,
  balanceOf,
  balanceOfRef,
  isLive,
  ledgerAuditChanges,
  liveEntries,
  runningBalances,
} from './index.js';
import type { NewLedgerEntry } from './index.js';

const RATE = '1310.0000';

function entry(amountIqd: number, overrides: Partial<NewLedgerEntry> = {}): NewLedgerEntry {
  return {
    owner_id: 'kawa',
    entry_type: 'order',
    money: completePair({ amount: amountIqd, currency: 'IQD', rate: RATE, rate_source: 'global' }),
    entry_date: '2026-09-18',
    created_by: 'sara',
    ...overrides,
  };
}

describe('the append-only writer (spec 2.4.1)', () => {
  let store: InMemoryLedgerStore;
  let writer: LedgerWriter;

  beforeEach(() => {
    store = new InMemoryLedgerStore();
    writer = new LedgerWriter(store, () => 'IQD');
  });

  it('records the balance before and after, which is what History shows', async () => {
    const first = await writer.write(entry(801_250));
    expect(first.balance).toEqual({ before: 0, after: 801_250, currency: 'IQD' });

    const payment = await writer.write(
      entry(-300_000, { entry_type: 'payment', performed_by_user_id: 'rebaz' }),
    );
    expect(payment.balance).toEqual({ before: 801_250, after: 501_250, currency: 'IQD' });
  });

  it('produces the audit payload of the worked example in spec 2.4.2', async () => {
    const writerForCompany = new LedgerWriter(new InMemoryLedgerStore(), () => 'IQD');
    await writerForCompany.write(entry(4_500_000, { owner_id: 'al-noor', entry_type: 'purchase' }));
    const adjustment = await writerForCompany.write(
      entry(-500_000, {
        owner_id: 'al-noor',
        entry_type: 'adjustment',
        note: 'Agreed discount for late delivery',
      }),
    );

    expect(ledgerAuditChanges(adjustment)).toEqual({
      balance: {
        before: { amount: 4_500_000, currency: 'IQD' },
        after: { amount: 4_000_000, currency: 'IQD' },
      },
      entry: {
        type: 'adjustment',
        amount_iqd: -500_000,
        amount_usd_cents: -38_168,
        rate: RATE,
        rate_source: 'global',
      },
    });
  });

  it('refuses the entry types that require a note (spec 2.4.1 rule 4)', async () => {
    for (const type of ['adjustment', 'credit', 'refund', 'opening']) {
      await expect(writer.write(entry(-1000, { entry_type: type }))).rejects.toThrow(LedgerWriteError);
      await expect(
        writer.write(entry(-1000, { entry_type: type, note: 'because' })),
      ).resolves.toBeTruthy();
    }
  });

  it('refuses a reversal without a target and a non-reversal with one', async () => {
    await expect(
      writer.write(entry(-1, { entry_type: 'reversal', note: 'x' })),
    ).rejects.toThrow(/must name the row it reverses/);
    await expect(
      writer.write(entry(-1, { entry_type: 'payment', reverses_entry_id: 'e1' })),
    ).rejects.toThrow(/only a reversal row/);
  });
});

describe('reversals (spec 2.4.1 rule 3)', () => {
  let store: InMemoryLedgerStore;
  let writer: LedgerWriter;

  beforeEach(() => {
    store = new InMemoryLedgerStore();
    writer = new LedgerWriter(store, () => 'IQD');
  });

  it('negates exactly, in both currencies, and returns the balance to where it was', async () => {
    const original = await writer.write(entry(801_250));
    const reversal = await writer.reverse('kawa', original.entry.id, {
      created_by: 'sara',
      note: 'undo',
    });

    expect(reversal.entry.amount_iqd).toBe(-801_250);
    expect(reversal.entry.amount_usd_cents).toBe(-original.entry.amount_usd_cents);
    expect(reversal.balance.after).toBe(0);
    expect(balanceOf(store.all(), 'IQD')).toBe(0);
    expect(balanceOf(store.all(), 'USD')).toBe(0);
  });

  it('keeps both rows forever — nothing is updated or deleted', async () => {
    const original = await writer.write(entry(801_250));
    await writer.reverse('kawa', original.entry.id, { created_by: 'sara', note: 'undo' });
    expect(store.all()).toHaveLength(2);
    expect(store.all()[0]?.amount_iqd).toBe(801_250);
  });

  it('refuses to reverse the same row twice', async () => {
    const original = await writer.write(entry(801_250));
    await writer.reverse('kawa', original.entry.id, { created_by: 'sara', note: 'undo' });
    await expect(
      writer.reverse('kawa', original.entry.id, { created_by: 'sara', note: 'again' }),
    ).rejects.toThrow(AlreadyReversedError);
  });

  it('refuses to reverse a reversal, and refuses a reversal without a note', async () => {
    const original = await writer.write(entry(801_250));
    const reversal = await writer.reverse('kawa', original.entry.id, { created_by: 'sara', note: 'undo' });
    await expect(
      writer.reverse('kawa', reversal.entry.id, { created_by: 'sara', note: 'nope' }),
    ).rejects.toThrow(ReversalNotAllowedError);
    await expect(
      writer.reverse('kawa', original.entry.id, { created_by: 'sara', note: '  ' }),
    ).rejects.toThrow(ReversalNotAllowedError);
  });

  it('never reverses a re-basing row — a mistake is corrected by another change (spec 2.3.5)', async () => {
    const rebase = await writer.write(
      entry(0, { entry_type: 'settlement_change', note: 'IQD → USD at 1,310' }),
    );
    await expect(
      writer.reverse('kawa', rebase.entry.id, { created_by: 'sara', note: 'oops' }),
    ).rejects.toThrow(/corrected by another change/);
  });

  it('knows which rows are still live, for the edit and void algorithm', async () => {
    const first = await writer.write(entry(100_000));
    const second = await writer.write(entry(200_000));
    await writer.reverse('kawa', first.entry.id, { created_by: 'sara', note: 'edit' });

    const all = store.all();
    expect(isLive(first.entry, all)).toBe(false);
    expect(isLive(second.entry, all)).toBe(true);
    expect(liveEntries(all).map((e) => e.amount_iqd)).toEqual([200_000]);
  });

  it('reverses every live row of a document in one call (spec 2.5.3 step 2)', async () => {
    await writer.write(entry(500_000, { refs: { order_id: 'o1' } }));
    await writer.write(entry(-100_000, { entry_type: 'payment', refs: { order_id: 'o1' } }));
    await writer.write(entry(900_000, { refs: { order_id: 'o2' } }));

    const reversals = await writer.reverseAllLive('kawa', (e) => e.refs.order_id === 'o1', {
      created_by: 'sara',
      note: 'edited',
    });

    expect(reversals).toHaveLength(2);
    expect(balanceOfRef(store.all(), 'order_id', 'o1', 'IQD')).toBe(0);
    expect(balanceOfRef(store.all(), 'order_id', 'o2', 'IQD')).toBe(900_000);
    expect(balanceOf(store.all(), 'IQD')).toBe(900_000);
  });

  it('property: any sequence of entries and reversals leaves entry + reversal = 0', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: -1_000_000, max: 1_000_000 }), { minLength: 1, maxLength: 12 }),
        async (amounts) => {
          const localStore = new InMemoryLedgerStore();
          const localWriter = new LedgerWriter(localStore, () => 'IQD');
          const written = [];
          for (const amount of amounts) written.push(await localWriter.write(entry(amount)));
          for (const result of written) {
            await localWriter.reverse('kawa', result.entry.id, { created_by: 'sara', note: 'x' });
          }
          expect(balanceOf(localStore.all(), 'IQD')).toBe(0);
          expect(balanceOf(localStore.all(), 'USD')).toBe(0);
        },
      ),
    );
  });
});

describe('running balance in posting order (spec 2.2.6, A-43)', () => {
  it('follows posting order, not business date, so it matches History', async () => {
    const store = new InMemoryLedgerStore(() => new Date('2026-09-18T10:00:00Z'));
    const writer = new LedgerWriter(store, () => 'IQD');

    const first = await writer.write(entry(500_000, { entry_date: '2026-09-18' }));
    // A back-dated row written afterwards: earlier business date, later posting position.
    const backdated = await writer.write(entry(200_000, { entry_date: '2026-09-01' }));

    const running = runningBalances(store.all(), 'IQD');
    expect(running.map((row) => row.balance_after)).toEqual([500_000, 700_000]);
    // Each row's running value equals the "after" its own audit row recorded.
    expect(running[0]?.balance_after).toBe(first.balance.after);
    expect(running[1]?.balance_after).toBe(backdated.balance.after);
  });

  it('rows written in one transaction share created_at, and posting_seq still orders them', async () => {
    const fixed = new Date('2026-09-18T10:00:00Z');
    const store = new InMemoryLedgerStore(() => fixed);
    const writer = new LedgerWriter(store, () => 'IQD');
    await writer.write(entry(801_250, { entry_type: 'order' }));
    await writer.write(entry(-801_250, { entry_type: 'cash_settlement' }));

    const rows = store.all();
    expect(rows[0]?.created_at.getTime()).toBe(rows[1]?.created_at.getTime());
    expect(rows[0]?.posting_seq).toBeLessThan(rows[1]?.posting_seq as number);
    expect(runningBalances(rows, 'IQD').map((r) => r.balance_after)).toEqual([801_250, 0]);
  });

  it('a date-sorted view shows the balance as of a date instead', async () => {
    const store = new InMemoryLedgerStore();
    const writer = new LedgerWriter(store, () => 'IQD');
    await writer.write(entry(500_000, { entry_date: '2026-09-18' }));
    await writer.write(entry(200_000, { entry_date: '2026-09-01' }));

    expect(balanceAsOf(store.all(), 'IQD', '2026-09-01')).toBe(200_000);
    expect(balanceAsOf(store.all(), 'IQD', '2026-09-18')).toBe(700_000);
  });
});

describe('the balance is a sum, never a column (rule 2)', () => {
  it('sums the settlement currency only', async () => {
    const store = new InMemoryLedgerStore();
    const usdWriter = new LedgerWriter(store, () => 'USD');
    const result = await usdWriter.write(entry(1_310_000, { owner_id: 'al-noor' }));
    expect(result.balance.currency).toBe('USD');
    expect(result.balance.after).toBe(100_000); // $1,000.00, not 1,310,000
  });
});

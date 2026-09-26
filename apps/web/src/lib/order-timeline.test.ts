import { describe, expect, it } from 'vitest';
import { timelineOf } from './order-timeline.js';
import type { OrderHistory } from './order-timeline.js';

type Item = OrderHistory['items'][number];
type Entry = OrderHistory['ledger_entries'][number];

const entry = (id: string, entry_type: string, amount_iqd: number, reverses?: string): Entry => ({
  id,
  entry_type,
  entry_date: '2026-09-26',
  amount_iqd,
  amount_usd_cents: Math.round(amount_iqd / 13.1),
  note: null,
  voucher_number: null,
  reverses_entry_id: reverses ?? null,
});

const audit = (id: string, at: string, over: Partial<Item> = {}): Item => ({
  id,
  action: 'create',
  entity_type: 'order',
  occurred_at: at,
  actor_display_name: 'Dara',
  note: null,
  changes: null,
  related: null,
  ...over,
});

const money = (id: string, at: string, ledger: Entry): Item =>
  audit(id, at, {
    action: 'ledger_entry',
    entity_type: 'customer',
    changes: {
      entry: { type: ledger.entry_type, amount_iqd: ledger.amount_iqd, amount_usd_cents: 0 },
    },
    related: { ledger_entry_id: ledger.id },
  });

/**
 * An order's History tab lists the money recorded against it (the client asked for payments in
 * History), but not the entries that only post the order itself — those are already told by
 * "created", "changed" and "voided", and listing them would read as money that changed hands.
 */
describe("the order's History timeline", () => {
  const posted = entry('e1', 'order', 730_625);
  const paid = entry('e2', 'payment', -300_000);
  const editReversal = entry('e3', 'reversal', -730_625, 'e1');
  const reposted = entry('e4', 'order', 700_000);
  const paymentReversal = entry('e5', 'reversal', 300_000, 'e2');

  const history: OrderHistory = {
    items: [
      money('a6', '2026-09-26T10:06:00Z', paymentReversal),
      money('a5', '2026-09-26T10:05:00Z', reposted),
      money('a4', '2026-09-26T10:04:00Z', editReversal),
      audit('a3', '2026-09-26T10:04:00Z', { action: 'update' }),
      money('a2', '2026-09-26T10:02:00Z', paid),
      money('a1', '2026-09-26T10:00:00Z', posted),
      audit('a0', '2026-09-26T10:00:00Z'),
    ],
    payment_type_changes: [
      {
        id: 't1',
        from_type: 'borrowed',
        to_type: 'cash',
        note: 'paid at the counter',
        changed_at: '2026-09-26T10:03:00Z',
        changed_by_name: 'Dara',
      },
    ],
    ledger_entries: [posted, paid, editReversal, reposted, paymentReversal],
  };

  const ids = timelineOf(history).map((row) =>
    row.kind === 'audit' ? row.entry.id : row.change.id,
  );

  it('shows the payment, and a reversed payment, as the money they are', () => {
    expect(ids).toContain('a2');
    expect(ids).toContain('a6');
  });

  it("leaves out the order's own postings, and an edit's reversal of them", () => {
    expect(ids).not.toContain('a1');
    expect(ids).not.toContain('a4');
    expect(ids).not.toContain('a5');
  });

  it('merges the payment-type changes in, newest first', () => {
    expect(ids).toEqual(['a6', 'a3', 't1', 'a2', 'a0']);
  });

  it('is empty before the History has loaded', () => {
    expect(timelineOf(undefined)).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import type { RequestContext } from '../common/request-context.js';
import { stripHistory } from './history-fields.js';

const reader = (permissions: string[]): RequestContext => ({
  requestId: 'r',
  userId: 'u',
  role: 'employee',
  permissions: new Set(permissions),
  sessionId: 's',
  authMethod: 'password',
  ip: null,
  userAgent: null,
});

const ledgerRow = (type: string, related: Record<string, string | null>) => ({
  entity_type: 'customer',
  changes: {
    balance: { before: { amount: 0 }, after: { amount: 5_000 } },
    entry: { type, amount_iqd: 5_000, amount_usd_cents: 382, rate: '1310', rate_source: 'global' },
  },
  related,
});

describe('History field rules for ledger rows', () => {
  it('keeps the payments against the order on its own History tab, and nothing else', () => {
    const rows = [
      ledgerRow('payment', { order_id: 'order-1' }),
      ledgerRow('payment', { order_id: 'order-2' }),
      ledgerRow('damage', { order_id: 'order-1', damage_id: 'damage-1' }),
    ];
    const [own, other, damage] = stripHistory(reader([]), rows, { ownOrderId: 'order-1' });
    expect(own?.changes.entry).toMatchObject({ amount_iqd: 5_000 });
    expect(other?.changes.entry).not.toHaveProperty('amount_iqd');
    // What a damage cost us is a bought figure wherever it is read.
    expect(damage?.changes.entry).not.toHaveProperty('amount_iqd');
    expect(damage?.changes).not.toHaveProperty('balance');
  });

  it('treats the reversal of a purchase as a bought figure, and a payment as money', () => {
    const company = (type: string, related: Record<string, string | null>) => ({
      ...ledgerRow(type, related),
      entity_type: 'company',
    });
    const [reversal, payment] = stripHistory(reader(['fields.see_company_balances']), [
      company('reversal', { purchase_id: 'p-1' }),
      company('payment', { purchase_id: null }),
    ]);
    expect(reversal?.changes.entry).toEqual({ type: 'reversal', rate: '1310', rate_source: 'global' });
    expect(payment?.changes.entry).toMatchObject({ amount_iqd: 5_000, amount_usd_cents: 382 });
  });

  it('strips the grouped rows of an entry as well as the entry', () => {
    const [grouped] = stripHistory(reader([]), [
      { entity_type: 'purchase', changes: {}, rows: [{ entity_type: 'purchase', changes: { unit_price: 1 } }] },
    ]);
    expect(grouped?.rows?.[0]?.changes).toEqual({});
  });
});

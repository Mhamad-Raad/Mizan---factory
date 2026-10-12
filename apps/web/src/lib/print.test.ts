import { beforeEach, describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { PRINT_LIMIT, documentOfLedgerRow, usePrintQueue } from './print.js';
import type { PrintDocument } from './print.js';
import { entryTitle } from './entry-title.js';
import { NOTHING_PAID, paidNowBody, paidNowValid } from '../components/BuyFields.js';

describe('what a row of an account prints as (D-086)', () => {
  it('prints a purchase row on the buying side as the purchase’s own receipt', () => {
    expect(
      documentOfLedgerRow('buying', 'acct', { entry_id: 'e1', entry_type: 'purchase', purchase_id: 'p1' }),
    ).toEqual({ kind: 'purchase', id: 'p1' });
  });

  it('prints an order row, and a cash order’s settlement, as the order’s receipt', () => {
    for (const entry_type of ['order', 'cash_settlement']) {
      expect(documentOfLedgerRow('sales', 'acct', { entry_id: 'e1', entry_type, order_id: 'o1' })).toEqual({
        kind: 'order',
        id: 'o1',
      });
    }
  });

  it('prints every other row — a payment that names a document included — as a voucher of its own', () => {
    expect(
      documentOfLedgerRow('buying', 'acct', { entry_id: 'e2', entry_type: 'payment', purchase_id: 'p1' }),
    ).toEqual({ kind: 'voucher', side: 'buying', accountId: 'acct', entryId: 'e2' });
    expect(documentOfLedgerRow('sales', 'acct', { entry_id: 'e3', entry_type: 'payment', order_id: 'o1' })).toEqual({
      kind: 'voucher',
      side: 'sales',
      accountId: 'acct',
      entryId: 'e3',
    });
  });

  it('never takes a sales row for a purchase, or a buying row for an order', () => {
    expect(documentOfLedgerRow('sales', 'acct', { entry_id: 'e4', entry_type: 'purchase', purchase_id: 'p1' }).kind).toBe(
      'voucher',
    );
    expect(documentOfLedgerRow('buying', 'acct', { entry_id: 'e5', entry_type: 'order', order_id: 'o1' }).kind).toBe(
      'voucher',
    );
  });
});

describe('the print queue', () => {
  beforeEach(() => usePrintQueue.setState({ job: null }));

  it('carries at most one print’s worth of documents', () => {
    const many: PrintDocument[] = Array.from({ length: PRINT_LIMIT + 7 }, (_, index) => ({
      kind: 'purchase',
      id: String(index),
    }));
    usePrintQueue.getState().start(many);
    expect(usePrintQueue.getState().job?.documents).toHaveLength(PRINT_LIMIT);
  });

  it('lets a new request replace one still loading, and a finished old one not clear the new', () => {
    usePrintQueue.getState().start([{ kind: 'order', id: 'a' }]);
    const first = usePrintQueue.getState().job?.id as number;
    usePrintQueue.getState().start([{ kind: 'order', id: 'b' }]);
    usePrintQueue.getState().finish(first);
    expect(usePrintQueue.getState().job?.documents).toEqual([{ kind: 'order', id: 'b' }]);
  });
});

describe('what a row of an account is called (D-086)', () => {
  // A stand-in for i18next that shows which key and number it was asked for.
  const t = ((key: string, options?: { number?: string }) =>
    options?.number ? `${key}(${options.number})` : key) as unknown as TFunction;
  const id = (value: number) => String(value);

  it('names the document alone for the row that is the document', () => {
    expect(entryTitle({ entry_type: 'order', order_number: 40 }, 'customers', t, id)).toBe('orders:number(40)');
    expect(entryTitle({ entry_type: 'purchase', purchase_number: 12 }, 'companies', t, id)).toBe(
      'purchases:number(12)',
    );
  });

  it('names what happened and the document it was against, for money', () => {
    expect(entryTitle({ entry_type: 'payment', purchase_number: 12 }, 'companies', t, id)).toBe(
      'companies:entry.payment · purchases:number(12)',
    );
    expect(entryTitle({ entry_type: 'credit' }, 'customers', t, id)).toBe('customers:entry.credit');
  });
});

describe('"paid now" on a purchase (D-085)', () => {
  it('sends nothing for "not yet", the whole for "all of it", and the typed part otherwise', () => {
    expect(paidNowBody(NOTHING_PAID)).toBeNull();
    expect(paidNowBody({ ...NOTHING_PAID, mode: 'all' })).toEqual({ in_full: true });
    expect(
      paidNowBody({ mode: 'part', amount: { amount: 5_000, currency: 'USD', other_amount: null } }),
    ).toEqual({ amount: 5_000, currency: 'USD', other_amount: null });
  });

  it('refuses a part with nothing typed, or nothing above zero', () => {
    expect(paidNowValid({ mode: 'part', amount: { amount: null, currency: 'IQD' } })).toBe(false);
    expect(paidNowValid({ mode: 'part', amount: { amount: 0, currency: 'IQD' } })).toBe(false);
    expect(paidNowValid({ mode: 'part', amount: { amount: 1, currency: 'IQD' } })).toBe(true);
    expect(paidNowValid(NOTHING_PAID)).toBe(true);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { PRINT_LIMIT, documentOfLedgerRow, requiredFor, usePrintQueue } from './print.js';
import { owedFigures } from './owed.js';
import { documentRateOf } from './accounts.js';
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
    expect(paidNowBody(NOTHING_PAID, 'IQD')).toBeNull();
    expect(paidNowBody({ ...NOTHING_PAID, mode: 'all', paidIn: 'USD' }, 'IQD')).toEqual({ in_full: true, currency: 'USD' });
    // Not chosen: it follows the company's own currency, however the company was reached.
    expect(paidNowBody({ ...NOTHING_PAID, mode: 'all' }, 'USD')).toEqual({ in_full: true, currency: 'USD' });
    expect(
      paidNowBody({ mode: 'part', amount: { amount: 5_000, currency: 'USD', other_amount: null }, paidIn: 'IQD' }, 'IQD'),
    ).toEqual({ amount: 5_000, currency: 'USD', other_amount: null });
  });

  it('refuses a part with nothing typed, or nothing above zero', () => {
    expect(paidNowValid({ ...NOTHING_PAID, mode: 'part', amount: { amount: null, currency: 'IQD' } })).toBe(false);
    expect(paidNowValid({ ...NOTHING_PAID, mode: 'part', amount: { amount: 0, currency: 'IQD' } })).toBe(false);
    expect(paidNowValid({ ...NOTHING_PAID, mode: 'part', amount: { amount: 1, currency: 'IQD' } })).toBe(true);
    expect(paidNowValid(NOTHING_PAID)).toBe(true);
  });
});

describe('what each printed document needs the reader to hold (D-086, second review)', () => {
  // The permissions of the routes each document is read from, as the API declares them.
  it('names the route permissions of every kind of document', () => {
    expect(requiredFor({ kind: 'order', id: 'o' })).toEqual(['orders.view']);
    expect(requiredFor({ kind: 'purchase', id: 'p' })).toEqual(['purchases.view']);
    expect(requiredFor({ kind: 'voucher', side: 'sales', accountId: 'a', entryId: 'e' })).toEqual([
      'customers.view',
      'fields.see_customer_balances',
    ]);
    expect(requiredFor({ kind: 'voucher', side: 'buying', accountId: 'a', entryId: 'e' })).toEqual([
      'companies.view',
      'fields.see_company_balances',
    ]);
    expect(requiredFor({ kind: 'statement', accountId: 'a', from: 'x', to: 'y', sides: ['sales', 'buying'] })).toEqual([
      'customers.view',
      'fields.see_customer_balances',
      'companies.view',
      'fields.see_company_balances',
    ]);
  });

  it('prints a row as a voucher when its order or purchase is not the reader’s to open', () => {
    expect(
      documentOfLedgerRow('buying', 'acct', { entry_id: 'e1', entry_type: 'purchase', purchase_id: 'p1' }, false),
    ).toEqual({ kind: 'voucher', side: 'buying', accountId: 'acct', entryId: 'e1' });
    expect(
      documentOfLedgerRow('sales', 'acct', { entry_id: 'e2', entry_type: 'order', order_id: 'o1' }, false).kind,
    ).toBe('voucher');
  });
});

describe('what we owe the companies, as figures (D-085)', () => {
  it('shows each currency the companies are kept in, never one sum of both', () => {
    const figures = owedFigures({ amount_iqd: 150_000, amount_usd_cents: 10_000 }, '1500');
    expect(figures.map((figure) => [figure.primary, figure.amount])).toEqual([
      ['IQD', 150_000],
      ['USD', 10_000],
    ]);
    expect(figures[1]?.pair).toEqual({ amount_iqd: 150_000, amount_usd_cents: 10_000 });
  });

  it('invents no other side without a rate, and shows one zero when nothing is owed', () => {
    expect(owedFigures({ amount_iqd: 2_000_000, amount_usd_cents: 0 }, null)).toEqual([
      { primary: 'IQD', amount: 2_000_000, pair: null },
    ]);
    expect(owedFigures({ amount_iqd: 0, amount_usd_cents: 0 }, null)).toEqual([{ primary: 'IQD', amount: 0, pair: null }]);
  });
});

describe('the rate a purchase is valued at, and what it is called (D-085)', () => {
  const t = (key: string) => key;
  it('takes a typed rate first, then the company’s own, then the system’s — and names it', () => {
    const own = { rate: { rate_iqd_per_usd: '1450', since: null, is_customer_rate: true } };
    const global = { rate: { rate_iqd_per_usd: '1310', since: null, is_customer_rate: false } };
    expect(documentRateOf(own, { rate: '1500', label: 'typed' }, '1310', t)).toEqual({
      rate: '1500',
      source: 'manual',
      label: 'typed',
    });
    expect(documentRateOf(own, null, '1310', t)).toEqual({ rate: '1450', source: 'company', label: 'glossary:customer_rate' });
    expect(documentRateOf(global, null, '1310', t).label).toBe('glossary:system_rate');
    expect(documentRateOf(undefined, null, null, t).rate).toBeNull();
  });
});

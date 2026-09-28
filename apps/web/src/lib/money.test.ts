import { describe, expect, it } from 'vitest';
import { convert } from '@mizan/money';
import { bothOf, toMoneyBody, usableRate } from './money.js';

describe('a rate typed for one order (review)', () => {
  it('is used only once it is a rate above zero', () => {
    expect(usableRate('1500')).toBe('1500');
    expect(usableRate(' 1480.25 ')).toBe('1480.25');
    expect(usableRate('1480.1234')).toBe('1480.1234');
  });

  it('is never "0", "." or a half-typed figure — the kernel throws on those, and so did the form', () => {
    for (const text of ['', '0', '0.0', '.', '1500.', '.5', '1,500', '-1', '1480.12345', 'abc']) {
      expect(usableRate(text)).toBeNull();
    }
  });
});

describe('a figure held in one currency, with the other derived', () => {
  it('keeps the held side exactly and converts the other at the rate', () => {
    expect(bothOf(150_000, 'IQD', '1500')).toEqual({ amount_iqd: 150_000, amount_usd_cents: 10_000 });
    expect(bothOf(10_000, 'USD', '1500')).toEqual({ amount_iqd: 150_000, amount_usd_cents: 10_000 });
  });
});

describe('a money value for the API', () => {
  it('is null when nothing was typed, and carries the typed side and any overwritten other', () => {
    expect(toMoneyBody({ amount: null, currency: 'IQD' })).toBeNull();
    expect(toMoneyBody({ amount: 1250, currency: 'USD' })).toEqual({ amount: 1250, currency: 'USD', other_amount: null });
    expect(toMoneyBody({ amount: 1250, currency: 'USD', other_amount: 18_000 })).toEqual({
      amount: 1250,
      currency: 'USD',
      other_amount: 18_000,
    });
  });
});

/**
 * The order form's discount (review): each line's dinar discount is summed and sent as one
 * figure, which the server converts once (`discountPair`). The preview used to convert each line
 * and add the cents, which is not the same number.
 */
describe('the dollar side of a discount', () => {
  it('is the sum converted once, which a per-line conversion does not always equal', () => {
    const rate = '1310';
    const lines = [1000, 1000, 1000];
    const perLine = lines.reduce((sum, iqd) => sum + convert(iqd, 'IQD', rate), 0);
    const once = convert(lines.reduce((sum, iqd) => sum + iqd, 0), 'IQD', rate);
    expect(once).toBe(229);
    expect(perLine).toBe(228);
  });
});

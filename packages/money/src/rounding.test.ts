import { describe, expect, it } from 'vitest';
import { roundOrderTotals } from './index.js';

/** The order-total rounding of D-065, with hand-computed expectations. */
describe('an order total rounds up to the next 250 dinars', () => {
  const rate = '1310.0000';

  it('rounds 630 up to 750, and moves the dollars by the 120 it added', () => {
    // 120 د.ع at 1,310 = 9.16 cents → 9 cents.
    expect(roundOrderTotals({ total_iqd: 630, total_usd_cents: 48 }, rate)).toEqual({
      total_iqd: 750,
      total_usd_cents: 57,
      rounding_iqd: 120,
      rounding_usd_cents: 9,
    });
  });

  it('leaves a round figure alone', () => {
    expect(roundOrderTotals({ total_iqd: 1_000, total_usd_cents: 76 }, rate)).toMatchObject({
      total_iqd: 1_000,
      rounding_iqd: 0,
      rounding_usd_cents: 0,
    });
  });

  it('rounds up by as little as one dinar short, and as much as 249', () => {
    expect(roundOrderTotals({ total_iqd: 1_249, total_usd_cents: 95 }, rate).total_iqd).toBe(1_250);
    expect(roundOrderTotals({ total_iqd: 1_001, total_usd_cents: 76 }, rate)).toMatchObject({
      total_iqd: 1_250,
      rounding_iqd: 249,
    });
  });

  it('never rounds a total of nothing', () => {
    expect(roundOrderTotals({ total_iqd: 0, total_usd_cents: 0 }, rate).rounding_iqd).toBe(0);
  });
});

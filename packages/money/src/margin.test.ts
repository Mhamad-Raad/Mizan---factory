import { describe, expect, it } from 'vitest';
import { lineMargin, marginTotals } from './index.js';
import type { MarginLine } from './index.js';

/**
 * The margin formula of FR-1005 and 2.11, with hand-computed expectations — which the
 * specification asks for by name ("covered by a unit test with hand-computed expectations").
 */

const RATE = '1310.0000';

function line(overrides: Partial<MarginLine> = {}): MarginLine {
  return {
    priced_measure: 'kg',
    qty_count: null,
    qty_kg: '5000.000',
    unit_price_iqd: 850,
    unit_price_usd_cents: 65,
    price_entered_currency: 'IQD',
    rate_iqd_per_usd: RATE,
    cost_unit_iqd: 700,
    cost_unit_usd_cents: 53,
    cost_source: 'month',
    ...overrides,
  };
}

describe('the margin of one order line (FR-1005, spec 2.11)', () => {
  it('computes in the entered currency and converts the result, never the other way', () => {
    // (850 − 700) × 5,000 = 750,000 د.ع; ÷ 1,310 = $572.52.
    // Computing in dollars instead would give (65 − 53) × 5,000 = $600 — a different answer
    // from rounded unit prices, which is exactly what the one-computation rule avoids.
    expect(lineMargin(line())).toEqual({
      margin_iqd: 750_000,
      margin_usd_cents: 57_252,
      price_fallback: false,
    });
  });

  it('computes in dollars when the price was typed in dollars', () => {
    // (100 − 80) × 40 = $8.00 → 20 × 40 = 800¢, and 800¢ at 1,310 is 10,480 د.ع.
    expect(
      lineMargin(
        line({
          priced_measure: 'count',
          qty_count: 40,
          qty_kg: null,
          price_entered_currency: 'USD',
          unit_price_usd_cents: 100,
          unit_price_iqd: 1_310,
          cost_unit_usd_cents: 80,
          cost_unit_iqd: 1_048,
        }),
      ),
    ).toEqual({ margin_iqd: 10_480, margin_usd_cents: 800, price_fallback: false });
  });

  it('never disagrees in sign between the two currencies', () => {
    // Sold below cost: both currencies must be negative, which is only guaranteed because the
    // dollar figure is a conversion of the dinar one.
    const loss = lineMargin(line({ unit_price_iqd: 650, unit_price_usd_cents: 50 }));
    expect(loss?.margin_iqd).toBeLessThan(0);
    expect(loss?.margin_usd_cents).toBeLessThan(0);
    expect(loss).toEqual({ margin_iqd: -250_000, margin_usd_cents: -19_084, price_fallback: false });
  });

  it('flags a cost that came from an earlier month', () => {
    expect(lineMargin(line({ cost_source: 'fallback' }))?.price_fallback).toBe(true);
  });

  it('has no margin at all when the line carries no cost snapshot', () => {
    expect(lineMargin(line({ cost_source: 'none', cost_unit_iqd: null, cost_unit_usd_cents: null }))).toBeNull();
    // …and not even when the columns are there but the source says they are not costs.
    expect(lineMargin(line({ cost_source: 'none' }))).toBeNull();
  });

  it('rounds half away from zero, like every other amount in the system', () => {
    // (851 − 700) × 0.005 kg = 0.755 → 1 د.ع.
    expect(lineMargin(line({ qty_kg: '0.005', unit_price_iqd: 851 }))?.margin_iqd).toBe(1);
  });
});

describe('the margin of a group of lines (spec 2.11)', () => {
  it('sums per currency and counts what it could not value', () => {
    const totals = marginTotals([
      line(),
      line({ qty_kg: '10.000', cost_source: 'fallback' }),
      line({ cost_source: 'none', cost_unit_iqd: null, cost_unit_usd_cents: null }),
    ]);

    expect(totals).toEqual({
      // 750,000 + (150 × 10) = 751,500 د.ع.
      margin_iqd: 751_500,
      margin_usd_cents: 57_252 + 115,
      lines_without_cost: 1,
      lines_with_fallback: 1,
      lines: 3,
    });
  });

  it('is zero for no lines, rather than undefined', () => {
    expect(marginTotals([])).toEqual({
      margin_iqd: 0,
      margin_usd_cents: 0,
      lines_without_cost: 0,
      lines_with_fallback: 0,
      lines: 0,
    });
  });
});

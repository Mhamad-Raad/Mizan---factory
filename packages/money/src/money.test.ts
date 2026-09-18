import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  completePair,
  computeLineTotals,
  convert,
  documentTotals,
  impliedRate,
  iqdToUsdCents,
  negatePair,
  recomputeLineForDocumentRate,
  roundHalfAwayFromZero,
  settleInFull,
  sumAmounts,
  usdCentsToIqd,
  withinTolerance,
} from './index.js';
import type { LineInput } from './index.js';

const RATE = '1310.0000';

describe('rounding (spec 2.3.4, A-10)', () => {
  it('rounds half away from zero in both directions', () => {
    expect(roundHalfAwayFromZero('0.5')).toBe(1);
    expect(roundHalfAwayFromZero('-0.5')).toBe(-1);
    expect(roundHalfAwayFromZero('2.5')).toBe(3);
    expect(roundHalfAwayFromZero('-2.5')).toBe(-3);
    expect(roundHalfAwayFromZero('0.4999')).toBe(0);
  });

  it('property: round(x) + round(-x) = 0', () => {
    fc.assert(
      fc.property(fc.double({ min: -1e9, max: 1e9, noNaN: true }), (x) => {
        expect(roundHalfAwayFromZero(String(x)) + roundHalfAwayFromZero(String(-x))).toBe(0);
      }),
    );
  });

  it('refuses a non-integer or unsafe amount at the boundary', () => {
    expect(() => sumAmounts([1.5])).toThrow(RangeError);
    expect(() => sumAmounts([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
  });
});

describe('conversion (spec 2.3.4) — the figures the specification itself quotes', () => {
  it('100,000 IQD at 1,310 is 7,634 cents (FR-612)', () => {
    expect(iqdToUsdCents(100_000, RATE)).toBe(7_634);
  });

  it('4,500,000 IQD at 1,310 is $3,435.11 (spec 2.3.5)', () => {
    expect(iqdToUsdCents(4_500_000, RATE)).toBe(343_511);
  });

  it('1,000,000 IQD at 1,310 is $763.36 (flow 3.5.3)', () => {
    expect(iqdToUsdCents(1_000_000, RATE)).toBe(76_336);
  });

  it('-500,000 IQD at 1,310 is -$381.68 (the adjustment worked example, spec 2.4.2)', () => {
    expect(iqdToUsdCents(-500_000, RATE)).toBe(-38_168);
  });

  it('converts back the other way', () => {
    expect(usdCentsToIqd(76_336, RATE)).toBe(1_000_002);
  });

  it('property: conversion is monotonic and sign-preserving', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e12 }), fc.integer({ min: 0, max: 1e12 }), (a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        expect(iqdToUsdCents(low, RATE)).toBeLessThanOrEqual(iqdToUsdCents(high, RATE));
        expect(iqdToUsdCents(-low, RATE)).toBe(-iqdToUsdCents(low, RATE));
      }),
    );
  });

  it('derives the implied rate from two typed amounts', () => {
    // 1,000,000 IQD converts to 76,336c at 1,310, but the rounded cents imply 1309.9979 —
    // the asymmetry is why a stored pair keeps the rate that produced it (spec 2.3.2).
    expect(impliedRate(1_000_000, 76_336)).toBe('1309.9979');
    expect(impliedRate(1_305_000, 100_000)).toBe('1305.0000');
  });

  it('refuses a rate of zero or less', () => {
    expect(() => convert(1000, 'IQD', '0')).toThrow(RangeError);
  });
});

describe('the entered currency is authoritative (spec 2.3.4, A-41)', () => {
  const perKgLine = (overrides: Partial<LineInput> = {}): LineInput => ({
    priced_measure: 'kg',
    qty_count: null,
    qty_kg: '5000.000',
    unit_price_iqd: 850,
    unit_price_usd_cents: 65,
    price_entered_currency: 'IQD',
    document_rate: RATE,
    document_rate_source: 'global',
    ...overrides,
  });

  it('850 IQD/kg x 5,000 kg is $3,244.27, not the $3,250 a rounded unit price would give', () => {
    const totals = computeLineTotals(perKgLine());
    expect(totals.line_total_iqd).toBe(4_250_000);
    expect(totals.line_total_usd_cents).toBe(324_427);
    // The drift the rule exists to prevent:
    expect(65 * 5000).toBe(325_000);
  });

  it('reproduces the wireframe 3.4.1 order exactly', () => {
    const copper = computeLineTotals({
      priced_measure: 'kg',
      qty_count: null,
      qty_kg: '12.500',
      unit_price_iqd: 6_500,
      unit_price_usd_cents: 496,
      price_entered_currency: 'IQD',
      document_rate: RATE,
      document_rate_source: 'global',
    });
    const steel = computeLineTotals({
      priced_measure: 'count',
      qty_count: 40,
      qty_kg: '96.000',
      unit_price_iqd: 18_000,
      unit_price_usd_cents: 1_374,
      price_entered_currency: 'IQD',
      document_rate: RATE,
      document_rate_source: 'global',
    });
    expect(copper.line_total_iqd).toBe(81_250);
    expect(copper.line_total_usd_cents).toBe(6_202); // $62.02 on the wireframe
    expect(steel.line_total_iqd).toBe(720_000);
    expect(steel.line_total_usd_cents).toBe(54_962); // $549.62 on the wireframe

    const totals = documentTotals([copper, steel]);
    expect(totals.total_iqd).toBe(801_250);
    expect(totals.total_usd_cents).toBe(61_164); // $611.64 on the wireframe
  });

  it('prices a line entered in USD from the USD side', () => {
    const totals = computeLineTotals({
      priced_measure: 'count',
      qty_count: 40,
      qty_kg: null,
      unit_price_iqd: 18_000,
      unit_price_usd_cents: 1_374,
      price_entered_currency: 'USD',
      document_rate: RATE,
      document_rate_source: 'company',
    });
    expect(totals.line_total_usd_cents).toBe(54_960);
    expect(totals.line_total_iqd).toBe(719_976);
    expect(totals.rate_source).toBe('company');
  });

  it('when both unit prices are typed, each total is its own product at the implied rate', () => {
    const totals = computeLineTotals(
      perKgLine({ qty_kg: '10.000', unit_price_iqd: 6_500, unit_price_usd_cents: 500, both_prices_typed: true }),
    );
    expect(totals.line_total_iqd).toBe(65_000);
    expect(totals.line_total_usd_cents).toBe(5_000);
    expect(totals.rate_source).toBe('manual');
    expect(totals.rate_iqd_per_usd).toBe('1300.0000');
  });

  it('subtracts the discount per currency, never by converting the other total', () => {
    const line = { line_total_iqd: 801_250, line_total_usd_cents: 61_164 };
    expect(documentTotals([line], { discount_iqd: 1_250, discount_usd_cents: 95 })).toEqual({
      total_iqd: 800_000,
      total_usd_cents: 61_069,
    });
  });

  it('property: a document total is the sum of its lines in each currency', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 5_000_000 }), { minLength: 1, maxLength: 20 }),
        (prices) => {
          const lines = prices.map((price) =>
            computeLineTotals({
              priced_measure: 'count',
              qty_count: 3,
              qty_kg: null,
              unit_price_iqd: price,
              unit_price_usd_cents: 0,
              price_entered_currency: 'IQD',
              document_rate: RATE,
              document_rate_source: 'global',
            }),
          );
          const totals = documentTotals(lines);
          expect(totals.total_iqd).toBe(lines.reduce((s, l) => s + l.line_total_iqd, 0));
          expect(totals.total_usd_cents).toBe(lines.reduce((s, l) => s + l.line_total_usd_cents, 0));
        },
      ),
    );
  });
});

describe('the rate for this document (spec 2.3.3)', () => {
  const line = {
    ...computeLineTotals({
      priced_measure: 'kg',
      qty_count: null,
      qty_kg: '10.000',
      unit_price_iqd: 6_500,
      unit_price_usd_cents: 496,
      price_entered_currency: 'IQD' as const,
      document_rate: RATE,
      document_rate_source: 'global' as const,
    }),
    priced_measure: 'kg' as const,
    qty_count: null,
    qty_kg: '10.000',
    unit_price_iqd: 6_500,
    unit_price_usd_cents: 496,
    price_entered_currency: 'IQD' as const,
    document_rate: RATE,
    document_rate_source: 'global' as const,
  };

  it('recomputes the calculated side of a line where only one price was typed', () => {
    const recomputed = recomputeLineForDocumentRate(line, '1300.0000', 'manual');
    expect(recomputed.line_total_iqd).toBe(65_000);
    expect(recomputed.line_total_usd_cents).toBe(5_000);
    expect(recomputed.unit_price_usd_cents).toBe(500);
    expect(recomputed.unit_price_iqd).toBe(6_500);
  });

  it('leaves a line alone when both prices were typed (rate_source = manual)', () => {
    const manual = { ...line, rate_source: 'manual' as const };
    expect(recomputeLineForDocumentRate(manual, '1400.0000', 'manual')).toEqual(manual);
  });
});

describe('pairs and reversals (spec 2.3.2, 2.4.1)', () => {
  it('fills the calculated side and keeps the rate that filled it', () => {
    expect(completePair({ amount: 1_000_000, currency: 'IQD', rate: RATE, rate_source: 'company' })).toEqual({
      amount_iqd: 1_000_000,
      amount_usd_cents: 76_336,
      entered_currency: 'IQD',
      rate_iqd_per_usd: RATE,
      rate_source: 'company',
    });
  });

  it('an override stores the implied rate and marks the pair manual', () => {
    const pair = completePair({
      amount: 1_000_000,
      currency: 'IQD',
      rate: RATE,
      rate_source: 'company',
      other_amount: 76_628,
    });
    expect(pair.amount_usd_cents).toBe(76_628);
    expect(pair.rate_source).toBe('manual');
    expect(pair.rate_iqd_per_usd).toBe('1305.0060');
  });

  it('property: entry + reversal = 0 in both currencies', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e12, max: 1e12 }), (amount) => {
        const entry = completePair({ amount, currency: 'IQD', rate: RATE, rate_source: 'global' });
        const reversal = negatePair(entry);
        expect(entry.amount_iqd + reversal.amount_iqd).toBe(0);
        expect(entry.amount_usd_cents + reversal.amount_usd_cents).toBe(0);
      }),
    );
  });
});

describe('settle in full (FR-606, FR-705)', () => {
  it('paid in the other currency: the settlement side is exact, the other is what was handed over', () => {
    const result = settleInFull({
      remaining: 501_250,
      settlement_currency: 'IQD',
      received_currency: 'USD',
      received_amount: 38_263,
      rate: RATE,
      rate_source: 'global',
    });
    expect(result.kind).toBe('manual_rate_pair');
    if (result.kind !== 'manual_rate_pair') throw new Error('unreachable');
    expect(result.entry.amount_iqd).toBe(-501_250);
    expect(result.entry.amount_usd_cents).toBe(-38_263);
    expect(result.entry.rate_source).toBe('manual');
    expect(501_250 + result.entry.amount_iqd).toBe(0); // lands on zero, no residue
  });

  it('paid short in the settlement currency: payment as received plus a residue row', () => {
    const result = settleInFull({
      remaining: 501_250,
      settlement_currency: 'IQD',
      received_currency: 'IQD',
      received_amount: 501_000,
      rate: RATE,
      rate_source: 'global',
    });
    expect(result.kind).toBe('payment_with_residue');
    if (result.kind !== 'payment_with_residue') throw new Error('unreachable');
    expect(result.entry.amount_iqd).toBe(-501_000); // what the cash-up counts
    expect(result.residue.amount_iqd).toBe(-250);
    expect(501_250 + result.entry.amount_iqd + result.residue.amount_iqd).toBe(0);
  });

  it('refuses a difference larger than the tolerance — that is a discount, not a rate', () => {
    expect(() =>
      settleInFull({
        remaining: 501_250,
        settlement_currency: 'IQD',
        received_currency: 'IQD',
        received_amount: 490_000,
        rate: RATE,
        rate_source: 'global',
      }),
    ).toThrow(RangeError);
  });

  it('uses the configured tolerance per currency', () => {
    expect(withinTolerance(250, 'IQD')).toBe(true);
    expect(withinTolerance(251, 'IQD')).toBe(false);
    expect(withinTolerance(-25, 'USD')).toBe(true);
    expect(withinTolerance(26, 'USD')).toBe(false);
  });
});

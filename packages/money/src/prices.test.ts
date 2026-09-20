import { describe, expect, it } from 'vitest';
import {
  costSnapshotOf,
  defaultLinePrice,
  firstOfMonth,
  priceSideOf,
  rateIsStale,
  selectMonthPrice,
} from './index.js';
import type { MonthPriceRow } from './index.js';

const RATE = '1310.0000';

function priceRow(overrides: Partial<MonthPriceRow> & Pick<MonthPriceRow, 'id' | 'month'>): MonthPriceRow {
  return {
    bought_iqd: null,
    bought_usd_cents: null,
    bought_entered_currency: null,
    bought_rate: null,
    sale_iqd: null,
    sale_usd_cents: null,
    sale_entered_currency: null,
    sale_rate: null,
    ...overrides,
  };
}

/** September's prices for "Copper wire 2 mm": typed in dinars, dollars calculated at 1,310. */
const september = priceRow({
  id: 'p-sep',
  month: '2026-09-01',
  bought_iqd: 5_200,
  bought_usd_cents: 397,
  bought_entered_currency: 'IQD',
  bought_rate: RATE,
  sale_iqd: 6_500,
  sale_usd_cents: 496,
  sale_entered_currency: 'IQD',
  sale_rate: RATE,
});

const august = priceRow({
  id: 'p-aug',
  month: '2026-08-01',
  bought_iqd: 5_000,
  bought_usd_cents: 382,
  bought_entered_currency: 'IQD',
  bought_rate: '1309.0000',
  sale_iqd: 6_200,
  sale_usd_cents: 474,
  sale_entered_currency: 'IQD',
  sale_rate: '1309.0000',
});

describe('the month a price belongs to (spec 2.2.3)', () => {
  it('reduces any date to the first of its month', () => {
    expect(firstOfMonth('2026-09-18')).toBe('2026-09-01');
    expect(firstOfMonth('2026-01-01')).toBe('2026-01-01');
    expect(() => firstOfMonth('not-a-date')).toThrow(RangeError);
  });
});

describe('the month price list and its silent carry-forward (FR-305, FR-306)', () => {
  it("takes this month's price when it exists", () => {
    const selection = selectMonthPrice([august, september], 'sale', '2026-09-18');
    expect(selection.source).toBe('month');
    expect(selection.from_month).toBe('2026-09-01');
    expect(selection.value?.amount_iqd).toBe(6_500);
  });

  it('carries the most recent earlier month forward, naming the month it came from', () => {
    const selection = selectMonthPrice([august], 'sale', '2026-09-18');
    expect(selection.source).toBe('fallback');
    expect(selection.from_month).toBe('2026-08-01');
    expect(selection.value?.amount_iqd).toBe(6_200);
  });

  it('never reaches forward into a later month', () => {
    const selection = selectMonthPrice([september], 'sale', '2026-08-31');
    expect(selection.source).toBe('none');
    expect(selection.value).toBeNull();
  });

  it('chooses each side on its own, so a sale-only month still costs at the earlier month', () => {
    const saleOnlySeptember = priceRow({
      id: 'p-sep-sale',
      month: '2026-09-01',
      sale_iqd: 6_800,
      sale_usd_cents: 519,
      sale_entered_currency: 'IQD',
      sale_rate: RATE,
    });

    const sale = selectMonthPrice([august, saleOnlySeptember], 'sale', '2026-09-18');
    const bought = selectMonthPrice([august, saleOnlySeptember], 'bought', '2026-09-18');

    expect(sale.source).toBe('month');
    expect(sale.value?.amount_iqd).toBe(6_800);
    expect(bought.source).toBe('fallback');
    expect(bought.value?.amount_iqd).toBe(5_000);
  });

  it('reads half a pair as no price at all, so no screen can show one currency', () => {
    const halfPair = priceRow({ id: 'p-half', month: '2026-09-01', sale_iqd: 6_500 });
    expect(priceSideOf(halfPair, 'sale')).toBeNull();
    expect(selectMonthPrice([halfPair], 'sale', '2026-09-18').source).toBe('none');
  });
});

describe('defaulting a line price (FR-609, spec 2.3.3)', () => {
  it('keeps the entered currency authoritative and calculates the other at the document rate', () => {
    const selection = selectMonthPrice([september], 'sale', '2026-09-18');
    const price = defaultLinePrice(selection, RATE);

    expect(price).toEqual({
      unit_price_iqd: 6_500,
      unit_price_usd_cents: 496, // 6,500 ÷ 1,310 = 4.96 $, rounded once
      price_entered_currency: 'IQD',
      month_price_id: 'p-sep',
      price_source: 'month',
      from_month: '2026-09-01',
      carried_forward: false,
    });
  });

  it('recalculates the other side at a rate typed for this deal, not the price row rate', () => {
    const selection = selectMonthPrice([september], 'sale', '2026-09-18');
    const price = defaultLinePrice(selection, '1300.0000');

    expect(price?.unit_price_iqd).toBe(6_500);
    expect(price?.unit_price_usd_cents).toBe(500); // 6,500 ÷ 1,300
  });

  it('marks a carried-forward price so the line can say "from August"', () => {
    const price = defaultLinePrice(selectMonthPrice([august], 'sale', '2026-09-18'), RATE);
    expect(price?.carried_forward).toBe(true);
    expect(price?.from_month).toBe('2026-08-01');
  });

  it('has nothing to default when no month has a price', () => {
    expect(defaultLinePrice(selectMonthPrice([], 'sale', '2026-09-18'), RATE)).toBeNull();
  });
});

describe('the cost snapshot a line keeps (FR-602, A-42)', () => {
  it('copies the bought pair as stored, with the month it came from', () => {
    const snapshot = costSnapshotOf(selectMonthPrice([august, september], 'bought', '2026-09-18'));
    expect(snapshot).toEqual({
      cost_unit_iqd: 5_200,
      cost_unit_usd_cents: 397,
      cost_month_price_id: 'p-sep',
      cost_source: 'month',
    });
  });

  it('records that the cost came from an earlier month', () => {
    const snapshot = costSnapshotOf(selectMonthPrice([august], 'bought', '2026-09-18'));
    expect(snapshot.cost_source).toBe('fallback');
    expect(snapshot.cost_month_price_id).toBe('p-aug');
  });

  it('stores no cost at all when the material was never priced, rather than a zero', () => {
    expect(costSnapshotOf(selectMonthPrice([], 'bought', '2026-09-18'))).toEqual({
      cost_unit_iqd: null,
      cost_unit_usd_cents: null,
      cost_month_price_id: null,
      cost_source: 'none',
    });
  });
});

describe('the stale-rate prompt (FR-1106, Proposed — not requested)', () => {
  it('prompts only once the rate is older than the configured number of days', () => {
    const now = new Date('2026-09-20T09:00:00Z');
    expect(rateIsStale(new Date('2026-09-19T09:00:00Z'), now, 3)).toBe(false);
    expect(rateIsStale(new Date('2026-09-16T08:00:00Z'), now, 3)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { selectMonthPrice } from '@mizan/money';
import type { MonthPriceRow } from '@mizan/money';
import {
  ReturnNotAllowedError,
  damageCreditPrice,
  damageCreditValue,
  damageValue,
  initialReturnStatus,
  nextReturnStatus,
  stockEffectOf,
} from './index.js';
import type { DamageAttribution, ReturnStatus } from './index.js';

/**
 * The rules of a damage record (FR-801 to FR-807, A-30, A-31, A-39). The figures are the ones
 * the demo script of 4.5 walks through: 4 kg of copper at 5,900 د.ع on the purchase line, and
 * the month's bought price of 700 د.ع/kg.
 */

const RATE = '1310.0000';

function priceRow(overrides: Partial<MonthPriceRow> = {}): MonthPriceRow {
  return {
    id: 'price-september',
    month: '2026-09-01',
    bought_iqd: 700,
    bought_usd_cents: 53,
    bought_entered_currency: 'IQD',
    bought_rate: RATE,
    sale_iqd: 850,
    sale_usd_cents: 65,
    sale_entered_currency: 'IQD',
    sale_rate: RATE,
    ...overrides,
  };
}

describe('what damage does to stock (A-30, spec 2.5.1)', () => {
  it('leaves stock alone only when the goods had already been sold', () => {
    const cases: [DamageAttribution, 'reduced' | 'none'][] = [
      ['none', 'reduced'],
      ['us', 'reduced'],
      ['company', 'reduced'],
      ['customer_order', 'none'],
    ];
    for (const [attribution, effect] of cases) {
      expect(stockEffectOf(attribution), attribution).toBe(effect);
    }
  });
});

describe('the return status machine (FR-803)', () => {
  it('starts pending only when the goods can go back', () => {
    expect(initialReturnStatus(true)).toBe('pending');
    expect(initialReturnStatus(false)).toBe('not_returnable');
  });

  it('walks pending → returned → returned & credited', () => {
    expect(nextReturnStatus('pending', 'returned')).toBe('returned');
    expect(nextReturnStatus('returned', 'credited')).toBe('returned_credited');
    // "Mark returned and record credit" in one action (flow 3.5.5 step 5).
    expect(nextReturnStatus('pending', 'credited')).toBe('returned_credited');
  });

  it('writes off from pending, and nowhere else', () => {
    expect(nextReturnStatus('pending', 'written_off')).toBe('written_off');
    expect(() => nextReturnStatus('returned', 'written_off')).toThrow(ReturnNotAllowedError);
  });

  it('refuses to return goods the record says cannot go back', () => {
    for (const action of ['returned', 'written_off', 'credited'] as const) {
      expect(() => nextReturnStatus('not_returnable', action)).toThrow(ReturnNotAllowedError);
    }
  });

  it('treats both ends as terminal, so a second credit is refused rather than ignored', () => {
    const terminal: ReturnStatus[] = ['returned_credited', 'written_off'];
    for (const status of terminal) {
      for (const action of ['returned', 'written_off', 'credited'] as const) {
        expect(() => nextReturnStatus(status, action), `${status} → ${action}`).toThrow(ReturnNotAllowedError);
      }
    }
  });
});

describe('what the damage was worth (FR-807)', () => {
  it('multiplies the month price pair as stored, and says which month it came from', () => {
    const value = damageValue(
      { priced_measure: 'kg', qty_count: null, qty_kg: '4.000' },
      selectMonthPrice([priceRow()], 'bought', '2026-09-18'),
    );
    expect(value).toEqual({
      est_value_iqd: 2_800,
      est_value_usd_cents: 212,
      est_value_source: 'month',
      from_month: '2026-09-01',
    });
  });

  it('flags a value taken from an earlier month (FR-306)', () => {
    const value = damageValue(
      { priced_measure: 'kg', qty_count: null, qty_kg: '10.000' },
      selectMonthPrice([priceRow({ month: '2026-08-01', id: 'price-august' })], 'bought', '2026-09-18'),
    );
    expect(value.est_value_source).toBe('fallback');
    expect(value.from_month).toBe('2026-08-01');
    expect(value.est_value_iqd).toBe(7_000);
  });

  it('leaves the value unknown rather than zero when no month has a bought price', () => {
    const value = damageValue(
      { priced_measure: 'count', qty_count: 3, qty_kg: null },
      selectMonthPrice([priceRow({ bought_iqd: null, bought_usd_cents: null })], 'bought', '2026-09-18'),
    );
    expect(value).toEqual({
      est_value_iqd: null,
      est_value_usd_cents: null,
      est_value_source: 'none',
      from_month: null,
    });
  });

  it('values a per-piece material by its count, not its weight', () => {
    const value = damageValue(
      { priced_measure: 'count', qty_count: 20, qty_kg: '48.000' },
      selectMonthPrice([priceRow({ bought_iqd: 15_000, bought_usd_cents: 1_145 })], 'bought', '2026-09-18'),
    );
    expect(value.est_value_iqd).toBe(300_000);
  });
});

describe('what a return to a supplier is worth (A-39, FR-805)', () => {
  it('prefers the price on the purchase line the goods arrived on', () => {
    const price = damageCreditPrice({
      purchase_line: { unit_price_iqd: 5_900, unit_price_usd_cents: 450, price_entered_currency: 'IQD' },
      month_price: selectMonthPrice([priceRow()], 'bought', '2026-09-18'),
    });
    expect(price).toMatchObject({ unit_price_iqd: 5_900, source: 'purchase_line' });

    // 4 kg × 5,900 د.ع = 23,600 د.ع ≈ 18.02 $ at the company's 1,310 (flow 3.5.5).
    const credit = damageCreditValue(
      { priced_measure: 'kg', qty_count: null, qty_kg: '4.000' },
      price as NonNullable<typeof price>,
      RATE,
      'company',
    );
    expect(credit).not.toBeNull();
    expect(credit?.line_total_iqd).toBe(23_600);
    expect(credit?.line_total_usd_cents).toBe(1_802);
    expect(credit?.rate_iqd_per_usd).toBe(RATE);
    expect(credit?.rate_source).toBe('company');
  });

  it('falls back to the month price when no purchase is linked, and says so', () => {
    const price = damageCreditPrice({
      purchase_line: null,
      month_price: selectMonthPrice([priceRow({ month: '2026-08-01' })], 'bought', '2026-09-18'),
    });
    expect(price).toMatchObject({ unit_price_iqd: 700, source: 'fallback', from_month: '2026-08-01' });
  });

  it('gives nothing to pre-fill when neither exists, rather than a zero credit', () => {
    expect(damageCreditPrice({ purchase_line: null, month_price: null })).toBeNull();
  });

  it('multiplies the typed side and converts the total, never a rounded unit price', () => {
    // 850 د.ع/kg × 5,000 kg at 1,310 is $3,244.27; 65¢ × 5,000 would claim $3,250.
    const credit = damageCreditValue(
      { priced_measure: 'kg', qty_count: null, qty_kg: '5000.000' },
      {
        unit_price_iqd: 850,
        unit_price_usd_cents: 65,
        price_entered_currency: 'IQD',
        source: 'month',
        from_month: '2026-09-01',
      },
      RATE,
      'company',
    );
    expect(credit?.line_total_iqd).toBe(4_250_000);
    expect(credit?.line_total_usd_cents).toBe(324_427);
  });
});

/**
 * A material may be re-classified from kilos to pieces years after a record was written
 * (`PATCH /items/:id` allows it), which leaves that record carrying a measure that is no longer
 * the priced one. The I3 review found the detail route answering **500** on exactly that shape,
 * because the kernel threw. Unknown is an answer; an exception is not.
 */
describe('a record that no longer carries the priced measure (I3 review)', () => {
  const kgOnly = { priced_measure: 'count' as const, qty_count: null, qty_kg: '4.000' };

  it('reports the value as unknown instead of throwing', () => {
    expect(damageValue(kgOnly, selectMonthPrice([priceRow()], 'bought', '2026-09-18'))).toEqual({
      est_value_iqd: null,
      est_value_usd_cents: null,
      est_value_source: 'none',
      from_month: null,
    });
  });

  it('offers nothing to pre-fill a credit with, so the sheet asks for the agreed figure', () => {
    const price = damageCreditPrice({
      purchase_line: { unit_price_iqd: 5_900, unit_price_usd_cents: 450, price_entered_currency: 'IQD' },
      month_price: null,
    });
    expect(damageCreditValue(kgOnly, price as NonNullable<typeof price>, RATE, 'company')).toBeNull();
  });

  it('still values a record that carries the measure it is priced in', () => {
    const value = damageValue(
      { priced_measure: 'count', qty_count: 2, qty_kg: '4.000' },
      selectMonthPrice([priceRow({ bought_iqd: 15_000, bought_usd_cents: 1_145 })], 'bought', '2026-09-18'),
    );
    expect(value.est_value_iqd).toBe(30_000);
  });
});

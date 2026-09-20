import { describe, expect, it } from 'vitest';
import { rangeFor } from './PurchasesPage.js';

/**
 * The date chips of the Purchases list resolve from today's **Baghdad** day, which is what
 * the API filters on (spec 2.10.4). Computing them from `new Date().toISOString()` instead
 * made the chips name yesterday for the first three hours of every Baghdad day, so a purchase
 * recorded at 01:30 was missing from "this month" — found by the screenshot suite when the
 * date rolled over mid-run.
 */
describe('the purchases date chips (spec 3.3)', () => {
  it('asks for exactly today when the Today chip is on', () => {
    expect(rangeFor('today', '2026-09-21', '', '')).toEqual({ from: '2026-09-21', to: '2026-09-21' });
  });

  it('includes today in the week and the month, on the first day of a month too', () => {
    expect(rangeFor('week', '2026-09-21', '', '')).toEqual({ from: '2026-09-15', to: '2026-09-21' });
    expect(rangeFor('month', '2026-09-21', '', '')).toEqual({ from: '2026-09-01', to: '2026-09-21' });
    expect(rangeFor('month', '2026-09-01', '', '')).toEqual({ from: '2026-09-01', to: '2026-09-01' });
  });

  it('lets a typed range win over the chips, and All ask for no range at all', () => {
    expect(rangeFor('month', '2026-09-21', '2026-01-01', '2026-06-30')).toEqual({
      from: '2026-01-01',
      to: '2026-06-30',
    });
    expect(rangeFor('all', '2026-09-21', '', '')).toEqual({});
  });
});

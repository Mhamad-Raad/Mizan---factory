import { describe, expect, it } from 'vitest';
import {
  lastDays,
  lastMonth,
  lastTwelveMonths,
  presetPeriod,
  shiftDays,
  thisMonth,
  thisWeek,
  thisYear,
  yesterdayOf,
} from './periods.js';

/**
 * The date presets resolve from today's **Baghdad** day, which is what the API filters on
 * (spec 2.10.4). Computing them from `new Date().toISOString()` instead made the chips name
 * yesterday for the first three hours of every Baghdad day, so a purchase recorded at 01:30 was
 * missing from "this month" — found by the screenshot suite when the date rolled over mid-run.
 * They live in one place so "this week" is the same seven days on every screen.
 */
describe('the date presets (spec 3.3)', () => {
  it('includes today in the week and the month, on the first day of a month too', () => {
    expect(thisWeek('2026-09-21')).toEqual({ from: '2026-09-15', to: '2026-09-21' });
    expect(thisMonth('2026-09-21')).toEqual({ from: '2026-09-01', to: '2026-09-21' });
    expect(thisMonth('2026-09-01')).toEqual({ from: '2026-09-01', to: '2026-09-01' });
  });

  it('crosses month and year ends by the calendar', () => {
    expect(thisWeek('2026-03-02')).toEqual({ from: '2026-02-24', to: '2026-03-02' });
    expect(yesterdayOf('2026-01-01')).toBe('2025-12-31');
    expect(shiftDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(lastDays('2026-09-21', 30)).toEqual({ from: '2026-08-23', to: '2026-09-21' });
  });

  it('takes last month whole, January back into December', () => {
    expect(lastMonth('2026-09-21')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(lastMonth('2026-03-15')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(lastMonth('2026-01-10')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('starts the year on the first of January', () => {
    expect(thisYear('2026-09-21')).toEqual({ from: '2026-01-01', to: '2026-09-21' });
  });

  it('covers the twelve months to today for a statement', () => {
    expect(lastTwelveMonths('2026-09-21')).toEqual({ from: '2025-09-21', to: '2026-09-21' });
    expect(lastTwelveMonths('2028-02-29')).toEqual({ from: '2027-03-01', to: '2028-02-29' });
  });
});

describe('the named periods every screen maps its choices onto', () => {
  const today = '2026-09-21';

  it('resolves each name from the Baghdad day it is given', () => {
    expect(presetPeriod('all', today)).toEqual({});
    expect(presetPeriod('today', today)).toEqual({ from: today, to: today });
    expect(presetPeriod('yesterday', today)).toEqual({ from: '2026-09-20', to: '2026-09-20' });
    expect(presetPeriod('since_yesterday', today)).toEqual({ from: '2026-09-20', to: today });
    expect(presetPeriod('week', today)).toEqual(thisWeek(today));
    expect(presetPeriod('month', today)).toEqual(thisMonth(today));
    expect(presetPeriod('last_month', today)).toEqual(lastMonth(today));
    expect(presetPeriod('year', today)).toEqual(thisYear(today));
    expect(presetPeriod('last_30_days', today)).toEqual(lastDays(today, 30));
    expect(presetPeriod('last_90_days', today)).toEqual(lastDays(today, 90));
  });
});

import { describe, expect, it } from 'vitest';
import { monthsBefore } from './period.service.js';

describe('a date some months back', () => {
  it('clamps to the last day of a shorter month instead of rolling over', () => {
    expect(monthsBefore('2026-05-31', 3)).toBe('2026-02-28');
    expect(monthsBefore('2028-05-31', 3)).toBe('2028-02-29');
    expect(monthsBefore('2026-03-31', 1)).toBe('2026-02-28');
  });

  it('crosses a year and keeps an ordinary day as it is', () => {
    expect(monthsBefore('2026-01-15', 2)).toBe('2025-11-15');
    expect(monthsBefore('2026-09-28', 12)).toBe('2025-09-28');
  });
});

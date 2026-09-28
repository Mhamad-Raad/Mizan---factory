import { describe, expect, it } from 'vitest';
import { parseCount, positiveCount, quantityText } from './quantity.js';

/**
 * Pieces are whole (review). `Math.round(Number(text))` booked 3 pieces when 2.5 was typed and
 * showed NaN for ".", with nothing on screen to say so.
 */
describe('a count as typed', () => {
  it('accepts whole numbers, in either digit system, with or without separators', () => {
    expect(parseCount('12')).toEqual({ kind: 'count', value: 12 });
    expect(parseCount(' 1,250 ')).toEqual({ kind: 'count', value: 1250 });
    expect(parseCount('١٢')).toEqual({ kind: 'count', value: 12 });
    expect(parseCount('۰')).toEqual({ kind: 'count', value: 0 });
  });

  it('refuses anything that is not a whole number instead of rounding it', () => {
    for (const text of ['2.5', '.', '3.', '-1', '1e3', '3a']) {
      expect(parseCount(text)).toEqual({ kind: 'invalid' });
    }
  });

  it('is empty when nothing was typed', () => {
    expect(parseCount('')).toEqual({ kind: 'empty' });
    expect(parseCount('  ')).toEqual({ kind: 'empty' });
  });

  it('is a positive count only above zero', () => {
    expect(positiveCount('0')).toBeNull();
    expect(positiveCount('2.5')).toBeNull();
    expect(positiveCount('4')).toBe(4);
  });
});

describe('a recorded quantity as text', () => {
  const formatter = { number: (value: number | string) => String(value), quantity: (value: number | string) => String(value) };
  const t = (key: string) => (key === 'common:kg_symbol' ? 'kg' : 'pcs');

  it('puts the priced measure first and the other after it', () => {
    expect(quantityText({ priced_measure: 'count', qty_count: 12, qty_kg: '3.5' }, formatter, t)).toBe('12 pcs · 3.5 kg');
    expect(quantityText({ priced_measure: 'kg', qty_count: 12, qty_kg: '3.5' }, formatter, t)).toBe('3.5 kg · 12 pcs');
    expect(quantityText({ qty_count: null, qty_kg: null }, formatter, t)).toBe('—');
  });
});

import { describe, expect, it } from 'vitest';
import { centsToInput, parseMinor } from './MoneyInput.js';

/**
 * A money field reads what was typed as a decimal string, never through a floating-point
 * number (spec 2.3.1): dollars and cents apart, dinars whole, and anything that is not yet an
 * amount — a third decimal, a dinar fraction, a lone sign — is `null` rather than a guess.
 */
describe('reading a typed amount (spec 2.3.1)', () => {
  it('reads dollars and cents exactly', () => {
    expect(parseMinor('12.50', 'USD')).toBe(1250);
    expect(parseMinor('12.5', 'USD')).toBe(1250);
    expect(parseMinor('12.', 'USD')).toBe(1200);
    expect(parseMinor('0.05', 'USD')).toBe(5);
    expect(parseMinor('0.29', 'USD')).toBe(29);
    expect(parseMinor('.5', 'USD')).toBe(50);
    expect(parseMinor('1,250.75', 'USD')).toBe(125075);
  });

  it('accepts the Arabic decimal sign and Eastern digits', () => {
    expect(parseMinor('١٢٫٥٠', 'USD')).toBe(1250);
    expect(parseMinor('۱۲۵۰', 'IQD')).toBe(1250);
  });

  it('refuses a third decimal of a dollar and any fraction of a dinar', () => {
    expect(parseMinor('1.005', 'USD')).toBeNull();
    expect(parseMinor('1250.5', 'IQD')).toBeNull();
  });

  it('reads grouped dinars, and a negative amount', () => {
    expect(parseMinor('1,250', 'IQD')).toBe(1250);
    expect(parseMinor('1,250,000', 'IQD')).toBe(1250000);
    expect(parseMinor('-1.25', 'USD')).toBe(-125);
  });

  it('is null for what is not an amount yet', () => {
    expect(parseMinor('', 'IQD')).toBeNull();
    expect(parseMinor('-', 'IQD')).toBeNull();
    expect(parseMinor('.', 'USD')).toBeNull();
    expect(parseMinor('12a', 'USD')).toBeNull();
    expect(parseMinor('1e3', 'IQD')).toBeNull();
    expect(parseMinor('99999999999999999999', 'IQD')).toBeNull();
  });
});

describe('showing cents in a dollar field', () => {
  it('writes dollars with two decimals', () => {
    expect(centsToInput(1250)).toBe('12.50');
    expect(centsToInput(5)).toBe('0.05');
    expect(centsToInput(0)).toBe('0.00');
    expect(centsToInput(-125)).toBe('-1.25');
  });

  it('reads back what it wrote', () => {
    for (const cents of [0, 1, 99, 100, 1250, 123456789, -42]) {
      expect(parseMinor(centsToInput(cents), 'USD')).toBe(cents);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { readNote, recordName } from './record-names.js';

const t = (key: string, options?: Record<string, unknown>) =>
  options && 'name' in options ? `${key}(${String(options.name)})` : key;
const number = (value: number) => `<${value}>`;

describe('record names and notes in the reader’s language', () => {
  it('names a numbered record by its translated kind', () => {
    expect(recordName('expense', 'Expense #5', t, number)).toBe('history:entity.expense #<5>');
    expect(recordName('damage', 'Broken #4', t, number)).toBe('history:entity.damage #<4>');
    expect(recordName('order', 'Order #1014', t, number)).toBe('history:entity.order #<1014>');
  });

  it('names a named record by its name alone', () => {
    expect(recordName('user', 'Employee: Rebaz Omar', t, number)).toBe('Rebaz Omar');
  });

  it('translates the notes the system writes for broken goods, old rows included', () => {
    expect(readNote('Broken #2', t, number)).toBe('history:entity.damage #<2>');
    expect(readNote('Broken #2 paid back', t, number)).toBe('damages:paid_back_note(history:entity.damage #<2>)');
    expect(readNote('Damage #7', t, number)).toBe('history:entity.damage #<7>');
    expect(readNote('Damage #7 paid back', t, number)).toBe('damages:paid_back_note(history:entity.damage #<7>)');
  });

  it('leaves what a person typed as it is', () => {
    expect(readNote('Broken #2 — the lid cracked', t, number)).toBe('Broken #2 — the lid cracked');
  });
});

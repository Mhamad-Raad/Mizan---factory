import { describe, expect, it } from 'vitest';
import { parseCsv } from '../pages/ImportPage.js';

/**
 * The CSV parser of the go-live import (FR-1312). It exists as a test because the file it
 * reads was written by somebody's Excel: a byte-order mark, `\r\n` line endings, commas inside
 * quoted names, doubled quotes, a trailing blank line, and Kurdish text throughout.
 */
describe('reading a spreadsheet somebody exported', () => {
  it('reads a plain file', () => {
    expect(parseCsv('name,pricing_unit\nCopper,per_kg\n')).toEqual([
      { name: 'Copper', pricing_unit: 'per_kg' },
    ]);
  });

  it('survives what Excel on Windows writes', () => {
    const excel = '﻿name,pricing_unit\r\nCopper wire 2 mm,per_kg\r\n\r\n';
    expect(parseCsv(excel)).toEqual([{ name: 'Copper wire 2 mm', pricing_unit: 'per_kg' }]);
  });

  it('keeps a comma inside a quoted name, and a quote inside it', () => {
    const rows = parseCsv('name,notes\n"Al-Noor Steel Co., Erbil","the 2"" pipe"\n');
    expect(rows).toEqual([{ name: 'Al-Noor Steel Co., Erbil', notes: 'the 2" pipe' }]);
  });

  it('keeps a newline inside a quoted field', () => {
    expect(parseCsv('name,notes\n"Kawa","first line\nsecond line"\n')).toEqual([
      { name: 'Kawa', notes: 'first line\nsecond line' },
    ]);
  });

  it('reads Kurdish names as they were typed', () => {
    expect(parseCsv('name\nکۆمپانیای نوور\n')).toEqual([{ name: 'کۆمپانیای نوور' }]);
  });

  it('treats a blank cell as nothing, not as an empty name', () => {
    expect(parseCsv('name,code\nCopper,\n')).toEqual([{ name: 'Copper', code: null }]);
  });

  it('lowercases the headers, because a spreadsheet capitalises them', () => {
    expect(parseCsv('Name,Pricing_Unit\nCopper,per_kg\n')).toEqual([
      { name: 'Copper', pricing_unit: 'per_kg' },
    ]);
  });

  it('returns nothing for an empty file rather than a row of nulls', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\n\n')).toEqual([]);
    expect(parseCsv('name,code\n')).toEqual([]);
  });
});

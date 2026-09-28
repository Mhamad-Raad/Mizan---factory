import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildXlsx, columnName } from './xlsx.js';

/**
 * The Excel writer of the Reports page. What matters to the person opening the file: it is a
 * valid workbook, numbers are numbers (so Excel can add them up), text is escaped, a Kurdish or
 * Arabic workbook reads right to left, and every report gets its own sheet.
 */
describe('the Excel export', () => {
  const workbook = () =>
    unzipSync(
      buildXlsx(
        [
          {
            name: 'Sales',
            title: 'Sales',
            subtitle: '01/09/2026 — 27/09/2026',
            columns: [
              { header: 'Month', format: 'text' },
              { header: 'Revenue (IQD)', format: 'integer' },
              { header: 'Revenue ($)', format: 'usd' },
            ],
            rows: [
              ['September <2026> & more', 1_250_000, 954.2],
              ['August', 0, null],
            ],
            totals: ['Total', 1_250_000, 954.2],
          },
          { name: 'Stock: materials/now', title: 'Stock', columns: [{ header: 'Kg', format: 'kg' }], rows: [[6346.5]] },
        ],
        { rtl: true },
      ),
    );

  it('is a workbook with a sheet per report, names Excel accepts', () => {
    const files = workbook();
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']),
    );
    const book = strFromU8(files['xl/workbook.xml'] as Uint8Array);
    expect(book).toContain('name="Sales"');
    // ":" and "/" are not allowed in a sheet name.
    expect(book).toContain('name="Stock  materials now"');
    expect(book).toContain('rightToLeft="1"');
  });

  it('writes numbers as numbers and escapes text', () => {
    const sheet = strFromU8(workbook()['xl/worksheets/sheet1.xml'] as Uint8Array);
    expect(sheet).toContain('<v>1250000</v>');
    expect(sheet).toContain('<v>954.2</v>');
    expect(sheet).toContain('September &lt;2026&gt; &amp; more');
    expect(sheet).toContain('rightToLeft="1"');
    expect(sheet).toContain('<autoFilter');
  });

  it('names columns as Excel does', () => {
    expect([0, 25, 26, 27, 701].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ']);
  });
});

describe('rows under the totals (review)', () => {
  it('writes the Profit sheet’s discounts, rounding and net profit after the totals row, in order', () => {
    const files = unzipSync(
      buildXlsx([
        {
          name: 'Profit',
          title: 'Profit',
          columns: [
            { header: 'Month', format: 'text' },
            { header: 'Margin (IQD)', format: 'integer' },
            { header: 'Margin ($)', format: 'usd' },
          ],
          rows: [['September', 500_000, 381.68]],
          totals: ['Total', 500_000, 381.68],
          afterTotals: [
            ['Order discounts', -20_000, -15.27],
            ['Rounding', 750, 0.57],
            ['Profit after discounts and rounding', 480_750, 366.98],
          ],
        },
      ]),
    );
    const xml = strFromU8(files['xl/worksheets/sheet1.xml'] as Uint8Array);
    const order = ['Total', 'Order discounts', 'Rounding', 'Profit after discounts and rounding'].map((label) => xml.indexOf(label));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(xml).toContain('<v>-20000</v>');
    expect(xml).toContain('<v>480750</v>');
  });
});

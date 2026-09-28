import { describe, expect, it } from 'vitest';
import { splitTitle } from './page-title.js';

describe('the header keeps a record number whole (review)', () => {
  it('splits the number the page names from the words, in every language', () => {
    expect(splitTitle('Order #1006', '1006')).toEqual({ label: 'Order', number: '#1006' });
    expect(splitTitle('فرۆشتن #1006', '1006')).toEqual({ label: 'فرۆشتن', number: '#1006' });
    expect(splitTitle('طلب رقم 1006', '1006')).toEqual({ label: 'طلب رقم', number: '1006' });
  });

  it('leaves a title without a number alone', () => {
    expect(splitTitle('Al-Noor Steel Co.')).toEqual({ label: 'Al-Noor Steel Co.', number: null });
    expect(splitTitle('Orders')).toEqual({ label: 'Orders', number: null });
    expect(splitTitle('1006', '1006')).toEqual({ label: '1006', number: null });
  });

  // Any trailing digits used to be split off, and the halves swapped places in a right-to-left
  // bar: "Rebar 12" showed "12 Rebar", "M8" showed "8 M".
  it('never splits the digits at the end of a name', () => {
    expect(splitTitle('Rebar 12')).toEqual({ label: 'Rebar 12', number: null });
    expect(splitTitle('M8')).toEqual({ label: 'M8', number: null });
    expect(splitTitle('Pipe 1.5')).toEqual({ label: 'Pipe 1.5', number: null });
    expect(splitTitle('Kawa #2')).toEqual({ label: 'Kawa #2', number: null });
  });

  it('keeps the title whole when the number is not at its end', () => {
    expect(splitTitle('1006 رقم طلب', '1006')).toEqual({ label: '1006 رقم طلب', number: null });
  });
});

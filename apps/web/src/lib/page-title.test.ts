import { describe, expect, it } from 'vitest';
import { splitTitle } from './page-title.js';

describe('the header keeps a record number whole (review)', () => {
  it('splits the number from the words in every language', () => {
    expect(splitTitle('Order #1006')).toEqual({ label: 'Order', number: '#1006' });
    expect(splitTitle('فرۆشتن #1006')).toEqual({ label: 'فرۆشتن', number: '#1006' });
    expect(splitTitle('طلب رقم 1006')).toEqual({ label: 'طلب رقم', number: '1006' });
  });

  it('leaves a title without a number alone', () => {
    expect(splitTitle('Al-Noor Steel Co.')).toEqual({ label: 'Al-Noor Steel Co.', number: null });
    expect(splitTitle('Orders')).toEqual({ label: 'Orders', number: null });
    expect(splitTitle('1006')).toEqual({ label: '1006', number: null });
  });
});

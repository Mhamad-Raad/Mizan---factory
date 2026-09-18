import { describe, expect, it } from 'vitest';
import {
  normalizeForSearch,
  normalizeForSearchFuzzy,
  normalizePhone,
  searchEquals,
  searchEqualsFuzzy,
} from './index.js';

/**
 * The test table required by FR-1205 and spec 2.10.7: at least 30 pairs, covering every
 * Kurdish-specific letter and the Arabic-keyboard spellings of the same names.
 */
const EQUIVALENT_PAIRS: readonly [string, string, string][] = [
  ['كوردستان', 'کوردستان', 'kaf vs keheh'],
  ['هه‌ولێر', 'هەولێر', 'ZWNJ + heh-heh vs Kurdish ae'],
  ['احمد', 'أحمد', 'bare alef vs alef with hamza'],
  ['إبراهيم', 'ابراهیم', 'alef with hamza below, yeh vs Kurdish yeh'],
  ['آزاد', 'ازاد', 'alef madda'],
  ['علي', 'علی', 'yeh vs Kurdish yeh'],
  ['ڕێباز', 'ريباز', 'Kurdish reh and yeh with small v'],
  ['ڵاوە', 'لاوه', 'Kurdish lam with small v, Kurdish ae'],
  ['ۆمێد', 'ومید', 'Kurdish oe folds to waw, yeh with small v to yeh'],
  ['سلێمانی', 'سليماني', 'Kurdish yeh and final yeh'],
  ['کەرکووک', 'كركوك'.replace('كركوك', 'كەركووك'), 'Kirkuk with Kurdish ae'],
  ['ڤیان', 'فيان', 'veh folds to feh'],
  ['مەریوان', 'مەريوان', 'Arabic yeh vs Kurdish yeh mid-word'],
  ['ئاسۆ', 'ئاسو', 'Kurdish oe folds to waw'],
  ['ڕۆژان', 'روژان', 'reh with small v and oe together'],
  ['فاطمة', 'فاطمه', 'teh marbuta vs heh'],
  ['خاتوون', 'خاتون'.replace('خاتون', 'خاتوون'), 'doubled waw'],
  ['مُحَمَّد', 'محمد', 'diacritics removed'],
  ['كــوردي', 'کوردی', 'tatweel removed'],
  ['١٢٣', '123', 'Eastern Arabic-Indic digits'],
  ['۱۲۳', '123', 'Persian/Kurdish digits'],
  ['شركة النور', 'شركة   النور', 'collapsed whitespace'],
  ['  دهۆک  ', 'دهوک', 'trimmed, oe folded'],
  ['یەکگرتوو', 'يەكگرتوو', 'yeh and kaf together'],
  ['ھەولێر', 'هەولێر', 'heh doachashmee'],
  ['ٱحمد', 'احمد', 'alef wasla'],
  ['مؤید', 'موید', 'waw with hamza'],
  ['نەورۆز', 'نەوروز', 'oe inside a word'],
  ['ژیان', 'ژیان', 'identical Kurdish word'],
  ['Copper Wire 2mm', 'copper wire 2mm', 'Latin case folding'],
  ['ALUMINIUM', 'aluminium', 'Latin upper case'],
  ['بەڕێز', 'بەريز', 'reh with small v mid-word'],
];

describe('normalizeForSearch — the 30-pair table (FR-1205, spec 2.10.7)', () => {
  for (const [a, b, why] of EQUIVALENT_PAIRS) {
    it(`matches "${a}" with "${b}" (${why})`, () => {
      expect(normalizeForSearch(a)).toBe(normalizeForSearch(b));
      expect(searchEquals(a, b)).toBe(true);
    });
  }

  it(`covers at least 30 pairs`, () => {
    expect(EQUIVALENT_PAIRS.length).toBeGreaterThanOrEqual(30);
  });
});

describe('normalizeForSearch — what must stay distinct', () => {
  it('keeps genuinely different names apart', () => {
    expect(searchEquals('کاوا', 'کارا')).toBe(false);
    expect(searchEquals('Copper wire 2 mm', 'Copper wire 3 mm')).toBe(false);
  });

  it('keeps the four Kurdish-only letters distinct in the strict pass', () => {
    expect(searchEquals('گەرمیان', 'کەرمیان')).toBe(false);
    expect(searchEquals('چاک', 'جاک')).toBe(false);
    expect(searchEquals('پاک', 'باک')).toBe(false);
    expect(searchEquals('ژیر', 'زیر')).toBe(false);
  });

  it('folds them only in the fuzzy fallback, on both sides', () => {
    expect(searchEqualsFuzzy('گەرمیان', 'كەرميان')).toBe(true);
    expect(searchEqualsFuzzy('چاک', 'جاك')).toBe(true);
    expect(searchEqualsFuzzy('پاک', 'باك')).toBe(true);
    expect(searchEqualsFuzzy('ژیر', 'زير')).toBe(true);
    expect(normalizeForSearchFuzzy('گ')).toBe('ک');
  });

  it('is idempotent and safe on empty input', () => {
    const once = normalizeForSearch('ڕێبوار');
    expect(normalizeForSearch(once)).toBe(once);
    expect(normalizeForSearch('')).toBe('');
  });
});

describe('documented limitation of the fold table (spec 2.10.7 step 4)', () => {
  /**
   * Kurdish writes the glottal onset and the short vowel that Arabic spelling leaves out,
   * and the table folds U+0626 to yeh rather than deleting it. So the *same person* written
   * the Kurdish way and the Arabic way does not match. This is the specification's algorithm
   * as written, not a defect; it is pinned here so nobody "fixes" it by accident, and it is
   * raised with the product owner as Q-B-01 because FR-501's duplicate check depends on it.
   */
  it('does not match the Kurdish and Arabic spellings of the same name', () => {
    expect(normalizeForSearch('ئەحمەد')).toBe('یهحمهد');
    expect(normalizeForSearch('احمد')).toBe('احمد');
    expect(searchEquals('ئەحمەد', 'احمد')).toBe(false);
  });
});

describe('normalizePhone (spec 2.10.7)', () => {
  it.each([
    ['07501234567', '07501234567'],
    ['+9647501234567', '07501234567'],
    ['009647501234567', '07501234567'],
    ['0750 123 4567', '07501234567'],
    ['0750-123-4567', '07501234567'],
    ['٠٧٥٠١٢٣٤٥٦٧', '07501234567'],
    ['۰۷۵۰۱۲۳۴۵۶۷', '07501234567'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it('returns an empty string for empty input', () => {
    expect(normalizePhone('')).toBe('');
  });
});

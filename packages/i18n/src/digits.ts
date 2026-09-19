import type { Locale } from './locales.js';

/**
 * Numeral style (FR-1105, spec 3.7.4). Eastern digits differ between Arabic and Kurdish:
 * ٤ ٥ ٦ against ۴ ۵ ۶, which is why one "Arabic-Indic" map is not enough.
 */
export type Numerals = 'latn' | 'arab' | 'arabext';

const ARAB = '٠١٢٣٤٥٦٧٨٩';
const ARABEXT = '۰۱۲۳۴۵۶۷۸۹';

/** Arabic thousands and decimal separators (U+066C, U+066B). */
const EASTERN_GROUP = '٬';
const EASTERN_DECIMAL = '٫';

export interface Separators {
  group: string;
  decimal: string;
}

export function separatorsFor(numerals: Numerals): Separators {
  return numerals === 'latn' ? { group: ',', decimal: '.' } : { group: EASTERN_GROUP, decimal: EASTERN_DECIMAL };
}

/** The numeral set a language may use: English is always Western (spec 3.7.4). */
export function numeralsFor(locale: Locale, preferred: Numerals): Numerals {
  if (locale === 'en') return 'latn';
  if (preferred === 'latn') return 'latn';
  return locale === 'ar-IQ' ? 'arab' : 'arabext';
}

export function shapeDigits(value: string, numerals: Numerals): string {
  if (numerals === 'latn') return value;
  const set = numerals === 'arab' ? ARAB : ARABEXT;
  return value.replace(/[0-9]/g, (digit) => set[Number(digit)] as string);
}

/** Input accepts either digit set and normalises to ASCII (FR-1105). */
export function normalizeDigitsToAscii(value: string): string {
  let result = '';
  for (const character of value) {
    const arab = ARAB.indexOf(character);
    const arabext = ARABEXT.indexOf(character);
    if (arab >= 0) result += String(arab);
    else if (arabext >= 0) result += String(arabext);
    else if (character === EASTERN_DECIMAL) result += '.';
    else if (character === EASTERN_GROUP) result += '';
    else result += character;
  }
  return result;
}

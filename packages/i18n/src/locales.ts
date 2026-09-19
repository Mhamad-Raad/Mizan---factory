/** The three first-class languages (spec 1.4 NFR-01). Kurdish Sorani is the default. */
export const LOCALES = ['ckb-IQ', 'ar-IQ', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'ckb-IQ';

export type Direction = 'rtl' | 'ltr';

/** RTL is the primary direction; LTR is the mirror (FR-1202). */
export const DIRECTION: Readonly<Record<Locale, Direction>> = {
  'ckb-IQ': 'rtl',
  'ar-IQ': 'rtl',
  en: 'ltr',
};

/** The language names are always shown in their own script (FR-1104). */
export const LANGUAGE_NAMES: Readonly<Record<Locale, string>> = {
  'ckb-IQ': 'کوردی',
  'ar-IQ': 'العربية',
  en: 'English',
};

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

export function directionOf(locale: Locale): Direction {
  return DIRECTION[locale];
}

/** `--dir` drives every direction-aware animation and gesture (spec 2.10.6 point 3). */
export function dirFactor(locale: Locale): 1 | -1 {
  return directionOf(locale) === 'rtl' ? 1 : -1;
}

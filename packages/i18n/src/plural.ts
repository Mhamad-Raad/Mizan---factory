import type { Locale } from './locales.js';

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/**
 * `Intl.PluralRules('ckb')` is unsupported in several browsers and silently falls back to
 * the default locale's rules, which would pick the wrong plural form without any error.
 * So the resolver is ours, keyed by language, and uses `Intl` only for `ar` and `en`
 * (spec 2.10.3).
 */
const intlRules: Partial<Record<Locale, Intl.PluralRules>> = {};

export function pluralCategory(count: number, locale: Locale): PluralCategory {
  if (locale === 'ckb-IQ') return count === 1 ? 'one' : 'other';
  const language = locale === 'ar-IQ' ? 'ar' : 'en';
  intlRules[locale] ??= new Intl.PluralRules(language);
  return (intlRules[locale] as Intl.PluralRules).select(count) as PluralCategory;
}

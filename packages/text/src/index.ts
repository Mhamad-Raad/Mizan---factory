/**
 * Script normalisation for search (spec 2.10.7, FR-1205).
 *
 * One pure function shared by the API (maintaining `name_normalized` columns on write)
 * and the client (filtering pickers in memory), so a name typed on an Arabic keyboard is
 * found from a Kurdish one and the other way round.
 */

const TATWEEL = /ـ/g;
const DIACRITICS = /[ً-ْٰ]/g;
const ZERO_WIDTH = /[‌‍]/g;
const BIDI_MARKS = /[‎‏؜]/g;
const STANDALONE_HAMZA = /ء/g;
const WHITESPACE = /\s+/g;

/** Eastern Arabic-Indic (U+0660–U+0669) and Persian/Kurdish (U+06F0–U+06F9) digits → ASCII. */
const DIGIT_MAP = new Map<string, string>();
for (let i = 0; i < 10; i += 1) {
  DIGIT_MAP.set(String.fromCharCode(0x0660 + i), String(i));
  DIGIT_MAP.set(String.fromCharCode(0x06f0 + i), String(i));
}

/** The canonical fold of the table in spec 2.10.7 step 4. */
const LETTER_MAP = new Map<string, string>([
  ['ك', 'ک'], // ك kaf        → ک keheh
  ['ڪ', 'ک'], // ڪ swash kaf   → ک
  ['ي', 'ی'], // ي yeh         → ی
  ['ى', 'ی'], // ى alef maksura→ ی
  ['ې', 'ی'], // ې e           → ی
  ['ئ', 'ی'], // ئ yeh + hamza → ی
  ['ێ', 'ی'], // ێ Kurdish yeh → ی
  ['ه', 'ه'], // ه heh         (canonical)
  ['ە', 'ه'], // ە Kurdish ae  → ه
  ['ة', 'ه'], // ة teh marbuta → ه
  ['ھ', 'ه'], // ھ doachashmee → ه
  ['أ', 'ا'], // أ alef hamza  → ا
  ['إ', 'ا'], // إ             → ا
  ['آ', 'ا'], // آ             → ا
  ['ٱ', 'ا'], // ٱ wasla       → ا
  ['ؤ', 'و'], // ؤ waw + hamza → و
  ['ۆ', 'و'], // ۆ Kurdish oe  → و
  ['ڵ', 'ل'], // ڵ Kurdish lam → ل
  ['ڕ', 'ر'], // ڕ Kurdish reh → ر
  ['ڤ', 'ف'], // ڤ veh         → ف
]);

/**
 * The second, fuzzy pass (spec 2.10.7): the four letters an Arabic keyboard cannot type.
 * Applied to both sides only when the strict pass found nothing, so "پەیمان" typed as
 * "بيمان" still matches without collapsing genuinely different Kurdish words by default.
 */
const FUZZY_MAP = new Map<string, string>([
  ['گ', 'ک'], // گ → ک
  ['چ', 'ج'], // چ → ج
  ['پ', 'ب'], // پ → ب
  ['ژ', 'ز'], // ژ → ز
]);

function mapCharacters(value: string, maps: readonly Map<string, string>[]): string {
  let result = '';
  for (const character of value) {
    let mapped = character;
    for (const map of maps) mapped = map.get(mapped) ?? mapped;
    result += mapped;
  }
  return result;
}

/** The strict pass — this is what is stored in `name_normalized` and what a query is compared against. */
export function normalizeForSearch(text: string): string {
  if (!text) return '';
  const cleaned = text
    .normalize('NFKC')
    .replace(TATWEEL, '')
    .replace(DIACRITICS, '')
    .replace(ZERO_WIDTH, '')
    .replace(BIDI_MARKS, '')
    .replace(STANDALONE_HAMZA, '');
  return mapCharacters(cleaned, [DIGIT_MAP, LETTER_MAP])
    .toLowerCase()
    .replace(WHITESPACE, ' ')
    .trim();
}

/** The fuzzy pass, used as a fallback when the strict pass returns no rows. */
export function normalizeForSearchFuzzy(text: string): string {
  return mapCharacters(normalizeForSearch(text), [FUZZY_MAP]);
}

/** True when two names are the same name for search purposes. */
export function searchEquals(a: string, b: string): boolean {
  return normalizeForSearch(a) === normalizeForSearch(b);
}

export function searchEqualsFuzzy(a: string, b: string): boolean {
  return normalizeForSearchFuzzy(a) === normalizeForSearchFuzzy(b);
}

/**
 * Phone numbers are normalised separately (spec 2.10.7): digits only, with a leading
 * +964 / 00964 reduced to 0, so 07501234567, +9647501234567 and 0964 750 123 4567 match.
 */
export function normalizePhone(phone: string): string {
  if (!phone) return '';
  const digits = mapCharacters(phone.normalize('NFKC'), [DIGIT_MAP]).replace(/[^0-9+]/g, '');
  const withoutPlus = digits.startsWith('+') ? digits.slice(1) : digits;
  if (withoutPlus.startsWith('00964')) return `0${withoutPlus.slice(5)}`;
  if (withoutPlus.startsWith('964')) return `0${withoutPlus.slice(3)}`;
  return withoutPlus;
}

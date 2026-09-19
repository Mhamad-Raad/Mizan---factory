import { shapeDigits } from './digits.js';
import type { Numerals } from './digits.js';
import type { Locale } from './locales.js';

export const TIME_ZONE = 'Asia/Baghdad';

/**
 * Month names come from our own catalog, never from `Intl`: `Intl` returns يناير for Arabic
 * where Iraq says كانون الثاني, and has no Kurdish data at all (spec 2.10.4, glossary 1.6).
 */
export const MONTH_NAMES: Readonly<Record<Locale, readonly string[]>> = {
  'ar-IQ': [
    'كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران',
    'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول',
  ],
  'ckb-IQ': [
    'کانوونی دووەم', 'شوبات', 'ئازار', 'نیسان', 'ئایار', 'حوزەیران',
    'تەممووز', 'ئاب', 'ئەیلوول', 'تشرینی یەکەم', 'تشرینی دووەم', 'کانوونی یەکەم',
  ],
  en: [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ],
};

/** Weekday names in week order, starting Saturday (FR-1108, C-10). */
export const WEEKDAY_NAMES: Readonly<Record<Locale, readonly string[]>> = {
  'ar-IQ': ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'],
  'ckb-IQ': ['شەممە', 'یەکشەممە', 'دووشەممە', 'سێشەممە', 'چوارشەممە', 'پێنجشەممە', 'هەینی'],
  en: ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
};

export type WeekStart = 'sat' | 'sun' | 'mon';
const WEEK_START_INDEX: Record<WeekStart, number> = { sat: 6, sun: 0, mon: 1 };

/**
 * The calendar parts of an instant in Asia/Baghdad. `Intl.DateTimeFormat` is used only as a
 * time-zone calculator with an ISO calendar — never for user-visible text (spec 2.10.4).
 */
export interface BaghdadParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  weekday: 'short',
});

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function baghdadParts(instant: Date): BaghdadParts {
  const parts = Object.fromEntries(
    partsFormatter.formatToParts(instant).map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? '00' : parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAY_INDEX[parts.weekday as string] ?? 0,
  };
}

/** "Today" for defaults, edit windows and business dates is computed in Asia/Baghdad. */
export function todayInBaghdad(now: Date = new Date()): string {
  const { year, month, day } = baghdadParts(now);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Business dates travel as `YYYY-MM-DD` and are rendered dd/MM/yyyy (FR-1108). */
export function formatBusinessDate(isoDate: string, numerals: Numerals): string {
  const [year = '', month = '', day = ''] = isoDate.split('-');
  return shapeDigits(`${day}/${month}/${year}`, numerals);
}

export function formatTimestamp(instant: Date, numerals: Numerals): string {
  const { year, month, day, hour, minute } = baghdadParts(instant);
  const date = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return shapeDigits(`${date} ${time}`, numerals);
}

export function monthName(month: number, locale: Locale): string {
  const names = MONTH_NAMES[locale];
  const name = names[month - 1];
  if (!name) throw new RangeError(`month out of range: ${month}`);
  return name;
}

/** Month headers in reports read "September 2026" in the interface language (FR-1011). */
export function formatMonth(isoMonth: string, locale: Locale, numerals: Numerals): string {
  const [year = '', month = ''] = isoMonth.split('-');
  return `${monthName(Number(month), locale)} ${shapeDigits(year, numerals)}`;
}

/** Weekday headers of a date picker, in the order the week is displayed. */
export function weekdayOrder(weekStart: WeekStart, locale: Locale): readonly string[] {
  const names = WEEKDAY_NAMES[locale];
  const offset = [6, 0, 1].indexOf(WEEK_START_INDEX[weekStart]);
  const rotation = offset < 0 ? 0 : offset;
  return [...names.slice(rotation), ...names.slice(0, rotation)];
}

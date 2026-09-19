import type { Locale } from '@mizan/i18n';
import type { Numerals } from '@mizan/i18n';

/**
 * Device preferences (FR-1103, R-34): language, theme, font size, numerals and the shared-device
 * flag live in this browser, not in the account — as the client asked. The shape and the key are
 * the contract the pre-paint script in `index.html` reads, so they must not drift.
 */
export const PREFERENCES_KEY = 'mizan.prefs.v1';
export const RECENT_USERS_KEY = 'mizan.recentUsers.v1';

export type Theme = 'light' | 'dark' | 'auto';
export type FontScale = 0.875 | 1 | 1.125 | 1.25;

export interface Preferences {
  lang: Locale;
  theme: Theme;
  fontScale: FontScale;
  numerals: Numerals;
  sharedDevice: boolean;
  deviceLabel?: string;
}

export const DEFAULT_PREFERENCES: Preferences = {
  lang: 'ckb-IQ',
  theme: 'auto',
  fontScale: 1,
  numerals: 'latn',
  sharedDevice: false,
};

const LOCALES: Locale[] = ['ckb-IQ', 'ar-IQ', 'en'];
const SCALES: FontScale[] = [0.875, 1, 1.125, 1.25];

/** True when this browser can actually keep preferences (private mode may refuse). */
export function storageAvailable(): boolean {
  try {
    const probe = '__mizan_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

export function readPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      lang: LOCALES.includes(parsed.lang as Locale) ? (parsed.lang as Locale) : DEFAULT_PREFERENCES.lang,
      theme: ['light', 'dark', 'auto'].includes(parsed.theme as string)
        ? (parsed.theme as Theme)
        : DEFAULT_PREFERENCES.theme,
      fontScale: SCALES.includes(parsed.fontScale as FontScale)
        ? (parsed.fontScale as FontScale)
        : DEFAULT_PREFERENCES.fontScale,
      numerals: ['latn', 'arab', 'arabext'].includes(parsed.numerals as string)
        ? (parsed.numerals as Numerals)
        : DEFAULT_PREFERENCES.numerals,
      sharedDevice: parsed.sharedDevice === true,
      deviceLabel: typeof parsed.deviceLabel === 'string' ? parsed.deviceLabel : undefined,
    };
  } catch {
    // Private mode, blocked storage or corrupted JSON: the app still works from defaults.
    return DEFAULT_PREFERENCES;
  }
}

export function writePreferences(preferences: Preferences): void {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Kept in memory for this session; Settings shows the notice (FR-1103).
  }
}

export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'auto') return theme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Applies preferences to the document — the same attributes the pre-paint script sets. */
export function applyPreferences(preferences: Preferences): void {
  const root = document.documentElement;
  const direction = preferences.lang === 'en' ? 'ltr' : 'rtl';
  root.setAttribute('lang', preferences.lang.split('-')[0] as string);
  root.setAttribute('data-locale', preferences.lang);
  root.setAttribute('dir', direction);
  root.setAttribute('data-theme', resolveTheme(preferences.theme));
  root.style.setProperty('--font-scale', String(preferences.fontScale));
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolveTheme(preferences.theme) === 'dark' ? '#211A21' : '#5E1F4B');
}

export interface RecentUser {
  username: string;
  displayName: string;
  lastAt: string;
  /** That user's last language on this device, applied when they sign in (FR-1103). */
  lang: Locale;
}

export function readRecentUsers(): RecentUser[] {
  try {
    const raw = localStorage.getItem(RECENT_USERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentUser[];
    return Array.isArray(parsed) ? parsed.slice(0, 3) : [];
  } catch {
    return [];
  }
}

export function rememberUser(user: RecentUser): void {
  try {
    const others = readRecentUsers().filter((entry) => entry.username !== user.username);
    localStorage.setItem(RECENT_USERS_KEY, JSON.stringify([user, ...others].slice(0, 3)));
  } catch {
    // Nothing to remember on a browser that cannot store.
  }
}

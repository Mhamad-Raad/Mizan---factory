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
  /** A desktop's sidebar, folded to its icons. Per device, like every other preference here. */
  sidebarCollapsed: boolean;
  /**
   * The PIN policy, kept here because the **lock screen needs it while the session is locked**,
   * when `GET /settings` answers 423 (FR-106, D-038). It is refreshed on every settings read,
   * and the defaults are the specification's own, so a browser that has never seen the settings
   * still asks for six digits on a shared tablet rather than four.
   */
  pinPolicy: { shared: number; personal: number; switchOnShared: boolean };
}

export const DEFAULT_PREFERENCES: Preferences = {
  lang: 'ckb-IQ',
  theme: 'auto',
  fontScale: 1,
  numerals: 'latn',
  sharedDevice: false,
  sidebarCollapsed: false,
  pinPolicy: { shared: 6, personal: 4, switchOnShared: true },
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
      sidebarCollapsed: parsed.sidebarCollapsed === true,
      pinPolicy: readPinPolicy(parsed.pinPolicy),
    };
  } catch {
    // Private mode, blocked storage or corrupted JSON: the app still works from defaults.
    return DEFAULT_PREFERENCES;
  }
}

/** A stored policy is trusted only as far as its shape: anything odd falls back to the spec. */
function readPinPolicy(stored: Preferences['pinPolicy'] | undefined): Preferences['pinPolicy'] {
  const fallback = DEFAULT_PREFERENCES.pinPolicy;
  if (!stored || typeof stored !== 'object') return fallback;
  const between = (value: unknown, min: number, max: number, instead: number): number =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : instead;
  return {
    shared: between(stored.shared, 4, 6, fallback.shared),
    personal: between(stored.personal, 4, 6, fallback.personal),
    switchOnShared: stored.switchOnShared !== false,
  };
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

/**
 * The font stylesheet for a language, added the first time that language is chosen.
 *
 * The pre-paint script in `index.html` links the family the stored language needs; this is the
 * other half — somebody switching from Kurdish to English mid-shift gets Inter now rather than
 * on their next reload (spec 3.7.1).
 */
function ensureFontsFor(lang: Locale): void {
  const family = lang === 'en' ? 'latin' : 'arabic';
  if (document.querySelector(`link[data-mizan-fonts="${family}"]`)) return;
  const sheet = document.createElement('link');
  sheet.rel = 'stylesheet';
  sheet.href = `/fonts/${family}.css`;
  sheet.setAttribute('data-mizan-fonts', family);
  document.head.appendChild(sheet);
}

/** Applies preferences to the document — the same attributes the pre-paint script sets. */
export function applyPreferences(preferences: Preferences): void {
  ensureFontsFor(preferences.lang);
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
  /**
   * The device ticket this browser was handed at that user's last **password** sign-in, which
   * is what lets their PIN sign them in here for seven days (FR-106, spec 2.8). It is a secret,
   * and it lives here for the same reason the session cookie lives in the cookie jar: this
   * browser is the thing it identifies. It is worth nothing without the PIN, nothing on another
   * browser, and the server revokes it on a password reset, a deactivation, five wrong PINs or
   * an admin's word.
   */
  ticket?: string | null;
  /** Whether that user had a PIN when they last signed in here, so the pad is offered at all. */
  hasPin?: boolean;
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
    const existing = readRecentUsers().find((entry) => entry.username === user.username);
    const others = readRecentUsers().filter((entry) => entry.username !== user.username);
    // A PIN sign-in remembers the language and the moment but carries no new ticket, so the
    // ticket already held here survives it.
    const merged: RecentUser = { ...existing, ...user, ticket: user.ticket ?? existing?.ticket ?? null };
    localStorage.setItem(RECENT_USERS_KEY, JSON.stringify([merged, ...others].slice(0, 3)));
  } catch {
    // Nothing to remember on a browser that cannot store.
  }
}

/**
 * Drop the ticket this browser held for somebody, keeping their name on the lock screen.
 *
 * Called when the server refuses it — expired, revoked, or five wrong PINs — so the next tap
 * asks for the password instead of offering a pad that cannot work (FR-106).
 */
export function forgetTicket(username: string): void {
  try {
    const users = readRecentUsers().map((entry) =>
      entry.username === username ? { ...entry, ticket: null } : entry,
    );
    localStorage.setItem(RECENT_USERS_KEY, JSON.stringify(users));
  } catch {
    // Nothing to forget on a browser that cannot store.
  }
}

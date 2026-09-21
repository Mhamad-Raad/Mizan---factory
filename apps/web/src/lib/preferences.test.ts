import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_KEY,
  applyPreferences,
  forgetTicket,
  readPreferences,
  rememberUser,
  readRecentUsers,
  resolveTheme,
  writePreferences,
} from './preferences.js';

/**
 * These tests guard the contract between this module and the pre-paint script in index.html
 * (spec 2.10.10): the same key, the same allowed values, the same fallbacks. If they drift,
 * the first frame renders in the wrong language or theme and nothing else catches it.
 */
describe('device preferences (FR-1103)', () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('starts a fresh browser in Kurdish Sorani, follow-device, default size, Western digits', () => {
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
    expect(DEFAULT_PREFERENCES.lang).toBe('ckb-IQ');
  });

  it('survives a reload on the same browser', () => {
    writePreferences({ ...DEFAULT_PREFERENCES, lang: 'ar-IQ', theme: 'dark', fontScale: 1.25 });
    const reloaded = readPreferences();
    expect(reloaded.lang).toBe('ar-IQ');
    expect(reloaded.theme).toBe('dark');
    expect(reloaded.fontScale).toBe(1.25);
  });

  it('falls back to defaults on corrupted or hostile stored values', () => {
    localStorage.setItem(PREFERENCES_KEY, 'not json at all');
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);

    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ lang: 'fr-FR', theme: 'neon', fontScale: 99, numerals: 'roman' }),
    );
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('keeps working when storage throws, as in private mode', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => undefined,
      clear: () => undefined,
    });
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
    expect(() => writePreferences(DEFAULT_PREFERENCES)).not.toThrow();
  });

  it('applies language, direction, theme and font scale to the document', () => {
    applyPreferences({ ...DEFAULT_PREFERENCES, lang: 'en', theme: 'dark', fontScale: 0.875 });
    const root = document.documentElement;
    expect(root.getAttribute('lang')).toBe('en');
    expect(root.getAttribute('dir')).toBe('ltr');
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.style.getPropertyValue('--font-scale')).toBe('0.875');

    applyPreferences({ ...DEFAULT_PREFERENCES, lang: 'ckb-IQ' });
    expect(root.getAttribute('dir')).toBe('rtl');
    expect(root.getAttribute('data-locale')).toBe('ckb-IQ');
  });

  it('resolves "follow device" from the media query', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(resolveTheme('auto')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
  });

  it('keeps the ticket a browser holds when a PIN sign-in remembers the user again', () => {
    // A password sign-in hands over a ticket; a PIN sign-in hands over none, and must not
    // erase the one that let it happen (FR-106).
    rememberUser({ username: 'rebaz', displayName: 'Rebaz', lastAt: '2026-09-20', lang: 'en', ticket: 'abc' });
    rememberUser({ username: 'rebaz', displayName: 'Rebaz', lastAt: '2026-09-21', lang: 'ckb-IQ' });

    const [entry] = readRecentUsers();
    expect(entry?.ticket).toBe('abc');
    expect(entry?.lang).toBe('ckb-IQ');
    expect(entry?.lastAt).toBe('2026-09-21');
  });

  it('forgets only the ticket when the server refuses it, keeping the name on the lock screen', () => {
    rememberUser({ username: 'rebaz', displayName: 'Rebaz', lastAt: '2026-09-21', lang: 'en', ticket: 'abc' });
    forgetTicket('rebaz');

    const [entry] = readRecentUsers();
    expect(entry?.displayName).toBe('Rebaz');
    expect(entry?.ticket).toBeNull();
  });

  it('falls back to the specification\'s PIN policy when the stored one is nonsense', () => {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ ...DEFAULT_PREFERENCES, pinPolicy: { shared: 2, personal: 'four', switchOnShared: 'no' } }),
    );
    // Two digits on a shared tablet is not a policy; six is (FR-106).
    expect(readPreferences().pinPolicy).toEqual({ shared: 6, personal: 4, switchOnShared: true });
  });

  it('remembers at most three recent users with the language each of them chose', () => {
    for (const name of ['sara', 'rebaz', 'ahmed', 'dilan']) {
      rememberUser({ username: name, displayName: name, lastAt: '2026-09-18', lang: 'ar-IQ' });
    }
    const recent = readRecentUsers();
    expect(recent).toHaveLength(3);
    expect(recent[0]?.username).toBe('dilan');
    expect(recent[0]?.lang).toBe('ar-IQ');
    expect(recent.map((entry) => entry.username)).not.toContain('sara');
  });
});

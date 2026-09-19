import type { Locale } from '@mizan/i18n';
import type { Numerals } from '@mizan/i18n';
/**
 * Device preferences (FR-1103, R-34): language, theme, font size, numerals and the shared-device
 * flag live in this browser, not in the account — as the client asked. The shape and the key are
 * the contract the pre-paint script in `index.html` reads, so they must not drift.
 */
export declare const PREFERENCES_KEY = "mizan.prefs.v1";
export declare const RECENT_USERS_KEY = "mizan.recentUsers.v1";
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
export declare const DEFAULT_PREFERENCES: Preferences;
/** True when this browser can actually keep preferences (private mode may refuse). */
export declare function storageAvailable(): boolean;
export declare function readPreferences(): Preferences;
export declare function writePreferences(preferences: Preferences): void;
export declare function resolveTheme(theme: Theme): 'light' | 'dark';
/** Applies preferences to the document — the same attributes the pre-paint script sets. */
export declare function applyPreferences(preferences: Preferences): void;
export interface RecentUser {
    username: string;
    displayName: string;
    lastAt: string;
    /** That user's last language on this device, applied when they sign in (FR-1103). */
    lang: Locale;
}
export declare function readRecentUsers(): RecentUser[];
export declare function rememberUser(user: RecentUser): void;
//# sourceMappingURL=preferences.d.ts.map
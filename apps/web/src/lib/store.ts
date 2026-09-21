import { create } from 'zustand';
import { createFormatter } from '@mizan/i18n';
import type { Formatter, Locale } from '@mizan/i18n';
import { applyPreferences, readPreferences, storageAvailable, writePreferences } from './preferences.js';
import type { Preferences } from './preferences.js';
import { i18next } from './i18n.js';

export interface SessionUser {
  id: string;
  username: string;
  display_name: string;
  role: 'admin' | 'employee';
  is_active: boolean;
  must_change_password: boolean;
  has_pin: boolean;
}

interface AppState {
  /** Device preferences (FR-1103); never sent to the server except the shared-device flag. */
  preferences: Preferences;
  preferencesPersisted: boolean;
  formatter: Formatter;
  setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;

  user: SessionUser | null;
  permissions: ReadonlySet<string>;
  isLocked: boolean;
  isOnline: boolean;
  setSession: (input: { user: SessionUser; permissions: string[]; isLocked?: boolean }) => void;
  clearSession: () => void;
  setLocked: (locked: boolean) => void;
  setOnline: (online: boolean) => void;
}

/** 300 ms of cross-fade on the document while the direction changes (spec 3.6.2). */
function mirrorLayout(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-mirroring', 'true');
  window.setTimeout(() => root.removeAttribute('data-mirroring'), 320);
}

function formatterFor(preferences: Preferences): Formatter {
  return createFormatter({ locale: preferences.lang, numerals: preferences.numerals });
}

const initialPreferences = readPreferences();

export const useApp = create<AppState>((set, get) => ({
  preferences: initialPreferences,
  preferencesPersisted: storageAvailable(),
  formatter: formatterFor(initialPreferences),

  setPreference: (key, value) => {
    const preferences = { ...get().preferences, [key]: value };
    // Applied to the document first so the change is visible in the same frame.
    applyPreferences(preferences);
    writePreferences(preferences);
    if (key === 'lang') {
      void i18next.changeLanguage(preferences.lang as Locale);
      // Signature moment 5 (spec 3.6.2): the layout cross-fades while it mirrors, rather than
      // snapping. The flag lives on the document so one CSS rule owns the animation, and the
      // reduced-motion block flattens it like everything else.
      mirrorLayout();
    }
    set({ preferences, formatter: formatterFor(preferences) });
  },

  user: null,
  permissions: new Set<string>(),
  isLocked: false,
  isOnline: true,

  setSession: ({ user, permissions, isLocked = false }) =>
    set({ user, permissions: new Set(permissions), isLocked }),
  clearSession: () => set({ user: null, permissions: new Set<string>(), isLocked: false }),
  setLocked: (isLocked) => set({ isLocked }),
  setOnline: (isOnline) => set({ isOnline }),
}));

/**
 * The interface derives from the same permission set the API enforces; hiding is a courtesy,
 * never the control (FR-104, spec 2.6.3).
 */
export function usePermission(key: string): boolean {
  return useApp((state) => state.user?.role === 'admin' || state.permissions.has(key));
}

export function useFormatter(): Formatter {
  return useApp((state) => state.formatter);
}

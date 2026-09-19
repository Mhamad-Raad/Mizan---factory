import type { Formatter } from '@mizan/i18n';
import type { Preferences } from './preferences.js';
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
    setSession: (input: {
        user: SessionUser;
        permissions: string[];
        isLocked?: boolean;
    }) => void;
    clearSession: () => void;
    setLocked: (locked: boolean) => void;
    setOnline: (online: boolean) => void;
}
export declare const useApp: import("zustand").UseBoundStore<import("zustand").StoreApi<AppState>>;
/**
 * The interface derives from the same permission set the API enforces; hiding is a courtesy,
 * never the control (FR-104, spec 2.6.3).
 */
export declare function usePermission(key: string): boolean;
export declare function useFormatter(): Formatter;
export {};
//# sourceMappingURL=store.d.ts.map
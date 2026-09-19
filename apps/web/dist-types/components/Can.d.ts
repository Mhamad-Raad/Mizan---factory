import type { ReactNode } from 'react';
/**
 * Navigation items, primary buttons and row actions are **absent**, not disabled, when the
 * user lacks the permission (FR-104). The API refuses them regardless.
 */
export declare function Can({ permission, children }: {
    permission: string;
    children: ReactNode;
}): import("react").JSX.Element | null;
//# sourceMappingURL=Can.d.ts.map
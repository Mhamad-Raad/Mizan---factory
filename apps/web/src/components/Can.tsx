import type { ReactNode } from 'react';
import { usePermission } from '../lib/store.js';

/**
 * Navigation items, primary buttons and row actions are **absent**, not disabled, when the
 * user lacks the permission (FR-104). The API refuses them regardless.
 */
export function Can({ permission, children }: { permission: string; children: ReactNode }) {
  return usePermission(permission) ? <>{children}</> : null;
}

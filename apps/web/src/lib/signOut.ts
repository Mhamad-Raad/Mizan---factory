import type { QueryClient } from '@tanstack/react-query';
import { apiRequest } from './api.js';
import { clearAllDrafts } from './drafts.js';

/**
 * Forget everything the previous person left on this device: every cached answer (their
 * customers, balances, prices) and every unsaved draft (2.10.2). Used on sign-out and when
 * somebody else takes over the tablet, so the next person never sees the last one's data in
 * the moment before their own arrives (security review, finding 8).
 */
export function forgetPreviousUser(queryClient: QueryClient): void {
  queryClient.clear();
  clearAllDrafts();
}

/**
 * Sign out on the server and forget everything here. The local half happens whatever the
 * server answers: a sign-out that failed on a dropped connection must still leave the device
 * signed out, and the session it could not revoke expires on its own.
 */
export async function signOutEverywhereHere(queryClient: QueryClient, clearSession: () => void): Promise<void> {
  try {
    await apiRequest('/auth/logout', { method: 'POST' });
  } catch {
    /* signed out here regardless — see above */
  } finally {
    forgetPreviousUser(queryClient);
    clearSession();
  }
}

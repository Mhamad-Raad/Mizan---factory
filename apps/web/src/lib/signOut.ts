import type { QueryClient } from '@tanstack/react-query';
import { ApiError, apiRequest } from './api.js';
import { clearDraftsExcept } from './drafts.js';
import { endSharedRecord, markIdleNotice } from './idleSignOut.js';

/**
 * Forget everything the previous person left on this device: every cached answer (their
 * customers, balances, prices) and their unsaved drafts (2.10.2). Used on sign-out and when
 * somebody signs in or takes over the tablet, so the next person never sees the last one's data
 * in the moment before their own arrives (security review, finding 8).
 *
 * `keepDraftsOf` is the user signing in: their own drafts stay (a session that expired is not a
 * sign-out), everybody else's go. Left out, as on sign-out, every draft goes.
 */
export function forgetPreviousUser(queryClient: QueryClient, keepDraftsOf: string | null = null): void {
  queryClient.clear();
  clearDraftsExcept(keepDraftsOf);
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
    // The other tabs of this browser share the session, and follow it out.
    endSharedRecord();
    forgetPreviousUser(queryClient);
    clearSession();
  }
}

/**
 * An idle sign-out the server has not confirmed yet. Kept in storage, so every tab of the
 * browser — and a reload — knows the cookie it still holds must not be used: until the server
 * has ended that session, asking "who am I" would sign the screen straight back in.
 */
const PENDING_KEY = 'mizan.signOutPending.v1';

function hasPendingSignOut(): boolean {
  try {
    return window.localStorage.getItem(PENDING_KEY) === '1';
  } catch {
    return false;
  }
}

function setPendingSignOut(pending: boolean): void {
  try {
    if (pending) window.localStorage.setItem(PENDING_KEY, '1');
    else window.localStorage.removeItem(PENDING_KEY);
  } catch {
    // Storage refused: the request below is still made, and the server's own limit stands behind it.
  }
}

/** A sign-in replaces whatever session the browser held: nothing is left to end. */
export function clearPendingSignOut(): void {
  setPendingSignOut(false);
}

/** The request that ends an idle session, while it is out: one at a time. */
let idleSignOutRequest: Promise<void> | undefined;

/** Tells the server. A refusal means there was no session left to end; anything else, that nobody answered. */
function tellServerOfIdleSignOut(): Promise<void> {
  idleSignOutRequest ??= apiRequest<void>('/auth/logout?reason=idle', { method: 'POST' })
    .then(
      () => setPendingSignOut(false),
      (error: unknown) => {
        if (error instanceof ApiError && error.status < 500) setPendingSignOut(false);
        else throw error;
      },
    )
    .finally(() => {
      idleSignOutRequest = undefined;
    });
  return idleSignOutRequest;
}

/**
 * Waited for before the session is asked for, and before a sign-in: an idle sign-out still on
 * its way is finished first, and one the server never heard of is sent again. It throws while
 * the server cannot be reached — the screen then stays signed out, which is what it was told.
 */
export async function idleSignOutSettled(): Promise<void> {
  if (idleSignOutRequest) await idleSignOutRequest;
  else if (hasPendingSignOut()) await tellServerOfIdleSignOut();
}

/**
 * Ends a session nobody has touched for the idle limit (D-078). The screen goes first — what is
 * on it is no longer anyone's, and the server may take its time — then the server is told, so
 * the cookie left in the browser is worth nothing. The sign-in page says why.
 *
 * The cache goes, as on every sign-out. The drafts stay: they are stored under their owner's
 * id and offered to nobody else, and fifteen minutes away from a half-typed order must not cost
 * the order.
 */
export function signOutForInactivity(queryClient: QueryClient, clearSession: () => void): void {
  leaveIdleSession();
  queryClient.clear();
  clearSession();
}

/** Another tab ended the session this one shares with it: this tab follows, with no request of its own. */
export function followSignOutElsewhere(queryClient: QueryClient, clearSession: () => void): void {
  queryClient.clear();
  clearSession();
}

/**
 * The half of an idle sign-out that needs no screen — also run on a page load, before the
 * session is asked for, when the record says nobody has touched the app for the whole limit: a
 * browser closed, or a device asleep, past it starts signed out (D-078).
 */
export function leaveIdleSession(): void {
  markIdleNotice();
  setPendingSignOut(true);
  endSharedRecord();
  // Unreachable now: it stays pending, and is sent again before the session is next asked for.
  tellServerOfIdleSignOut().catch(() => undefined);
}

import { useSyncExternalStore } from 'react';
import { SESSION_IDLE_MINUTES, SESSION_IDLE_WARNING_SECONDS } from '@mizan/permissions';
import { useApp } from './store.js';

/**
 * The idle sign-out (D-078): a user who does nothing for fifteen minutes is signed out. The
 * browser measures it, since only it sees activity — a key, a press, a touch, a scroll or a
 * move of the pointer in any tab of the app keeps the session of all of them. The last minute
 * is a warning that a press or a key answers; a browser opened again after the limit starts
 * signed out. The server stands behind it for a session no browser ended (`SESSION_IDLE_MS`).
 *
 * Beside the idle *lock* of `idle.ts`, which hides a shared tablet's screen sooner and asks
 * for the password; this ends the session.
 */
export const IDLE_LIMIT_MS = SESSION_IDLE_MINUTES * 60_000;
const WARNING_MS = SESSION_IDLE_WARNING_SECONDS * 1_000;
/** The shared record is written at most this often: every key press would otherwise be a storage write. */
const WRITE_EVERY_MS = 5_000;
const CHECK_EVERY_MS = 1_000;
/** What counts as the user being there. Moving the pointer does: someone reading a report is not idle. */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
/**
 * Once the warning is up it wants an answer — a press, a key, a touch — and these are not one:
 * a pointer on its way to "Stay signed in" would otherwise take the warning from under it.
 */
const NOT_AN_ANSWER: ReadonlySet<string> = new Set(['pointermove', 'wheel', 'scroll']);

/**
 * What the tabs of one browser share, and what survives a reload: when the user last did
 * something, and that the last session ended for inactivity. Two plain values, never a token.
 */
export const ACTIVITY_KEY = 'mizan.lastActivity.v1';
const NOTICE_KEY = 'mizan.idleSignedOut.v1';

/** The moment of the last activity in any tab, or null when none is on record (signed out, or storage refused). */
export function readLastActivity(): number | null {
  try {
    const at = Number(window.localStorage.getItem(ACTIVITY_KEY));
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

function writeLastActivity(at: number): void {
  try {
    window.localStorage.setItem(ACTIVITY_KEY, String(at));
  } catch {
    // Storage refused: each tab counts its own idle time, and the server's limit covers a reopened browser.
  }
}

/** The sign-in page says why the user is looking at it. */
export function hasIdleNotice(): boolean {
  try {
    return window.localStorage.getItem(NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}

export function markIdleNotice(): void {
  try {
    window.localStorage.setItem(NOTICE_KEY, '1');
  } catch {
    // Storage refused: the sign-in page shows without the explanation.
  }
}

export function clearIdleNotice(): void {
  try {
    window.localStorage.removeItem(NOTICE_KEY);
  } catch {
    // Nothing stored.
  }
}

/** This tab's own last activity; other tabs' reaches it through the shared record. */
let ownActivity = 0;
let lastWritten = 0;
let trailingWrite: ReturnType<typeof setTimeout> | undefined;
/**
 * This tab has read a record of the session it holds. From then on a missing record means
 * another tab ended that session — the tabs of a browser share one — and not that nothing was
 * written yet.
 */
let recordSeen = false;
/** Seconds until the sign-out while the warning shows, otherwise null. */
let secondsLeft: number | null = null;
const listeners = new Set<() => void>();

function signedIn(): boolean {
  return useApp.getState().user !== null;
}

function setSecondsLeft(next: number | null): void {
  if (next === secondsLeft) return;
  secondsLeft = next;
  for (const listener of listeners) listener();
}

function sharedActivity(): number {
  const at = readLastActivity();
  if (at !== null) recordSeen = true;
  return at ?? 0;
}

function write(at: number, now: number): void {
  clearTimeout(trailingWrite);
  trailingWrite = undefined;
  lastWritten = now;
  writeLastActivity(at);
}

/**
 * Called for every sign of life, and by "Stay signed in". The record other tabs read is written
 * at once or, inside the throttle, when it ends: a tab must never count from an activity older
 * than the last one by more than that.
 */
export function noteActivity(now = Date.now()): void {
  ownActivity = now;
  // Answered: the warning goes at once, not at the next look at the clock.
  setSecondsLeft(null);
  const wait = lastWritten + WRITE_EVERY_MS - now;
  if (wait <= 0) write(now, now);
  else trailingWrite ??= setTimeout(() => write(ownActivity, Date.now()), wait);
}

/**
 * The tab that ends a session — a sign-out, the idle limit, a refusal by the server — removes
 * the record its other tabs count from, which is how they learn of it.
 */
export function endSharedRecord(): void {
  clearTimeout(trailingWrite);
  trailingWrite = undefined;
  try {
    window.localStorage.removeItem(ACTIVITY_KEY);
  } catch {
    // Nothing stored.
  }
}

/**
 * A session starts, or a page of it is loaded — which is the user being there: whatever was on
 * record is replaced. (A load after the whole limit has passed is refused first: `wasLeftIdle`.)
 */
export function startActivity(now = Date.now()): void {
  lastWritten = 0;
  noteActivity(now);
}

/**
 * True when the record says nobody has touched the app for the whole limit — asked on a page
 * load, before the session is: a browser closed last night must not open signed in this morning.
 */
export function wasLeftIdle(now = Date.now()): boolean {
  const last = readLastActivity();
  return last !== null && now - last >= IDLE_LIMIT_MS;
}

/** "Stay signed in", and anything else that dismisses the warning — while there is still a session to keep. */
export function answerWarning(): void {
  if (signedIn()) noteActivity();
}

/** This tab has nothing left to count: its session is over, however that happened. */
function forget(): void {
  clearTimeout(trailingWrite);
  trailingWrite = undefined;
  ownActivity = 0;
  lastWritten = 0;
  recordSeen = false;
  setSecondsLeft(null);
}

export interface IdleWatch {
  /** The limit has passed with nothing done in any tab: sign the user out. */
  expire: () => void;
  /** Another tab ended the session this one shares with it — signed out there, or idle a moment sooner. */
  endedElsewhere: () => void;
}

/**
 * Starts the watch, and returns how to stop it: any activity in any tab keeps the session, the
 * warning counts the last minute down, and at the limit `expire` signs the user out. Timers
 * sleep with the laptop and crawl in a hidden tab, so the clock is asked again whenever the
 * page is looked at.
 */
export function watchForIdleness(on: IdleWatch): () => void {
  const check = (): void => {
    if (!signedIn()) return;
    const now = Date.now();
    const shared = sharedActivity();
    if (shared === 0 && recordSeen) {
      // The record this tab was counting from is gone: the session was ended in another tab.
      on.endedElsewhere();
      return;
    }
    // Nothing on record and nothing done here: a session just restored, or storage refused —
    // this tab counts from now.
    if (shared === 0 && ownActivity === 0) startActivity(now);
    const remaining = Math.max(ownActivity, shared) + IDLE_LIMIT_MS - now;
    if (remaining > 0) setSecondsLeft(remaining <= WARNING_MS ? Math.ceil(remaining / 1_000) : null);
    else on.expire();
  };

  const activity = (event: Event): void => {
    if (!signedIn()) return;
    if (secondsLeft !== null) {
      if (NOT_AN_ANSWER.has(event.type)) return;
      // Escape answers the warning and nothing else: the sheet open underneath it, which
      // listens for the same key, keeps what was typed into it.
      if (event instanceof KeyboardEvent && event.key === 'Escape') event.stopPropagation();
    } else {
      // A screen seen again after the limit is signed out, rather than the return counted as
      // activity: a sleeping laptop's timers may not have run yet when the lid is lifted.
      const last = Math.max(ownActivity, sharedActivity());
      if (last !== 0 && Date.now() - last >= IDLE_LIMIT_MS) return check();
    }
    noteActivity();
  };

  // Told at once when another tab removes the record, rather than at the next look at the clock.
  const storage = (event: StorageEvent): void => {
    if (event.key !== ACTIVITY_KEY || event.newValue !== null) return;
    // The event may be an old one, delivered to a tab the browser had put to sleep: if a record
    // is there now, a session has been started since, and this is not the news of its end.
    if (readLastActivity() !== null) return;
    if (signedIn()) on.endedElsewhere();
  };

  // Signed out, however it happened. The shared record is not removed here — that is
  // `endSharedRecord`, for the tab that ends the session; one that only follows would otherwise
  // remove the record of a session started since.
  const stopFollowing = useApp.subscribe((state, previous) => {
    if (previous.user !== null && state.user === null) forget();
  });

  for (const type of ACTIVITY_EVENTS) window.addEventListener(type, activity, { capture: true, passive: true });
  const timer = window.setInterval(check, CHECK_EVERY_MS);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
  window.addEventListener('pageshow', check);
  window.addEventListener('storage', storage);

  return () => {
    for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, activity, { capture: true });
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', check);
    window.removeEventListener('focus', check);
    window.removeEventListener('pageshow', check);
    window.removeEventListener('storage', storage);
    stopFollowing();
    forget();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Seconds until the idle sign-out while its warning shows, otherwise null. */
export function useIdleSecondsLeft(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => secondsLeft,
    () => secondsLeft,
  );
}

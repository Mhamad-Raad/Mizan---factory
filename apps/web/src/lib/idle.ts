import { useEffect, useRef } from 'react';

/** The events that mean somebody is using the screen. */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll'] as const;

/** How often the clock is looked at; the lock lands at most this late. */
const CHECK_EVERY_MS = 15_000;

/**
 * The last activity of *any* tab of this browser, so one tab's idle clock sees the others'.
 * Written at most once a second — `pointermove` arrives far more often than that.
 */
export const SHARED_ACTIVITY_KEY = 'mizan.idle.v1';
const SHARE_EVERY_MS = 1_000;

/**
 * How often, at most, working without saving tells the server somebody is there. The server
 * locks a session that has sent nothing for its idle minutes plus one, and moves its "last
 * seen" at most once a minute, so once a minute is enough and more is waste.
 */
export const KEEP_ALIVE_EVERY_MS = 60_000;

interface SharedActivity {
  at: number;
  /** Which tab it was, so the last one used can lock the session while hidden. */
  tab: string;
}

function readShared(): SharedActivity | null {
  try {
    const raw = window.localStorage.getItem(SHARED_ACTIVITY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SharedActivity> | null;
    if (!parsed || typeof parsed.at !== 'number' || typeof parsed.tab !== 'string') return null;
    return { at: parsed.at, tab: parsed.tab };
  } catch {
    return null;
  }
}

function writeShared(activity: SharedActivity): void {
  try {
    window.localStorage.setItem(SHARED_ACTIVITY_KEY, JSON.stringify(activity));
  } catch {
    // Storage refused (private mode, quota): this tab keeps its own clock, as before.
  }
}

function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

export interface IdleClockOptions {
  /**
   * Called — at most once a minute, only while this tab is visible and not idle — while
   * somebody is working, so a long form typed without saving is not locked mid-way by a server
   * that only sees requests.
   */
  keepAlive?: () => void;
}

/**
 * Idle auto-lock (FR-106, spec 2.8): after `minutes` without a touch, a key or a scroll, `onIdle`
 * runs once. `null` — the server's "never" for this device, or an older API that does not say —
 * sets no timer at all.
 *
 * The clock is a timestamp compared on an interval rather than one long timeout, because a
 * browser throttles the timers of a hidden tab and a tablet sleeps: coming back to the tab is
 * therefore checked *first*, so a screen left for an hour locks the moment it is seen again
 * instead of counting the return as fresh activity.
 */
export function useIdleLock(minutes: number | null, onIdle: () => void, keepAlive?: () => void): void {
  const callback = useRef(onIdle);
  const beat = useRef(keepAlive);
  useEffect(() => {
    callback.current = onIdle;
    beat.current = keepAlive;
  }, [onIdle, keepAlive]);

  useEffect(
    () =>
      startIdleClock(minutes, () => callback.current(), {
        keepAlive: () => beat.current?.(),
      }),
    [minutes],
  );
}

/**
 * The clock behind `useIdleLock`, without React: starts watching, and returns how to stop.
 *
 * The lock is the *session's* (POST /auth/lock locks every tab), so the clock is the browser's:
 * each tab shares its last activity through storage, and a tab counts as idle only when every
 * tab has been. A forgotten background tab then no longer locks the one being worked in. Of the
 * idle tabs, the visible one — or, when none is, the one used last — is the one that locks; the
 * others lock when they are next seen, or when the server refuses them.
 */
export function startIdleClock(
  minutes: number | null,
  onIdle: () => void,
  options: IdleClockOptions = {},
): () => void {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return () => undefined;
  const limit = minutes * 60_000;
  // Not a credential: only tells this tab's entries in storage from another's.
  const tab = Math.random().toString(36).slice(2);
  let last = Date.now();
  let shared = 0;
  let beaten = last;
  let fired = false;

  const share = (now: number): void => {
    if (now - shared < SHARE_EVERY_MS) return;
    shared = now;
    writeShared({ at: now, tab });
  };
  share(last);

  const check = (): boolean => {
    if (fired) return true;
    const now = Date.now();
    const other = readShared();
    const newest = Math.max(last, other?.at ?? 0);
    if (now - newest < limit) return false;
    // Idle everywhere. A hidden tab that was not the last one used leaves the lock to the tab
    // that was, and locks itself when it is seen again.
    if (!isVisible() && other !== null && other.tab !== tab && other.at > last) return false;
    fired = true;
    onIdle();
    return true;
  };
  const activity = (): void => {
    if (check()) return;
    const now = Date.now();
    last = now;
    share(now);
    if (options.keepAlive && isVisible() && now - beaten >= KEEP_ALIVE_EVERY_MS) {
      beaten = now;
      options.keepAlive();
    }
  };
  const visibility = (): void => {
    if (isVisible()) activity();
  };

  for (const name of ACTIVITY_EVENTS) window.addEventListener(name, activity, { passive: true, capture: true });
  document.addEventListener('visibilitychange', visibility);
  const timer = window.setInterval(check, Math.min(CHECK_EVERY_MS, limit));
  return () => {
    for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, activity, { capture: true });
    document.removeEventListener('visibilitychange', visibility);
    window.clearInterval(timer);
  };
}

import { useEffect, useRef } from 'react';

/** The events that mean somebody is using the screen. */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll'] as const;

/** How often the clock is looked at; the lock lands at most this late. */
const CHECK_EVERY_MS = 15_000;

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
export function useIdleLock(minutes: number | null, onIdle: () => void): void {
  const callback = useRef(onIdle);
  useEffect(() => {
    callback.current = onIdle;
  }, [onIdle]);

  useEffect(() => startIdleClock(minutes, () => callback.current()), [minutes]);
}

/** The clock behind `useIdleLock`, without React: starts watching, and returns how to stop. */
export function startIdleClock(minutes: number | null, onIdle: () => void): () => void {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return () => undefined;
  const limit = minutes * 60_000;
  let last = Date.now();
  let fired = false;

  const check = (): boolean => {
    if (!fired && Date.now() - last >= limit) {
      fired = true;
      onIdle();
    }
    return fired;
  };
  const activity = (): void => {
    if (!check()) last = Date.now();
  };
  const visibility = (): void => {
    if (document.visibilityState === 'visible') activity();
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

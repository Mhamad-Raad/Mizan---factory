import { useEffect, useRef, useState } from 'react';

/**
 * Whether this device should be animated at all (spec 3.6.1, "Budget" and "Reduced motion").
 *
 * Three ways to say no, and each of them is somebody's real device: the reader asked the system
 * for less motion; the phone reports two cores or fewer, where a rolling total costs frames
 * that the form needs; or the browser is in data-saving mode, which on a factory floor usually
 * means a metered connection and an old handset. The answer is read per call rather than
 * cached, because a tablet can be put into reduced-motion mode in the middle of a shift.
 */
export function motionAllowed(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;

  const navigatorWithData = navigator as Navigator & { connection?: { saveData?: boolean } };
  if (navigatorWithData.connection?.saveData) return false;
  if (typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency <= 2) return false;
  return true;
}

/** The same question as a hook, re-answered when the reader changes the system setting. */
export function useMotionAllowed(): boolean {
  const [allowed, setAllowed] = useState(motionAllowed);

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const update = (): void => setAllowed(motionAllowed());
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return allowed;
}

/** How long a list may stagger for: eight rows at 30 ms, and nothing beyond fifty (3.6.1). */
export function staggerDelay(index: number, listLength: number, allowed = motionAllowed()): string | undefined {
  if (!allowed || listLength > 50 || index > 7) return undefined;
  return `${index * 30}ms`;
}

/**
 * A number that rolls to its new value (signature moment 1: "the total ticks").
 *
 * The roll is an *interpolation of the value*, not a stack of sliding digit strips: with
 * tabular figures the width is stable, so the cheap version is indistinguishable from the
 * expensive one on the devices this runs on — and it degrades to "the number just updates"
 * by returning the target immediately when motion is not allowed (3.6.1).
 */
export function useRollingNumber(target: number, durationMs = 300): number {
  const allowed = useMotionAllowed();
  const [shown, setShown] = useState(target);
  /** Where the next roll starts from, kept in a ref so it is not a dependency of the roll. */
  const from = useRef(target);

  useEffect(() => {
    if (!allowed || from.current === target) {
      from.current = target;
      return;
    }
    const start = from.current;
    const started = performance.now();
    let frame = requestAnimationFrame(function step(now: number) {
      const progress = Math.min(1, (now - started) / durationMs);
      // Ease-out, the same curve as every other micro-interaction (3.6.1).
      const eased = 1 - (1 - progress) ** 3;
      const value = progress === 1 ? target : Math.round(start + (target - start) * eased);
      from.current = value;
      setShown(value);
      if (progress < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, allowed, durationMs]);

  // Without motion the figure is simply the figure: no state, nothing to catch up with.
  return allowed ? shown : target;
}

/**
 * True for the length of one sweep after a figure reaches zero (signature moment 2: "balance
 * settles", spec 3.6.2).
 *
 * Only a *transition* counts: opening a card that was already settled is not a moment, and
 * animating it would be a lie about what just happened. Nothing fires when motion is not
 * allowed, so the chip simply says Paid.
 */
export function useJustSettled(remaining: number, durationMs = 700): boolean {
  const allowed = useMotionAllowed();
  const previous = useRef<number | null>(null);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    const before = previous.current;
    previous.current = remaining;
    if (!allowed || before === null) return;
    if (before > 0 && remaining <= 0) {
      setSettled(true);
      const timer = setTimeout(() => setSettled(false), durationMs);
      return () => clearTimeout(timer);
    }
  }, [remaining, allowed, durationMs]);

  return settled;
}

/**
 * The row that just arrived at the top of a list (signature moment 3: "the row lands", spec
 * 3.6.2).
 *
 * The caller bumps `version` after a write that adds a row — a payment, a credit — and the row
 * that is newest *at that point* holds the highlight for 600 ms. Keyed on the version rather
 * than on the id, because the id only becomes known when the refreshed list arrives, which is
 * exactly the moment the highlight should start.
 */
export function useLandedFirstRow(firstId: string | null, version: number, durationMs = 600): string | null {
  const allowed = useMotionAllowed();
  const armed = useRef(0);
  const [landed, setLanded] = useState<string | null>(null);

  useEffect(() => {
    if (!allowed || version === armed.current) return;
    armed.current = version;
    if (!firstId) return;

    // A frame later on purpose: the row is painted first and *then* highlights, so the
    // highlight reads as the row landing rather than as the page arriving.
    let timer = 0;
    const frame = requestAnimationFrame(() => {
      setLanded(firstId);
      timer = window.setTimeout(() => setLanded(null), durationMs);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [firstId, version, allowed, durationMs]);

  return landed;
}

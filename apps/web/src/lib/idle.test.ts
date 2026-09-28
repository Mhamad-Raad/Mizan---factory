import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARED_ACTIVITY_KEY, startIdleClock } from './idle.js';

/**
 * Idle auto-lock (FR-106, spec 2.8). The client had no timer at all, so a shared tablet left on
 * a bench stayed signed in to whoever used it last until somebody pressed the padlock.
 */
describe('the idle clock', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it('locks once after the timeout passes without activity', () => {
    const onIdle = vi.fn();
    const stop = startIdleClock(5, onIdle);
    vi.advanceTimersByTime(4 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(onIdle).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(30 * 60_000);
    expect(onIdle).toHaveBeenCalledOnce();
    stop();
  });

  it('starts again from every touch or key', () => {
    const onIdle = vi.fn();
    const stop = startIdleClock(5, onIdle);
    vi.advanceTimersByTime(4 * 60_000);
    window.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(4 * 60_000);
    window.dispatchEvent(new Event('keydown'));
    vi.advanceTimersByTime(4 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(onIdle).toHaveBeenCalledOnce();
    stop();
  });

  it('locks a screen seen again after the timeout, rather than counting the return as activity', () => {
    const onIdle = vi.fn();
    const stop = startIdleClock(5, onIdle);
    // A hidden tab's interval may never run; the clock itself moves on.
    vi.setSystemTime(Date.now() + 60 * 60_000);
    window.dispatchEvent(new Event('pointerdown'));
    expect(onIdle).toHaveBeenCalledOnce();
    stop();
  });

  it('sets no timer when the device never locks, or the API does not say', () => {
    const onIdle = vi.fn();
    const stop = startIdleClock(null, onIdle);
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();
    stop();
  });

  it('stops watching when stopped', () => {
    const onIdle = vi.fn();
    startIdleClock(1, onIdle)();
    vi.advanceTimersByTime(10 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

/** Another tab of the same browser, touched just now. */
function otherTabActive(): void {
  window.localStorage.setItem(SHARED_ACTIVITY_KEY, JSON.stringify({ at: Date.now(), tab: 'other-tab' }));
}

/**
 * The lock is the session's — POST /auth/lock locks every tab — while the clock was each tab's,
 * so a background tab forgotten for five minutes locked the tab being worked in (review).
 */
describe('the idle clock across tabs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });
  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
    setVisibility('visible');
  });

  it('does not lock while another tab is being used', () => {
    const onIdle = vi.fn();
    const stop = startIdleClock(5, onIdle);
    vi.advanceTimersByTime(4 * 60_000);
    otherTabActive();
    vi.advanceTimersByTime(4 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();
    // Five minutes after the other tab's last touch, every tab has been idle.
    vi.advanceTimersByTime(60_000);
    expect(onIdle).toHaveBeenCalledOnce();
    stop();
  });

  it('shares its own activity with the other tabs', () => {
    const stop = startIdleClock(5, vi.fn());
    vi.advanceTimersByTime(2 * 60_000);
    window.dispatchEvent(new Event('keydown'));
    const shared = JSON.parse(window.localStorage.getItem(SHARED_ACTIVITY_KEY) ?? 'null') as { at: number };
    expect(shared.at).toBe(Date.now());
    stop();
  });

  it('leaves the lock to the tab used last while hidden, and locks when it is seen again', () => {
    setVisibility('hidden');
    const onIdle = vi.fn();
    const stop = startIdleClock(5, onIdle);
    vi.advanceTimersByTime(60_000);
    otherTabActive();
    vi.advanceTimersByTime(30 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(onIdle).toHaveBeenCalledOnce();
    stop();
  });

  it('locks while hidden when it was the tab used last', () => {
    setVisibility('hidden');
    const onIdle = vi.fn();
    const stop = startIdleClock(5, onIdle);
    vi.advanceTimersByTime(5 * 60_000);
    expect(onIdle).toHaveBeenCalledOnce();
    stop();
  });

  it('keeps its own clock when storage is refused', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const onIdle = vi.fn();
    const stop = startIdleClock(5, onIdle);
    vi.advanceTimersByTime(5 * 60_000);
    expect(onIdle).toHaveBeenCalledOnce();
    stop();
    spy.mockRestore();
  });
});

/**
 * The server locks a session that has sent no request for its idle minutes, so somebody typing
 * a long payment without saving was locked mid-form and lost what they typed (review).
 */
describe('the keep-alive while somebody works', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });
  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
    setVisibility('visible');
  });

  it('is sent at most once a minute however busy the screen is', () => {
    const keepAlive = vi.fn();
    const stop = startIdleClock(5, vi.fn(), { keepAlive });
    for (let second = 0; second < 185; second += 1) {
      vi.advanceTimersByTime(1_000);
      window.dispatchEvent(new Event('pointermove'));
      window.dispatchEvent(new Event('keydown'));
    }
    expect(keepAlive).toHaveBeenCalledTimes(3);
    stop();
  });

  it('is not sent without activity, while hidden, or once idle', () => {
    const keepAlive = vi.fn();
    const onIdle = vi.fn();
    const stop = startIdleClock(5, onIdle, { keepAlive });
    vi.advanceTimersByTime(4 * 60_000);
    expect(keepAlive).not.toHaveBeenCalled();

    setVisibility('hidden');
    window.dispatchEvent(new Event('scroll'));
    expect(keepAlive).not.toHaveBeenCalled();

    setVisibility('visible');
    vi.advanceTimersByTime(10 * 60_000);
    expect(onIdle).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event('pointerdown'));
    expect(keepAlive).not.toHaveBeenCalled();
    stop();
  });
});

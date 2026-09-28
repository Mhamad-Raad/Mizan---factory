import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startIdleClock } from './idle.js';

/**
 * Idle auto-lock (FR-106, spec 2.8). The client had no timer at all, so a shared tablet left on
 * a bench stayed signed in to whoever used it last until somebody pressed the padlock.
 */
describe('the idle clock', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

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

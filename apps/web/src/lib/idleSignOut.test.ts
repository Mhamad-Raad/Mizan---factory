import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_KEY,
  IDLE_LIMIT_MS,
  endSharedRecord,
  noteActivity,
  readLastActivity,
  startActivity,
  wasLeftIdle,
  watchForIdleness,
} from './idleSignOut.js';
import { useApp } from './store.js';
import type { SessionUser } from './store.js';

const START = Date.parse('2026-10-05T09:00:00Z');
const someone = { id: 'u1', username: 'rebaz', display_name: 'Rebaz' } as SessionUser;

/**
 * The idle sign-out (D-078): the business asked that a user who does nothing for fifteen
 * minutes is signed out. Until then nobody was — an open tab stayed signed in for thirty days.
 */
describe('the idle sign-out', () => {
  let expire: ReturnType<typeof vi.fn<() => void>>;
  let endedElsewhere: ReturnType<typeof vi.fn<() => void>>;
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    window.localStorage.clear();
    useApp.getState().setSession({ user: someone, permissions: [] });
    expire = vi.fn<() => void>();
    endedElsewhere = vi.fn<() => void>();
    stop = watchForIdleness({ expire, endedElsewhere });
    startActivity();
  });
  afterEach(() => {
    stop();
    useApp.getState().clearSession();
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it('signs out once fifteen minutes pass with nothing done', () => {
    expect(IDLE_LIMIT_MS).toBe(15 * 60_000);
    vi.advanceTimersByTime(IDLE_LIMIT_MS - 1_000);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(expire).toHaveBeenCalled();
  });

  it('starts again from every key, press and move of the pointer', () => {
    vi.advanceTimersByTime(10 * 60_000);
    window.dispatchEvent(new Event('keydown'));
    vi.advanceTimersByTime(10 * 60_000);
    window.dispatchEvent(new Event('pointermove'));
    vi.advanceTimersByTime(10 * 60_000);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5 * 60_000);
    expect(expire).toHaveBeenCalled();
  });

  it('counts from the latest activity of any tab', () => {
    vi.advanceTimersByTime(14 * 60_000);
    // Another tab was at work a moment ago.
    window.localStorage.setItem(ACTIVITY_KEY, String(Date.now()));
    vi.advanceTimersByTime(14 * 60_000);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(expire).toHaveBeenCalled();
  });

  it('writes the shared record at once, then at most every five seconds — never left behind the last activity', () => {
    expect(readLastActivity()).toBe(START);
    vi.advanceTimersByTime(1_000);
    noteActivity();
    vi.advanceTimersByTime(3_000);
    noteActivity();
    // Inside the throttle: other tabs still read the first write.
    expect(readLastActivity()).toBe(START);
    // When it ends the latest activity is written, with nothing more done in this tab.
    vi.advanceTimersByTime(1_000);
    expect(readLastActivity()).toBe(START + 4_000);
  });

  it('warns for the last minute, and a moving pointer does not answer the warning — a press does', () => {
    vi.advanceTimersByTime(IDLE_LIMIT_MS - 30_000);
    window.dispatchEvent(new Event('pointermove'));
    vi.advanceTimersByTime(30_000);
    expect(expire).toHaveBeenCalledOnce();

    expire.mockClear();
    startActivity();
    vi.advanceTimersByTime(IDLE_LIMIT_MS - 30_000);
    window.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(30_000);
    expect(expire).not.toHaveBeenCalled();
  });

  it('signs out a screen seen again after the limit, rather than counting the return as activity', () => {
    // A sleeping laptop: the clock moved on, and no timer ran.
    vi.setSystemTime(START + 60 * 60_000);
    window.dispatchEvent(new Event('pointermove'));
    expect(expire).toHaveBeenCalledOnce();
  });

  it('signs out a press that answers the warning too late, after the limit', () => {
    vi.advanceTimersByTime(IDLE_LIMIT_MS - 30_000);
    // The warning is up; the laptop sleeps past the limit and no timer runs.
    vi.setSystemTime(START + IDLE_LIMIT_MS + 5 * 60_000);
    window.dispatchEvent(new Event('keydown'));
    expect(expire).toHaveBeenCalledOnce();
  });

  it('follows a sign-out made in another tab', () => {
    vi.advanceTimersByTime(2_000);
    // The other tab ended the session and removed the record.
    endSharedRecord();
    vi.advanceTimersByTime(1_000);
    expect(endedElsewhere).toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
  });

  it('counts nothing while nobody is signed in', () => {
    useApp.getState().clearSession();
    vi.advanceTimersByTime(2 * IDLE_LIMIT_MS);
    expect(expire).not.toHaveBeenCalled();
    expect(endedElsewhere).not.toHaveBeenCalled();
  });

  it('knows a browser opened again after the limit from one opened in time, and from one with no record', () => {
    vi.setSystemTime(START + IDLE_LIMIT_MS - 1);
    expect(wasLeftIdle()).toBe(false);
    vi.setSystemTime(START + IDLE_LIMIT_MS);
    expect(wasLeftIdle()).toBe(true);
    window.localStorage.clear();
    expect(wasLeftIdle()).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../common/errors.js';
import type { Env } from '../config/env.js';
import { SignInAddressLimiter, addressKey } from './sign-in-throttle.js';

const limiter = (limit = 3, blockMinutes = 5) =>
  new SignInAddressLimiter({
    SIGN_IN_FAILURES_PER_HOUR: limit,
    SIGN_IN_BLOCK_MINUTES: blockMinutes,
  } as Env);

function refusedMinutes(work: () => unknown): number | null {
  try {
    work();
    return null;
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'RATE_LIMITED') throw error;
    return (error.params as { minutes: number }).minutes;
  }
}

const fail = (subject: SignInAddressLimiter, ip = '198.51.100.1') => subject.begin(ip)(true);
const succeed = (subject: SignInAddressLimiter, ip = '198.51.100.1') => subject.begin(ip)(false);

describe('the per-address ceiling on wrong passwords', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T08:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts IPv6 by its /64 and IPv4 as it is', () => {
    expect(addressKey('2001:db8:1:2::1')).toBe(addressKey('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect(addressKey('2001:db8:1:2::1')).not.toBe(addressKey('2001:db8:1:3::1'));
    expect(addressKey('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(addressKey('203.0.113.5')).toBe('203.0.113.5');
    expect(addressKey(null)).toBe('unknown');
  });

  it('never counts a right password', () => {
    const subject = limiter();
    for (let index = 0; index < 500; index += 1) succeed(subject);
    expect(refusedMinutes(() => subject.begin('198.51.100.1'))).toBeNull();
  });

  it('blocks for a few minutes at the ceiling, then lets the address try again', () => {
    const subject = limiter();
    fail(subject);
    fail(subject);
    fail(subject);
    expect(refusedMinutes(() => subject.begin('198.51.100.1'))).toBe(5);
    // Another address is untouched.
    expect(refusedMinutes(() => subject.begin('198.51.100.2'))).toBeNull();

    vi.advanceTimersByTime(5 * 60_000);
    expect(refusedMinutes(() => succeed(subject))).toBeNull();
  });

  it('doubles the block for each further one within a day, up to an hour', () => {
    const subject = limiter();
    const blocks: (number | null)[] = [];
    for (let round = 0; round < 6; round += 1) {
      for (let index = 0; index < 3; index += 1) fail(subject);
      const minutes = refusedMinutes(() => subject.begin('198.51.100.1'));
      blocks.push(minutes);
      vi.advanceTimersByTime((minutes ?? 0) * 60_000);
    }
    expect(blocks).toEqual([5, 10, 20, 40, 60, 60]);
  });

  it('forgets failures older than an hour', () => {
    const subject = limiter();
    fail(subject);
    fail(subject);
    vi.advanceTimersByTime(60 * 60_000);
    fail(subject);
    fail(subject);
    expect(refusedMinutes(() => subject.begin('198.51.100.1'))).toBeNull();
  });

  it('counts checks under way, so a parallel burst cannot pass the ceiling', () => {
    const subject = limiter();
    const pending = [
      subject.begin('198.51.100.1'),
      subject.begin('198.51.100.1'),
      subject.begin('198.51.100.1'),
    ];
    expect(refusedMinutes(() => subject.begin('198.51.100.1'))).toBe(1);
    // A check that succeeds gives its place back.
    pending[0]?.(false);
    expect(refusedMinutes(() => subject.begin('198.51.100.1')(false))).toBeNull();
  });

  const network = (n: number) =>
    `2001:db8:${(n >> 16).toString(16)}:${(n & 0xffff).toString(16)}::1`;

  it('remembers at most 100,000 addresses, however many networks an attacker walks through', () => {
    const subject = limiter(100);
    for (let n = 0; n < 150_000; n++) fail(subject, network(n));
    expect(subject.size).toBeLessThanOrEqual(100_000);
    // The newest networks are the ones still counted.
    for (let n = 0; n < 99; n++) fail(subject, network(149_999));
    expect(refusedMinutes(() => subject.begin(network(149_999)))).toBe(5);
  });

  it('never forgets an address whose check is still under way', () => {
    const subject = limiter(100);
    const pending = subject.begin('198.51.100.9');
    for (let n = 0; n < 110_000; n++) fail(subject, network(n));
    pending(true);
    for (let n = 0; n < 99; n++) fail(subject, '198.51.100.9');
    expect(refusedMinutes(() => subject.begin('198.51.100.9'))).toBe(5);
  });
});

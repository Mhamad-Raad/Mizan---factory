import { Inject, Injectable } from '@nestjs/common';
import { normalizeIp } from '@nestjs/throttler';
import { ApiError } from '../common/errors.js';
import { ENV } from '../config/env.js';
import type { Env } from '../config/env.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** However often an address is blocked, one block never lasts longer than this. */
const MAX_BLOCK_MS = HOUR_MS;
/** Above this many tracked addresses, the ones with nothing left to remember are dropped. */
const PRUNE_ABOVE = 10_000;
/**
 * However many addresses are still counting, no more than this are remembered: past it the
 * oldest are forgotten. An attacker walking through IPv6 networks would otherwise grow the map
 * for an hour; forgetting one of them only lets that address try again, and the per-account
 * lockout, which lives in the database, still holds.
 */
const MAX_TRACKED = 100_000;

type Entry = {
  /** Wrong passwords in the current hour, which starts at the first of them. */
  failures: number;
  windowStart: number;
  /** Password checks under way from this address, counted as failures until they succeed. */
  inFlight: number;
  blockedUntil: number;
  /** Blocks in the last day: each doubles the next one, so a patient sprayer gains little. */
  strikes: number;
  lastBlockAt: number;
};

/**
 * What an address is counted under. IPv4 as it is; IPv6 by its /64, which is what one home or
 * one phone is handed, so walking through the addresses of one network does not start a fresh
 * count each time; an IPv4 address written as IPv6 (`::ffff:1.2.3.4`) as the IPv4 address.
 */
export function addressKey(ip: string | null | undefined): string {
  if (!ip) return 'unknown';
  return normalizeIp(ip) ?? ip;
}

/**
 * A ceiling on **wrong passwords** per network address, across every account and every door
 * where a password is typed — sign-in, unlock and change-password (security review, finding 4,
 * and its follow-up). The per-account lockout (2.8) stops guessing one account's password; this
 * stops one address trying a few passwords against *every* account, which the per-account count
 * cannot see.
 *
 * Only failures count. Every employee reaches the server from the factory's one public address,
 * shared tablets lock themselves after a few idle minutes and are unlocked all day, and a shift
 * change is thirty sign-ins at once — none of which is a failure, so none of it can trip this.
 * The ceiling (`SIGN_IN_FAILURES_PER_HOUR`, 100 by default) is far above what honest typos
 * reach, and a block is short (`SIGN_IN_BLOCK_MINUTES`, 5), doubling for each further block
 * within a day, up to an hour.
 *
 * A check under way is counted as a failure until it succeeds, so a burst of parallel guesses
 * across many usernames cannot all slip in under the ceiling before any of them is recorded.
 *
 * The address is `request.ip`, which Express resolves from `X-Forwarded-For` only as far as
 * `TRUST_PROXY` allows — a client cannot pick its own address by writing that header.
 *
 * Counted in the API process's memory. With a second replica each counts separately, which
 * doubles the ceiling and changes nothing else — the lockout, which is what protects an
 * account, lives in the database.
 */
@Injectable()
export class SignInAddressLimiter {
  private readonly entries = new Map<string, Entry>();
  /** The size at which the next prune runs: twice what the last one kept, so it stays cheap. */
  private pruneAt = PRUNE_ABOVE;
  private readonly limit: number;
  private readonly blockMs: number;

  constructor(@Inject(ENV) env: Env) {
    this.limit = env.SIGN_IN_FAILURES_PER_HOUR;
    this.blockMs = env.SIGN_IN_BLOCK_MINUTES * 60_000;
  }

  /**
   * Before a password is checked: refuses with `RATE_LIMITED` while the address is blocked, or
   * while the checks under way would take it past its ceiling; otherwise returns the function
   * that records how the check went (`true` for a wrong password).
   */
  begin(ip: string | null | undefined): (failed: boolean) => void {
    const now = Date.now();
    const entry = this.current(addressKey(ip), now);

    if (entry.blockedUntil > now) this.refuse(entry.blockedUntil - now);
    if (entry.failures + entry.inFlight >= this.limit) this.refuse(60_000);

    entry.inFlight += 1;
    let settled = false;
    return (failed: boolean) => {
      if (settled) return;
      settled = true;
      entry.inFlight -= 1;
      if (!failed) return;
      const at = Date.now();
      if (at - entry.windowStart >= HOUR_MS) {
        entry.failures = 0;
        entry.windowStart = at;
      }
      entry.failures += 1;
      if (entry.failures >= this.limit) this.block(entry, at);
    };
  }

  private block(entry: Entry, now: number): void {
    entry.strikes = now - entry.lastBlockAt < DAY_MS ? entry.strikes + 1 : 1;
    entry.lastBlockAt = now;
    entry.blockedUntil = now + Math.min(MAX_BLOCK_MS, this.blockMs * 2 ** (entry.strikes - 1));
    // The block is the penalty; after it the address starts a fresh hour.
    entry.failures = 0;
    entry.windowStart = entry.blockedUntil;
  }

  private refuse(ms: number): never {
    throw new ApiError('RATE_LIMITED', {
      minutes: Math.max(1, Math.ceil(ms / 60_000)),
      reason: 'too_many_requests',
    });
  }

  private current(key: string, now: number): Entry {
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.pruneAt) this.prune(now);
      entry = {
        failures: 0,
        windowStart: now,
        inFlight: 0,
        blockedUntil: 0,
        strikes: 0,
        lastBlockAt: -Infinity,
      };
      this.entries.set(key, entry);
    } else if (now - entry.windowStart >= HOUR_MS && entry.blockedUntil <= now) {
      entry.failures = 0;
      entry.windowStart = now;
    }
    return entry;
  }

  /** Forget addresses with nothing in flight, no block, and no failure or strike still counting. */
  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      const idle =
        entry.inFlight === 0 &&
        entry.blockedUntil <= now &&
        (entry.failures === 0 || now - entry.windowStart >= HOUR_MS) &&
        now - entry.lastBlockAt >= DAY_MS;
      if (idle) this.entries.delete(key);
    }
    // At the cap, forget the oldest down to nine tenths of it, so the next full pass is another
    // tenth of the cap away. A Map iterates in insertion order: the first entries are the oldest.
    if (this.entries.size >= MAX_TRACKED) {
      for (const [key, entry] of this.entries) {
        if (this.entries.size <= MAX_TRACKED * 0.9) break;
        if (entry.inFlight === 0) this.entries.delete(key);
      }
    }
    this.pruneAt = Math.min(MAX_TRACKED, Math.max(PRUNE_ABOVE, this.entries.size * 2));
  }

  /** How many addresses are remembered — for tests. */
  get size(): number {
    return this.entries.size;
  }
}

import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerLimitDetail, ThrottlerModuleOptions } from '@nestjs/throttler';
import { ApiError } from '../common/errors.js';
import type { Env } from '../config/env.js';

/**
 * A ceiling per network address on the doors where a password is typed — sign-in, unlock and
 * change-password (security review, finding 4). The per-account lockout (2.8) stops guessing
 * one account's password; this stops one address from trying a few passwords against *every*
 * account, which the per-account count cannot see.
 *
 * The limits are generous on purpose. Every employee on the factory floor reaches the server
 * from the same public address, and a shift change is thirty people signing in within a few
 * minutes; the defaults (30 a minute, 200 an hour, per door) leave room for that and still cut
 * an address spraying guesses to a few thousand a day. Both are set from the environment.
 *
 * Counted in the API process's memory. With a second replica each counts separately, which
 * doubles the ceiling and changes nothing else — the lockout, which is what protects an
 * account, lives in the database.
 */
export const SIGN_IN_THROTTLERS = ['sign-in-minute', 'sign-in-hour'] as const;

export function signInThrottlerOptions(env: Env): ThrottlerModuleOptions {
  return {
    throttlers: [
      { name: 'sign-in-minute', ttl: 60_000, limit: env.SIGN_IN_LIMIT_PER_MINUTE },
      { name: 'sign-in-hour', ttl: 3_600_000, limit: env.SIGN_IN_LIMIT_PER_HOUR },
    ],
  };
}

@Injectable()
export class SignInThrottleGuard extends ThrottlerGuard {
  /**
   * The address Express resolved, honouring `trust proxy` — never the left-most entry of
   * `X-Forwarded-For`, which the library's default reads and which any client can write.
   */
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    return (req.ip as string | undefined) ?? 'unknown';
  }

  /** The project's own refusal, with the minutes left, instead of Nest's English sentence. */
  protected override async throwThrottlingException(
    _context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const seconds = detail.isBlocked && detail.timeToBlockExpire > 0 ? detail.timeToBlockExpire : detail.timeToExpire;
    throw new ApiError('RATE_LIMITED', {
      minutes: Math.max(1, Math.ceil(seconds / 60)),
      reason: 'too_many_requests',
    });
  }
}

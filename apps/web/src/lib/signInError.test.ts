import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { ApiError } from './api.js';
import { signInError } from './signInError.js';

const t = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key} ${JSON.stringify(params)}` : key) as unknown as TFunction;

describe('the reading of a refused sign-in', () => {
  it('names the account lockout with the minutes left', () => {
    const error = new ApiError(429, 'RATE_LIMITED', 'errors:RATE_LIMITED', { minutes: 12 });
    expect(signInError(t, error).message).toBe('auth:locked_out {"minutes":12}');
  });

  it('tells the per-address ceiling apart from the lockout', () => {
    const error = new ApiError(429, 'RATE_LIMITED', 'errors:RATE_LIMITED', {
      minutes: 1,
      reason: 'too_many_requests',
    });
    expect(signInError(t, error).message).toBe('auth:too_many_from_network {"minutes":1}');
  });
});

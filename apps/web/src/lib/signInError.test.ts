import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { ApiError } from './api.js';
import { passwordChangeError, signInError } from './signInError.js';

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

describe('the reading of a refused password change', () => {
  it('says which rule a new password broke, not "wrong password"', () => {
    const error = new ApiError(422, 'VALIDATION_FAILED', 'errors:VALIDATION_FAILED', {}, [
      { path: 'new', code: 'TOO_SHORT', message_key: 'errors:field.password_too_short', params: { min: 8 } },
    ]);
    expect(passwordChangeError(t, error)).toBe('errors:field.password_too_short {"min":8}');
  });

  it('names a lockout with its minutes', () => {
    const error = new ApiError(429, 'RATE_LIMITED', 'errors:RATE_LIMITED', { minutes: 12 });
    expect(passwordChangeError(t, error)).toBe('auth:locked_out {"minutes":12}');
  });

  it('reads a wrong current password as sign-in does, with the attempts left', () => {
    const error = new ApiError(422, 'VALIDATION_FAILED', 'errors:VALIDATION_FAILED', {}, [
      { path: 'current', code: 'INVALID', message_key: 'auth:invalid_credentials', params: { attempts_left: 2, lockout_minutes: 15 } },
    ]);
    expect(passwordChangeError(t, error)).toBe('auth:invalid_credentials — auth:attempts_warning {"count":2,"minutes":15}');
  });
});

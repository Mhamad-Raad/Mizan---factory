import type { TFunction } from 'i18next';
import { ApiError, NetworkError } from './api.js';

export interface SignInError {
  /** What went wrong, in the field's error colour. */
  message: string;
  /** How many attempts are left before the lockout, when the server counted one. */
  warning: string | null;
}

/**
 * The one reading of a refused password, for the Login page and the lock screen alike (2.8).
 *
 * A wrong password says how many attempts are left before the username is locked, so the
 * lockout is never a surprise; a lockout says how many minutes are really left of it.
 */
export function signInError(t: TFunction, caught: unknown): SignInError {
  if (caught instanceof NetworkError) return { message: t('errors:NETWORK'), warning: null };
  if (!(caught instanceof ApiError)) return { message: t('errors:INTERNAL'), warning: null };

  if (caught.code === 'RATE_LIMITED') {
    return {
      message: t('auth:locked_out', { minutes: caught.params.minutes as number }),
      warning: null,
    };
  }
  if (caught.params.reason === 'deactivated') {
    return { message: t('auth:account_deactivated'), warning: null };
  }

  // The Login page answers in the error's params; the lock screen in its password field's.
  const params = caught.fields[0]?.params ?? caught.params;
  const left = params.attempts_left;
  return {
    message: t('auth:invalid_credentials'),
    warning:
      typeof left === 'number'
        ? t('auth:attempts_warning', { count: left, minutes: params.lockout_minutes as number })
        : null,
  };
}

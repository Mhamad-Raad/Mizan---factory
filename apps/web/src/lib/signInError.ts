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
    // The per-address ceiling rather than this account's lockout (security review, finding 4):
    // the same wait, but a different reason, and the user should know which.
    if (caught.params.reason === 'too_many_requests') {
      return {
        message: t('auth:too_many_from_network', { minutes: caught.params.minutes as number }),
        warning: null,
      };
    }
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

/**
 * A refused password change, for the forced change and the Me page alike. A wrong current
 * password and a lockout read as they do at sign-in — that field counts toward the same five
 * attempts (security review, finding 2); a new password the rules refuse says which rule.
 */
export function passwordChangeError(t: TFunction, caught: unknown): string {
  const wrongCurrent = caught instanceof ApiError && caught.fields[0]?.path === 'current';
  if (!(caught instanceof ApiError) || caught.code === 'RATE_LIMITED' || wrongCurrent) {
    const problem = signInError(t, caught);
    return problem.warning ? `${problem.message} — ${problem.warning}` : problem.message;
  }
  const field = caught.fields[0];
  if (field) return t(field.message_key, { min: 8, ...(field.params ?? {}) });
  return t(caught.messageKey, { defaultValue: t('errors:INTERNAL') });
}

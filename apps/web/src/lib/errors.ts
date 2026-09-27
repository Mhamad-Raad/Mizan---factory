import type { TFunction } from 'i18next';
import { ApiError, NetworkError } from './api.js';

/**
 * The one sentence a failed write shows (spec 2.9.2). The API's own key when it answered —
 * the first field's, when the refusal is about a field, since that is the more precise one —
 * "no connection" when the request never arrived, and "something went wrong" for anything else,
 * so a failure is never silent. `null` when there is no error to show.
 */
export function errorMessage(t: TFunction, error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (error instanceof ApiError) {
    const field = error.fields[0];
    if (field) return t(field.message_key, { ...field.params, defaultValue: t(error.messageKey, { ...error.params, defaultValue: t('errors:INTERNAL') }) });
    return t(error.messageKey, { ...error.params, defaultValue: t('errors:INTERNAL') });
  }
  if (error instanceof NetworkError) return t('errors:NETWORK');
  return t('errors:INTERNAL');
}

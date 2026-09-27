import { ApiError } from './errors.js';
import type { RequestContext } from './request-context.js';
import type { Db } from '../database/pool.js';

/**
 * Who a record says did the work — the employee who took the cash, sold the goods, found the
 * damage. Anyone may name themselves; only an admin may name somebody else (entering a day's
 * paper for the team), and only an active user. The cash-up counts money by this name, so a
 * colleague's name typed by anyone else, or an id that is nobody, is refused (review).
 */
export async function resolveActingUser(
  db: Db,
  context: RequestContext,
  requested: string | null | undefined,
  path: string,
): Promise<string> {
  if (!requested || requested === context.userId) return context.userId;
  if (context.role !== 'admin') throw ApiError.permissionDenied('admin');
  const { rowCount } = await db.query(
    'SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL AND is_active = true',
    [requested],
  );
  if (!rowCount) {
    throw ApiError.validation([{ path, code: 'NOT_FOUND', message_key: 'errors:field.required', params: {} }]);
  }
  return requested;
}

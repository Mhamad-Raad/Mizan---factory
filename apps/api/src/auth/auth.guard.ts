import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { expandImplied } from '@mizan/permissions';
import {
  ADMIN_ONLY_KEY,
  ALLOW_WHEN_LOCKED_KEY,
  PERMISSION_KEY,
  PUBLIC_KEY,
  SESSION_ONLY_KEY,
} from '../common/decorators.js';
import { ApiError } from '../common/errors.js';
import type { RequestWithContext } from '../common/request-context.js';
import { Database } from '../database/pool.js';
import { SESSION_COOKIE, SessionService } from './session.service.js';

/**
 * Rule 4, in one place (spec 2.6.2).
 *
 * The order matters and is the order of the specification's sequence diagram 2.6.7:
 * authenticate → 423 if the screen is locked → 403 if the key is missing. A route with no
 * decorator at all is refused outright, so forgetting one fails closed; CI also fails the
 * build for it (`pnpm check:routes`), but the running system does not depend on CI.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly database: Database,
  ) {}

  async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    const handler = executionContext.getHandler();
    const controller = executionContext.getClass();
    const request = executionContext.switchToHttp().getRequest<RequestWithContext>();

    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [handler, controller]);
    if (isPublic) return true;

    const permission = this.reflector.getAllAndOverride<string>(PERMISSION_KEY, [handler, controller]);
    const adminOnly = this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY_KEY, [handler, controller]);
    const sessionOnly = this.reflector.getAllAndOverride<boolean>(SESSION_ONLY_KEY, [handler, controller]);

    if (!permission && !adminOnly && !sessionOnly) {
      // Fail closed: an undecorated route is a mistake, not an open door.
      throw new ApiError('PERMISSION_DENIED', { required: 'undeclared' });
    }

    const token = (request.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (!token) throw new ApiError('UNAUTHENTICATED');

    const session = await this.sessions.resolve(token);
    if (!session) throw new ApiError('UNAUTHENTICATED');
    // A deactivated user's sessions are revoked within a minute (FR-203); this closes the gap.
    if (!session.user_is_active) throw new ApiError('UNAUTHENTICATED');

    if (session.is_locked) {
      const allowedWhenLocked = this.reflector.getAllAndOverride<boolean>(ALLOW_WHEN_LOCKED_KEY, [
        handler,
        controller,
      ]);
      if (!allowedWhenLocked) throw new ApiError('SESSION_LOCKED');
    }

    const keys = session.role === 'admin' ? new Set<string>() : await this.permissionsOf(session.user_id);

    request.session = session;
    request.context = {
      requestId: request.requestId,
      userId: session.user_id,
      role: session.role,
      permissions: keys,
      sessionId: session.id,
      authMethod: session.auth_method,
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
    };

    if (adminOnly && session.role !== 'admin') {
      throw new ApiError('PERMISSION_DENIED', { required: 'admin' });
    }
    if (permission && session.role !== 'admin' && !keys.has(permission)) {
      throw ApiError.permissionDenied(permission);
    }
    return true;
  }

  /**
   * The effective set is read per request. Section 2.6.1 allows a 60-second cache, but a
   * cache held in one process is wrong the moment a second API replica exists (the Compose
   * scale command in 2.14 makes that a matter of one command), and "the admin removed a
   * permission but it still worked for a minute" is precisely the failure this system must
   * not have. The read is a primary-key lookup on a table with a handful of rows per user;
   * at the design volume of 30 concurrent users it does not register.
   */
  private async permissionsOf(userId: string): Promise<Set<string>> {
    const { rows } = await this.database.query<{ permission_key: string }>(
      'SELECT permission_key FROM user_permissions WHERE user_id = $1',
      [userId],
    );
    // Implied keys are expanded at check time, so a stored set can never be subtly incomplete.
    return expandImplied(rows.map((row) => row.permission_key));
  }

  /** Kept so callers need not know whether a cache exists; a permission change is live at once. */
  invalidate(_userId: string): void {
    // Nothing to invalidate: permissions are never cached (see permissionsOf).
  }
}

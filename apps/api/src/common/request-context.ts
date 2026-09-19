import type { Request } from 'express';
import type { UserRole } from '../users/user.types.js';

/**
 * What every service and repository receives about the caller. Scope flags live here so the
 * repositories can apply them without a controller remembering to (spec 2.6.2, 2.6.4).
 */
export interface RequestContext {
  requestId: string;
  userId: string;
  role: UserRole;
  /** The effective set, with implied keys already expanded (spec 2.6.1). */
  permissions: ReadonlySet<string>;
  sessionId: string;
  authMethod: 'password' | 'ticket_pin';
  ip: string | null;
  userAgent: string | null;
}

export type RequestWithContext = Request & {
  requestId: string;
  context?: RequestContext;
  /** The session the AuthGuard resolved, so controllers do not read the cookie twice. */
  session?: import('../auth/session.service.js').SessionWithUser;
  /** Set only when this request reserved the idempotency key it carries. */
  idempotencyKeyOwned?: string;
};

export function contextOf(request: RequestWithContext): RequestContext {
  if (!request.context) throw new Error('request context is not set — is the AuthGuard registered?');
  return request.context;
}

/** Admins hold every key implicitly; employees hold exactly what was granted. */
export function can(context: RequestContext, permission: string): boolean {
  return context.role === 'admin' || context.permissions.has(permission);
}

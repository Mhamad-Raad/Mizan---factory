import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { ApiError } from './errors.js';
import type { RequestWithContext } from './request-context.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_COOKIE = 'mizan_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * SameSite=Lax plus a double-submit token on every state-changing request, and an Origin
 * check (spec 2.8, 2.13). The cookie is readable by the client on purpose — that is what
 * "double submit" means; the session cookie itself stays httpOnly.
 */
@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  constructor(private readonly allowedOrigin: string) {}

  use(request: RequestWithContext, _response: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(request.method)) return next();

    // Where the request says it came from: `Origin`, or — when a browser leaves that out — the
    // origin of `Referer`. Either one naming another site is refused (security review, 14).
    // A request carrying neither is left to the token below: non-browser clients send neither.
    const origin = request.headers.origin ?? originOf(request.headers.referer);
    if (origin !== undefined && origin !== this.allowedOrigin) {
      throw new ApiError('PERMISSION_DENIED', { reason: 'origin' }, [], 'errors:request_origin_refused');
    }

    const cookie = (request.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
    const header = request.headers[CSRF_HEADER];
    // A request without a session cookie cannot be a cross-site forgery against a session.
    const hasSession = Boolean((request.cookies as Record<string, string> | undefined)?.mizan_session);
    if (!hasSession) return next();

    if (!cookie || !header || cookie !== header) {
      throw new ApiError('PERMISSION_DENIED', { reason: 'csrf' }, [], 'errors:csrf_refused');
    }
    next();
  }
}

/** The origin of a Referer URL; `null` (never equal to the allowed origin) when it is not one. */
function originOf(referer: string | undefined): string | null | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

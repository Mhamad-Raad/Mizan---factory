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
/**
 * The origin of `APP_BASE_URL` as a browser writes it in `Origin`: scheme, host and a port only
 * when it is not the default — so `https://mizan.example/` and `https://mizan.example:443`
 * both mean `https://mizan.example`. Compared as written, either one refused every write.
 */
export function appOrigin(appBaseUrl: string): string {
  try {
    return new URL(appBaseUrl).origin;
  } catch {
    return appBaseUrl;
  }
}

@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  private readonly allowedOrigin: string;

  constructor(appBaseUrl: string) {
    this.allowedOrigin = appOrigin(appBaseUrl);
  }

  use(request: RequestWithContext, _response: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(request.method)) return next();

    // Where the request says it came from: `Origin`, or — when a browser leaves that out — the
    // origin of `Referer`. Either one naming another site is refused (security review, 14).
    // A request carrying neither is left to the token below: non-browser clients send neither.
    // `Origin: null` (a sandboxed frame, a privacy redirect) is a present header naming no site.
    const origin =
      request.headers.origin !== undefined
        ? (originOf(request.headers.origin) ?? null)
        : originOf(request.headers.referer);
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

/**
 * The origin of an `Origin` or `Referer` value; `null` (never equal to the allowed origin) when
 * it is not a URL — `Origin: null` included — and `undefined` when the header is absent.
 */
function originOf(header: string | undefined): string | null | undefined {
  if (!header) return undefined;
  try {
    const origin = new URL(header).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

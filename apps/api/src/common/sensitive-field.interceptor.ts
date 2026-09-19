import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import type { RequestWithContext } from './request-context.js';

export const SENSITIVE_FIELDS_KEY = 'mizan:sensitive_fields';

/**
 * Field-level permissions are enforced by *removing the field from the response*, not by
 * blanking it in the interface (FR-103, spec 2.6.2). A route declares which of its response
 * fields belong to which flag; the interceptor strips them from lists, details, reports and
 * exports alike, however deeply they are nested.
 */
export const SensitiveFields = (map: Record<string, string>) => SetMetadata(SENSITIVE_FIELDS_KEY, map);

@Injectable()
export class SensitiveFieldInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const rules = this.reflector.getAllAndOverride<Record<string, string>>(SENSITIVE_FIELDS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!rules) return next.handle();

    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const requestContext = request.context;
    if (!requestContext) return next.handle();
    if (requestContext.role === 'admin') return next.handle();

    const toStrip = Object.entries(rules)
      .filter(([, flag]) => !requestContext.permissions.has(flag))
      .map(([field]) => field);
    if (toStrip.length === 0) return next.handle();

    return next.handle().pipe(map((body) => strip(body, new Set(toStrip))));
  }
}

function strip(value: unknown, fields: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => strip(item, fields));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (fields.has(key)) continue;
      out[key] = strip(nested, fields);
    }
    return out;
  }
  return value;
}

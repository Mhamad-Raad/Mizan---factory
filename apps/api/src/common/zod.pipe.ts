import { Injectable } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { ZodError } from 'zod';
import type { ZodType } from 'zod';
import { ApiError } from './errors.js';
import type { FieldError } from './errors.js';

/**
 * One validation pipe for the whole API. Failures come back as the field list of
 * specification 2.9.2 with message keys, so the client renders them in the user's language
 * using the same catalog the form itself uses (spec 2.10.2).
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) throw ApiError.validation(error.issues.map(toFieldError));
      throw error;
    }
  }
}

function toFieldError(issue: { path: PropertyKey[]; code: string; message: string }): FieldError {
  const path = issue.path.map(String).join('.') || '(body)';
  const known: Record<string, { code: string; key: string }> = {
    invalid_type: { code: 'REQUIRED', key: 'errors:field.required' },
    too_small: { code: 'TOO_SHORT', key: 'errors:field.too_short' },
    too_big: { code: 'TOO_LONG', key: 'errors:field.too_long' },
  };
  const mapped = known[issue.code] ?? { code: 'INVALID', key: 'errors:field.required' };
  return { path, code: mapped.code, message_key: mapped.key, params: { field: path } };
}

/** Convenience for controllers: `@Body(zodBody(schema))`. */
export function zodBody<T>(schema: ZodType<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}

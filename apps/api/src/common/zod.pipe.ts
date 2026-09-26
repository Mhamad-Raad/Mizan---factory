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

function toFieldError(issue: {
  path: PropertyKey[];
  code: string;
  message: string;
  origin?: string;
  minimum?: unknown;
  maximum?: unknown;
  inclusive?: boolean;
}): FieldError {
  const path = issue.path.map(String).join('.') || '(body)';
  // The limit travels with the key, so "Too short (minimum {{min}})" says the minimum.
  const params: Record<string, unknown> = { field: path };
  if (issue.minimum !== undefined) params.min = Number(issue.minimum);
  if (issue.maximum !== undefined) params.max = Number(issue.maximum);
  // A number below or above its bound is not "too short": a negative price reads as one.
  if (issue.origin === 'number' && issue.code === 'too_small') {
    const key = issue.inclusive === false ? 'errors:field.number_above' : 'errors:field.number_too_small';
    return { path, code: 'TOO_SMALL', message_key: key, params };
  }
  if (issue.origin === 'number' && issue.code === 'too_big') {
    return { path, code: 'TOO_BIG', message_key: 'errors:field.number_too_big', params };
  }
  const known: Record<string, { code: string; key: string }> = {
    invalid_type: { code: 'REQUIRED', key: 'errors:field.required' },
    too_small: { code: 'TOO_SHORT', key: 'errors:field.too_short' },
    too_big: { code: 'TOO_LONG', key: 'errors:field.too_long' },
  };
  const mapped = known[issue.code] ?? { code: 'INVALID', key: 'errors:field.required' };
  return { path, code: mapped.code, message_key: mapped.key, params };
}

/** Convenience for controllers: `@Body(zodBody(schema))`. */
export function zodBody<T>(schema: ZodType<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}

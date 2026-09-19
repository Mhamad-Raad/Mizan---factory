import { HttpException } from '@nestjs/common';

/**
 * The error codes of specification 2.9.2. The client renders `message_key` in the user's
 * language; the API never sends a translated sentence for a validation or permission error
 * (spec 2.9.1), because only the browser knows which of the three languages is in use.
 */
export const ERROR_CODES = {
  UNAUTHENTICATED: 401,
  SESSION_LOCKED: 423,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  VERSION_CONFLICT: 409,
  LAST_ADMIN: 409,
  EDIT_WINDOW_CLOSED: 409,
  PERIOD_LOCKED: 409,
  REBASE_RATE_REQUIRED: 422,
  RECEIVED_AMOUNT_OUT_OF_TOLERANCE: 422,
  DOCUMENT_VOID: 409,
  STOCK_INSUFFICIENT: 422,
  RATE_GUARD: 422,
  IDEMPOTENCY_MISMATCH: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface FieldError {
  path: string;
  code: string;
  message_key: string;
  params?: Record<string, unknown>;
}

export class ApiError extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    public readonly params: Record<string, unknown> = {},
    public readonly fields: FieldError[] = [],
  ) {
    super({ code, params, fields }, ERROR_CODES[code]);
  }

  static validation(fields: FieldError[]): ApiError {
    return new ApiError('VALIDATION_FAILED', {}, fields);
  }

  static permissionDenied(required: string): ApiError {
    return new ApiError('PERMISSION_DENIED', { required });
  }

  static notFound(): ApiError {
    return new ApiError('NOT_FOUND');
  }
}

export function messageKeyFor(code: ErrorCode): string {
  return `errors:${code}`;
}

import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError, ERROR_CODES, messageKeyFor } from './errors.js';
import type { ErrorCode } from './errors.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';

/**
 * Every error leaves the API in the shape of specification 2.9.2, carrying the request id
 * so a user can quote it and support can find the matching audit rows.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Error');

  constructor(private readonly idempotency: IdempotencyInterceptor) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request & { requestId?: string }>();
    const requestId = request.requestId ?? 'unknown';

    // A request that failed must not keep its idempotency key reserved, or the user could
    // never correct the problem and send it again.
    void this.idempotency
      .releaseFor(request as never)
      .catch((error: Error) => this.logger.warn(`could not release idempotency key: ${error.message}`));

    if (exception instanceof ApiError) {
      response.status(ERROR_CODES[exception.code]).json({
        error: {
          code: exception.code,
          message_key: exception.messageKey,
          params: exception.params,
          fields: exception.fields,
          request_id: requestId,
        },
      });
      return;
    }

    const database = databaseErrorCode(exception);
    if (database) {
      // Not a fault of ours to hide, but worth a line in the log with the request id.
      this.logger.warn(`[${requestId}] database refused: ${(exception as Error).message}`);
      response.status(ERROR_CODES[database]).json({
        error: { code: database, message_key: messageKeyFor(database), params: {}, fields: [], request_id: requestId },
      });
      return;
    }

    // The money kernel refuses numbers it cannot use — beyond the safe range, or two amounts
    // that imply no rate — with a RangeError: the request's numbers, not a fault of ours.
    if (exception instanceof RangeError) {
      // Logged as an error all the same: a RangeError from our own code must still be noticed.
      this.logger.error(`[${requestId}] refused numbers: ${exception.message}`, exception.stack);
      response.status(422).json({
        error: { code: 'VALIDATION_FAILED', message_key: messageKeyFor('VALIDATION_FAILED'), params: {}, fields: [], request_id: requestId },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      /*
       * 413 is the body parser refusing to read the request, which happens *before* any route
       * or guard runs. It used to fall through to `INTERNAL`, so an admin importing 2,000
       * customers — the one moment this system asks somebody to hand it a large file — was
       * told "something went wrong on our side" (system-wide review, part two).
       */
      const code: ErrorCode =
        status === 404
          ? 'NOT_FOUND'
          : status === 403
            ? 'PERMISSION_DENIED'
            : status === 401
              ? 'UNAUTHENTICATED'
              : status === 413
                ? 'REQUEST_TOO_LARGE'
                : status === 429
                  ? 'RATE_LIMITED'
                  : // A body that is not JSON, or a parameter Nest could not read: the request's fault.
                    status === 400
                    ? 'VALIDATION_FAILED'
                    : 'INTERNAL';
      response.status(status).json({
        error: { code, message_key: messageKeyFor(code), params: {}, fields: [], request_id: requestId },
      });
      return;
    }

    // Unexpected: log it with the request id, tell the user nothing about our internals.
    this.logger.error(`[${requestId}] ${(exception as Error)?.message}`, (exception as Error)?.stack);
    response.status(500).json({
      error: {
        code: 'INTERNAL',
        message_key: messageKeyFor('INTERNAL'),
        params: {},
        fields: [],
        request_id: requestId,
      },
    });
  }
}

/**
 * A PostgreSQL error the request caused rather than a fault of ours (review): a unique rule, a
 * rule the checks before it did not foresee, a value the database could not read, or two saves
 * that waited on each other. Each answers as what it is instead of "something went wrong".
 */
function databaseErrorCode(exception: unknown): ErrorCode | null {
  const code = (exception as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) return null;
  if (code === '23505') return 'DUPLICATE';
  // Two saves waited on each other, or one took longer than the minute a statement may run.
  if (code === '40P01' || code === '40001' || code === '57014') return 'BUSY_RETRY';
  // A check rule, and text or a date the database could not read: the request's values. A
  // missing column, a broken reference or an overflow in SQL we wrote are faults of ours and
  // stay 500s, so they are seen (review).
  if (code === '23514' || code === '22P02' || code === '22007' || code === '22008') return 'VALIDATION_FAILED';
  return null;
}

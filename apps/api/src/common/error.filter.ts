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
          message_key: messageKeyFor(exception.code),
          params: exception.params,
          fields: exception.fields,
          request_id: requestId,
        },
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

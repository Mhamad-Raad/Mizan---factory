import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { from, of, switchMap } from 'rxjs';
import type { Observable } from 'rxjs';
import { ApiError } from './errors.js';
import type { RequestWithContext } from './request-context.js';
import { Database } from '../database/pool.js';

const IDEMPOTENCY_HEADER = 'idempotency-key';
const TTL_HOURS = 24;
/** How long a duplicate waits for the request that is already running (milliseconds). */
const WAIT_FOR_IN_FLIGHT_MS = 5_000;
const POLL_INTERVAL_MS = 100;
/** `response_status = 0` marks a reservation: the work is running, no response yet. */
const IN_FLIGHT = 0;

interface StoredResponse {
  request_hash: string;
  response_status: number;
  response_body: unknown;
}

/**
 * Poor connectivity is a given on the factory floor (C-07), so every state-changing request
 * may carry `Idempotency-Key` and a retry must never write the same order twice (FR-1305).
 *
 * The key is **reserved before the handler runs**, not stored after it: an insert that loses
 * the race to the unique primary key knows another copy of the same request is already in
 * flight, and waits for its answer instead of doing the work a second time. Storing only
 * afterwards would leave a window — exactly as wide as the write itself — in which a
 * double-tap produces two orders.
 *
 * On success the reservation is completed with the response; on failure it is removed, so a
 * genuine retry after a server error is allowed to run.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly database: Database) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next.handle();

    const key = request.headers[IDEMPOTENCY_HEADER];
    if (typeof key !== 'string' || key.length === 0) return next.handle();
    const userId = request.context?.userId;
    if (!userId) return next.handle();

    const requestHash = createHash('sha256')
      .update(`${request.method}:${request.originalUrl}:${JSON.stringify(request.body ?? {})}`)
      .digest('hex');

    const reserved = await this.reserve(key, userId, requestHash);
    // Ownership is recorded on the request so the error filter releases a reservation only
    // when *this* request made it. Releasing on any failure would let a duplicate that was
    // told to try again shortly delete the reservation the first copy is still working under.
    if (reserved) request.idempotencyKeyOwned = key;
    if (!reserved) {
      const stored = await this.awaitStored(key, userId);
      if (stored.request_hash !== requestHash) throw new ApiError('IDEMPOTENCY_MISMATCH');
      if (stored.response_status === IN_FLIGHT) {
        // The first copy is still running. Telling the client to try again shortly is the
        // honest answer: it is the one case where we cannot know the outcome yet.
        throw new ApiError('RATE_LIMITED', { reason: 'request_in_flight' });
      }
      context.switchToHttp().getResponse().status(stored.response_status);
      return of(stored.response_body);
    }

    return next.handle().pipe(
      switchMap((body) => {
        const status = context.switchToHttp().getResponse().statusCode as number;
        return from(this.complete(key, status, body).then(() => body));
      }),
    );
  }

  /** True when this request owns the key; false when another copy already reserved it. */
  private async reserve(key: string, userId: string, requestHash: string): Promise<boolean> {
    const { rowCount } = await this.database.query(
      `INSERT INTO idempotency_keys (key, user_id, request_hash, response_status, response_body, expires_at)
       VALUES ($1, $2, $3, ${IN_FLIGHT}, 'null'::jsonb, now() + make_interval(hours => ${TTL_HOURS}))
       ON CONFLICT (key) DO NOTHING`,
      [key, userId, requestHash],
    );
    return (rowCount ?? 0) > 0;
  }

  private async complete(key: string, status: number, body: unknown): Promise<void> {
    await this.database.query(
      'UPDATE idempotency_keys SET response_status = $2, response_body = $3 WHERE key = $1',
      [key, status, JSON.stringify(body ?? null)],
    );
  }

  /** A failed request releases its key, so the user can correct the problem and retry. */
  private async release(key: string): Promise<void> {
    await this.database.query('DELETE FROM idempotency_keys WHERE key = $1 AND response_status = $2', [
      key,
      IN_FLIGHT,
    ]);
  }

  private async awaitStored(key: string, userId: string): Promise<StoredResponse> {
    const deadline = Date.now() + WAIT_FOR_IN_FLIGHT_MS;
    let stored = await this.read(key, userId);
    while (stored && stored.response_status === IN_FLIGHT && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      stored = await this.read(key, userId);
    }
    if (!stored) throw new ApiError('IDEMPOTENCY_MISMATCH');
    return stored;
  }

  private async read(key: string, userId: string): Promise<StoredResponse | null> {
    const { rows } = await this.database.query<StoredResponse>(
      'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = $1 AND user_id = $2',
      [key, userId],
    );
    return rows[0] ?? null;
  }

  /** Exposed for the error filter: a request that failed must not hold the key it reserved. */
  async releaseFor(request: RequestWithContext): Promise<void> {
    const key = request.idempotencyKeyOwned;
    if (key) await this.release(key);
  }
}

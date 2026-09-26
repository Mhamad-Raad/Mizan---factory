import { Injectable } from '@nestjs/common';
import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import { ApiError } from './errors.js';

/** The route parameters that name a record. Every record in this system has a UUID key. */
const ID_PARAMS = new Set(['id', 'entryId', 'sessionId']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A malformed record id answers 404, not 500 (security review, finding 16). `/orders/abc` used to
 * reach PostgreSQL, which refused to read `abc` as a UUID, and the user was told "something went
 * wrong on our side" about a link that was simply wrong. Global, so no route can forget it; it
 * runs after the guard, so it never tells somebody without access whether a record exists.
 */
@Injectable()
export class IdParamPipe implements PipeTransform<unknown, unknown> {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'param' || !metadata.data || !ID_PARAMS.has(metadata.data)) return value;
    if (typeof value !== 'string' || !UUID.test(value)) {
      throw new ApiError('NOT_FOUND', { reason: 'malformed_id', param: metadata.data }, [], 'errors:malformed_id');
    }
    return value;
  }
}

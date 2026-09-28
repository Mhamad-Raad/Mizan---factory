import { useCallback, useState } from 'react';
import { newIdempotencyKey } from './api.js';

export interface IdempotencyKey {
  /** The key every attempt of this write carries, retries included. */
  key: string;
  /** A fresh key for the next write — called once the server has said yes, and only then. */
  renew: () => void;
}

/**
 * One idempotency key for the life of one write (FR-1305).
 *
 * A key minted inside `mutationFn` is a new key per tap: when the reply to a payment is lost
 * and the employee taps Save again, the server sees a second payment and writes it twice. The
 * key is held here instead — made when the sheet or form mounts, sent again by every retry, and
 * renewed only after a success. A refusal costs nothing: the server releases the key of a
 * request that failed, so the corrected retry may use it.
 */
export function useIdempotencyKey(): IdempotencyKey {
  const [key, setKey] = useState(newIdempotencyKey);
  const renew = useCallback(() => setKey(newIdempotencyKey()), []);
  return { key, renew };
}

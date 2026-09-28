import { useCallback, useEffect, useState } from 'react';
import { newIdempotencyKey } from './api.js';

/** Fired by `apiRequest` when the server answers IDEMPOTENCY_MISMATCH; `detail` is the key. */
export const IDEMPOTENCY_MISMATCH_EVENT = 'mizan:idempotency-mismatch';

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
 * key is held here instead — sent again by every retry, and renewed after a success. A refusal
 * costs nothing: the server releases the key of a request that failed, so the corrected retry
 * may use it.
 *
 * `scope` names the one write the key belongs to — the record, the kind of write and whether
 * its sheet is open, e.g. `${id}:${sheet}` — and a new scope is a new key. A key held by the
 * *page* outlived the sheet: after a lost reply (the write committed, the tab saw a network
 * error) the next, different write on that page — a refund after a credit, a payment on the
 * next order — carried the committed key and was refused as IDEMPOTENCY_MISMATCH for ever. So
 * every opening of a sheet, and every other record or kind, starts with its own key; and a key
 * the server says was already used for something else is renewed on the spot (the page is
 * refreshed by the query client, and `errorMessage` says an earlier attempt was saved).
 */
export function useIdempotencyKey(scope: string | null = null): IdempotencyKey {
  const [state, setState] = useState(() => ({ scope, key: newIdempotencyKey() }));
  let current = state;
  if (state.scope !== scope) {
    // Derived during render, so the first request of the new scope already carries the new key.
    current = { scope, key: newIdempotencyKey() };
    setState(current);
  }
  const renew = useCallback(() => setState((previous) => ({ ...previous, key: newIdempotencyKey() })), []);

  const key = current.key;
  useEffect(() => {
    const onMismatch = (event: Event) => {
      if ((event as CustomEvent<string>).detail === key) renew();
    };
    window.addEventListener(IDEMPOTENCY_MISMATCH_EVENT, onMismatch);
    return () => window.removeEventListener(IDEMPOTENCY_MISMATCH_EVENT, onMismatch);
  }, [key, renew]);

  return { key, renew };
}

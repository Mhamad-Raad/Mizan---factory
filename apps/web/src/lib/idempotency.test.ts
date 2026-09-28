import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { ApiError, apiRequest } from './api.js';
import { errorMessage } from './errors.js';
import { IDEMPOTENCY_MISMATCH_EVENT } from './idempotency.js';

/**
 * After a lost reply (the write committed, the tab saw a network error) the page's next,
 * different write carried the committed key and was refused as IDEMPOTENCY_MISMATCH for ever
 * (review). The refusal now tells the holder of the key to renew it, and the employee what
 * happened.
 */
describe('a key the server says was already used', () => {
  afterEach(() => vi.unstubAllGlobals());

  function refuse(code: string): void {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => JSON.stringify({ error: { code, message_key: `errors:${code}` } }),
      }),
    );
  }

  it('is announced with the key, so whoever holds it renews it', async () => {
    refuse('IDEMPOTENCY_MISMATCH');
    const heard = vi.fn();
    const listener = (event: Event) => heard((event as CustomEvent<string>).detail);
    window.addEventListener(IDEMPOTENCY_MISMATCH_EVENT, listener);
    await expect(
      apiRequest('/orders/1/payments', { method: 'POST', body: {}, idempotencyKey: 'key-1' }),
    ).rejects.toBeInstanceOf(ApiError);
    window.removeEventListener(IDEMPOTENCY_MISMATCH_EVENT, listener);
    expect(heard).toHaveBeenCalledWith('key-1');
  });

  it('is not announced for any other refusal', async () => {
    refuse('VALIDATION_FAILED');
    const heard = vi.fn();
    window.addEventListener(IDEMPOTENCY_MISMATCH_EVENT, heard);
    await expect(
      apiRequest('/orders/1/payments', { method: 'POST', body: {}, idempotencyKey: 'key-1' }),
    ).rejects.toBeInstanceOf(ApiError);
    window.removeEventListener(IDEMPOTENCY_MISMATCH_EVENT, heard);
    expect(heard).not.toHaveBeenCalled();
  });

  it('tells the employee an earlier attempt was saved', () => {
    const t = ((key: string) => key) as unknown as TFunction;
    const error = new ApiError(422, 'IDEMPOTENCY_MISMATCH', 'errors:IDEMPOTENCY_MISMATCH');
    expect(errorMessage(t, error)).toBe('common:earlier_attempt_saved');
  });
});

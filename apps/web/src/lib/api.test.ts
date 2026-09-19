import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError, apiRequest, newIdempotencyKey } from './api.js';

describe('the API client (spec 2.9.1, 2.9.2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = 'mizan_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  });

  function stubFetch(response: Partial<Response> & { jsonBody?: unknown }) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: async () => (response.jsonBody === undefined ? '' : JSON.stringify(response.jsonBody)),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('echoes the CSRF cookie as a header on writes, and not on reads', async () => {
    document.cookie = 'mizan_csrf=token-123';
    const fetchMock = stubFetch({ jsonBody: { ok: true } });

    await apiRequest('/users', { method: 'POST', body: { a: 1 } });
    expect(fetchMock.mock.calls[0]?.[1].headers['X-CSRF-Token']).toBe('token-123');

    await apiRequest('/users');
    expect(fetchMock.mock.calls[1]?.[1].headers['X-CSRF-Token']).toBeUndefined();
  });

  it('attaches an idempotency key only when one is given, and only to writes', async () => {
    const fetchMock = stubFetch({ jsonBody: {} });
    const key = newIdempotencyKey();
    await apiRequest('/users', { method: 'POST', body: {}, idempotencyKey: key });
    expect(fetchMock.mock.calls[0]?.[1].headers['Idempotency-Key']).toBe(key);
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('turns the error body of 2.9.2 into a typed error with its fields', async () => {
    stubFetch({
      ok: false,
      status: 422,
      jsonBody: {
        error: {
          code: 'VALIDATION_FAILED',
          message_key: 'errors:VALIDATION_FAILED',
          params: {},
          fields: [{ path: 'username', code: 'TAKEN', message_key: 'errors:field.username_taken' }],
          request_id: 'abc',
        },
      },
    });

    await expect(apiRequest('/users', { method: 'POST', body: {} })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      requestId: 'abc',
    });

    try {
      await apiRequest('/users', { method: 'POST', body: {} });
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).fieldError('username')?.message_key).toBe('errors:field.username_taken');
      expect((error as ApiError).fieldError('phone')).toBeUndefined();
    }
  });

  it('reports a lost connection distinctly, so the caller can keep the draft', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed to fetch')));
    await expect(apiRequest('/users')).rejects.toBeInstanceOf(NetworkError);
  });

  it('returns nothing for 204 without trying to parse a body', async () => {
    stubFetch({ status: 204 });
    await expect(apiRequest('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });
});

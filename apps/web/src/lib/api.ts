import type { Locale } from '@mizan/i18n';

/**
 * The API client. It carries the session cookie, echoes the CSRF cookie as a header
 * (double submit, spec 2.8), attaches an idempotency key to every write so a retry after a
 * timeout cannot write twice (FR-1305), and turns the error body of 2.9.2 into a typed error
 * the interface can translate.
 */

const BASE = '/api/v1';

export interface FieldError {
  path: string;
  code: string;
  message_key: string;
  params?: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly messageKey: string,
    public readonly params: Record<string, unknown> = {},
    public readonly fields: FieldError[] = [],
    public readonly requestId?: string,
  ) {
    super(`${code} (${status})`);
    this.name = 'ApiError';
  }

  /** The error of a single field, for showing it under the input that caused it. */
  fieldError(path: string): FieldError | undefined {
    return this.fields.find((field) => field.path === path);
  }
}

export class NetworkError extends Error {
  constructor() {
    super('network');
    this.name = 'NetworkError';
  }
}

function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)mizan_csrf=([^;]+)/);
  return match?.[1] ?? '';
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  locale?: Locale;
  /** Reuse a key across retries of the same submission, never across submissions. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.locale) headers['Accept-Language'] = options.locale;
  if (method !== 'GET') {
    headers['X-CSRF-Token'] = csrfToken();
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  }

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch {
    // Offline or the request never left the device: the caller keeps the draft and offers Retry.
    throw new NetworkError();
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const error = (payload as { error?: Record<string, unknown> } | null)?.error;
    throw new ApiError(
      response.status,
      (error?.code as string) ?? 'INTERNAL',
      (error?.message_key as string) ?? 'errors:INTERNAL',
      (error?.params as Record<string, unknown>) ?? {},
      (error?.fields as FieldError[]) ?? [],
      error?.request_id as string | undefined,
    );
  }

  return payload as T;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

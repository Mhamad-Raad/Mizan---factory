import type { Locale } from '@mizan/i18n';
export interface FieldError {
    path: string;
    code: string;
    message_key: string;
    params?: Record<string, unknown>;
}
export declare class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly messageKey: string;
    readonly params: Record<string, unknown>;
    readonly fields: FieldError[];
    readonly requestId?: string | undefined;
    constructor(status: number, code: string, messageKey: string, params?: Record<string, unknown>, fields?: FieldError[], requestId?: string | undefined);
    /** The error of a single field, for showing it under the input that caused it. */
    fieldError(path: string): FieldError | undefined;
}
export declare class NetworkError extends Error {
    constructor();
}
export interface RequestOptions {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    locale?: Locale;
    /** Reuse a key across retries of the same submission, never across submissions. */
    idempotencyKey?: string;
    signal?: AbortSignal;
}
export declare function apiRequest<T>(path: string, options?: RequestOptions): Promise<T>;
export declare function newIdempotencyKey(): string;
//# sourceMappingURL=api.d.ts.map
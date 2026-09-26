import { z } from 'zod';

/**
 * One paging rule for every list the API returns (client review, D-058).
 *
 * The system is meant to run for years without an update, so no request may return a whole
 * table: a list comes back one page at a time, 25 rows unless the caller asks for more, never
 * more than 100. Lists whose order is stable page by `page`/`page_size`; the audit log, which
 * only ever grows, pages by a cursor and uses the same size limits under the name `limit`.
 */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export const pageFields = {
  page: z.coerce.number().int().positive().max(1_000_000).optional(),
  page_size: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).optional(),
};

export const pageSchema = z.object(pageFields);

/** The cursor-paged audit trail's size limit: the same default and maximum. */
export const limitField = z.coerce.number().int().positive().max(MAX_PAGE_SIZE).optional();

export interface Paging {
  page: number;
  page_size: number;
  offset: number;
}

/** A request's page, clamped to the rule whatever reached the repository. */
export function pagingOf(options: { page?: number; page_size?: number } = {}): Paging {
  const page_size = Math.min(Math.max(Math.trunc(options.page_size ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
  const page = Math.max(Math.trunc(options.page ?? 1), 1);
  return { page, page_size, offset: (page - 1) * page_size };
}

/** One page of rows that are already in memory (a ledger with its running balance, a report). */
export function pageOfArray<T>(rows: readonly T[], paging: Paging): T[] {
  return rows.slice(paging.offset, paging.offset + paging.page_size);
}

/** The size of a cursor page: the default when absent, never above the maximum. */
export function limitOf(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
}

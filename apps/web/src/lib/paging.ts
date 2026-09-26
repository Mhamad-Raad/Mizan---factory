import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/** The API's paging rule (D-058): 25 rows unless asked for more, never more than 100. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export const PAGE_SIZES = [25, 50, 100] as const;

export function clampPageSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_PAGE_SIZE);
}

/** The size somebody chose for this list last time. Browser storage may be absent or refuse. */
function storedSize(storageKey: string): number | null {
  try {
    const raw = localStorage.getItem(`mizan.pageSize.${storageKey}`);
    return raw === null ? null : clampPageSize(Number(raw));
  } catch {
    return null;
  }
}

function storeSize(storageKey: string, size: number): void {
  try {
    localStorage.setItem(`mizan.pageSize.${storageKey}`, String(size));
  } catch {
    // A private window: the choice lasts as long as the URL does.
  }
}

export interface Paging {
  page: number;
  pageSize: number;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  /** `page=…&page_size=…`, to append to a list request. */
  query: string;
}

/**
 * Which page of a list is on screen (client review, D-058).
 *
 * The page and its size live in the address, as they do in the delivery dashboard: a page can
 * be bookmarked and shared, and Back returns to it. The size somebody picks is remembered per
 * list in this browser. `prefix` keeps two lists on one screen — a company's orders and its
 * purchases — from sharing one page number.
 *
 * `resetOn` is the list's filters: when any of them changes, the list starts again at page one,
 * because page seven of the old filter means nothing in the new one.
 */
export function usePaging({
  storageKey,
  prefix = '',
  resetOn = [],
}: {
  storageKey: string;
  prefix?: string;
  resetOn?: readonly unknown[];
}): Paging {
  const [params, setParams] = useSearchParams();
  const pageParam = `${prefix}page`;
  const sizeParam = `${prefix}page_size`;

  const rawPage = Number(params.get(pageParam) ?? 1);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.trunc(rawPage) : 1;
  const rawSize = params.get(sizeParam);
  const pageSize = rawSize !== null ? clampPageSize(Number(rawSize)) : (storedSize(storageKey) ?? DEFAULT_PAGE_SIZE);

  const update = useCallback(
    (next: { page?: number; size?: number }, replace = false) => {
      setParams(
        (current) => {
          const out = new URLSearchParams(current);
          if (next.page !== undefined) {
            if (next.page <= 1) out.delete(pageParam);
            else out.set(pageParam, String(next.page));
          }
          if (next.size !== undefined) out.set(sizeParam, String(next.size));
          return out;
        },
        { replace },
      );
    },
    [setParams, pageParam, sizeParam],
  );

  const setPage = useCallback((next: number) => update({ page: Math.max(1, Math.trunc(next)) }), [update]);
  const setPageSize = useCallback(
    (size: number) => {
      const clamped = clampPageSize(size);
      storeSize(storageKey, clamped);
      update({ page: 1, size: clamped });
    },
    [update, storageKey],
  );

  // Back to page one when the filters change — but not on the first render, where the page in
  // the address is the one somebody bookmarked.
  const filterKey = JSON.stringify(resetOn);
  const previous = useRef(filterKey);
  useEffect(() => {
    if (previous.current === filterKey) return;
    previous.current = filterKey;
    if (page !== 1) update({ page: 1 }, true);
  }, [filterKey, page, update]);

  return { page, pageSize, setPage, setPageSize, query: `page=${page}&page_size=${pageSize}` };
}

/**
 * Pages of a list the API hands out by cursor — the audit trail, which only grows, so it is
 * read by "after this row" rather than by a page number (D-058). The cursors already visited are
 * kept, so Previous is as quick as Next; the page itself is local to the screen.
 */
export function useCursorPaging({
  storageKey,
  resetOn = [],
}: {
  storageKey: string;
  resetOn?: readonly unknown[];
}) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageSize, setSize] = useState(() => storedSize(storageKey) ?? DEFAULT_PAGE_SIZE);
  const filterKey = JSON.stringify(resetOn);
  const previous = useRef(filterKey);
  useEffect(() => {
    if (previous.current === filterKey) return;
    previous.current = filterKey;
    setCursors([null]);
  }, [filterKey]);

  const page = cursors.length;
  const cursor = cursors[cursors.length - 1] ?? null;
  return {
    page,
    pageSize,
    cursor,
    /** `limit=…[&cursor=…]`, to append to a history request. */
    query: `limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    next: (nextCursor: string) => setCursors((list) => [...list, nextCursor]),
    previous: () => setCursors((list) => (list.length > 1 ? list.slice(0, -1) : list)),
    setPageSize: (size: number) => {
      const clamped = clampPageSize(size);
      storeSize(storageKey, clamped);
      setSize(clamped);
      setCursors([null]);
    },
  };
}

import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, clampPageSize, pageWithin } from './paging.js';

/**
 * The page size read from an address or from browser storage is somebody's typing, or an old
 * browser's leftovers: whatever it says, the request the screen sends stays inside the API's
 * rule (D-058) — 25 by default, never more than 100 — so it is never refused for asking too much.
 */
describe('the page size a list asks for', () => {
  it('keeps a sensible size as it is', () => {
    expect(clampPageSize(50)).toBe(50);
  });

  it('never asks for more than the API sends', () => {
    expect(clampPageSize(500)).toBe(MAX_PAGE_SIZE);
  });

  it('falls back to the default for nonsense', () => {
    expect(clampPageSize(Number.NaN)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(0)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(-3)).toBe(DEFAULT_PAGE_SIZE);
  });

  it('drops a fraction rather than sending one', () => {
    expect(clampPageSize(33.7)).toBe(33);
  });
});

/**
 * Back restores the page number but not the filters, so a list can come back on a page it no
 * longer has. It moves to its last page that has rows — never leaving somebody on "No orders".
 */
describe('a page past the end of the list', () => {
  it('stays where it is while it has rows', () => {
    expect(pageWithin(1, 25, 0)).toBeNull();
    expect(pageWithin(2, 25, 26)).toBeNull();
    expect(pageWithin(4, 25, 100)).toBeNull();
  });

  it('moves to the last page that has rows', () => {
    expect(pageWithin(4, 25, 30)).toBe(2);
    expect(pageWithin(4, 25, 25)).toBe(1);
  });

  it('moves to page one when the list is empty', () => {
    expect(pageWithin(4, 25, 0)).toBe(1);
  });
});

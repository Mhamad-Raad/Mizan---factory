import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '@mizan/ui';
import { PAGE_SIZES } from '../lib/paging.js';
import { useFormatter } from '../lib/store.js';

/**
 * The foot of every paged list (client review, D-058), after the delivery dashboard's: how many
 * rows a page holds, which rows these are of how many, and the two arrows. The arrows come from
 * the icon registry, so they point the reading way in Kurdish and Arabic.
 *
 * With a `total` it reads "26–50 of 312"; a list paged by cursor has no total and reads
 * "Page 3", and knows only whether there is a next page.
 *
 * Turning the page brings the top of the list back into view — the arrows are at its foot,
 * and the next page's first row is what somebody wants to read.
 */
export function Pager({
  page,
  pageSize,
  total,
  hasNext,
  onPage,
  onPageSize,
}: {
  page: number;
  pageSize: number;
  total?: number;
  /** For a list without a total: whether a page follows this one. */
  hasNext?: boolean;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const sizeId = useId();
  const root = useRef<HTMLDivElement>(null);
  const lastPage = total === undefined ? null : Math.max(1, Math.ceil(total / pageSize));

  // A page past the end — the rows were filtered away, or somebody edited the address — shows
  // the last page that exists rather than an empty list with no way back.
  useEffect(() => {
    if (lastPage !== null && page > lastPage) onPage(lastPage);
  }, [lastPage, page, onPage]);

  const canNext = lastPage !== null ? page < lastPage : Boolean(hasNext);
  // One page of fewer rows than the smallest size needs no foot at all.
  if (page === 1 && !canNext && (total ?? 0) <= PAGE_SIZES[0]) return null;

  const turn = (next: number) => {
    onPage(next);
    const list = root.current?.parentElement;
    if (list && list.getBoundingClientRect().top < 0) list.scrollIntoView({ block: 'start' });
  };

  const from = (page - 1) * pageSize + 1;
  const to = total === undefined ? page * pageSize : Math.min(total, page * pageSize);
  // The range is isolated left-to-right, so "1–25" never reads "25–1" in a right-to-left line.
  const range = `⁦${formatter.number(from)}–${formatter.number(to)}⁩`;

  return (
    <div className="mz-pager" ref={root}>
      <label className="mz-pager__size" htmlFor={sizeId}>
        <span className="mz-caption">{t('common:pager_rows')}</span>
        <select
          id={sizeId}
          className="mz-select mz-pager__select"
          value={pageSize}
          onChange={(event) => onPageSize(Number(event.target.value))}
        >
          {[...new Set([...PAGE_SIZES, pageSize])]
            .sort((left, right) => left - right)
            .map((size) => (
              <option key={size} value={size}>
                {formatter.number(size)}
              </option>
            ))}
        </select>
      </label>
      <span className="mz-pager__range mz-caption" aria-live="polite" data-tabular>
        {total === undefined
          ? t('common:pager_page', { page: formatter.number(page) })
          : t('common:pager_range', { range, total: formatter.number(total) })}
      </span>
      <span className="mz-pager__arrows">
        <IconButton icon="back" label={t('common:pager_previous')} disabled={page <= 1} onClick={() => turn(page - 1)} />
        <IconButton icon="next" label={t('common:pager_next')} disabled={!canNext} onClick={() => turn(page + 1)} />
      </span>
    </div>
  );
}

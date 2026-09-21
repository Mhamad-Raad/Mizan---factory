import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { BottomSheet, TextField } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { useDebouncedValue } from '../lib/debounce.js';
import { QueryStates } from './states.js';

export interface PickerItem {
  id: string;
  title: string;
  subtitle?: string;
  detail?: React.ReactNode;
}

export interface PickerSheetProps {
  title: string;
  open: boolean;
  onClose: () => void;
  /** The endpoint to search, without the query string. */
  path: string;
  /** Maps one API row to a row of the picker. */
  toItem: (row: never) => PickerItem;
  onPick: (id: string, row: never) => void;
  searchLabel: string;
  emptyTitle: string;
  /** A row pinned to the top, such as the walk-in customer (wireframe 3.4.1). */
  pinned?: PickerItem & { row: never };
}

/**
 * The search-and-pick sheet the order form opens for customers and materials (3.4.1, 3.5.1):
 * the keyboard comes up focused, two letters in any script are enough (FR-1205), and tapping
 * a row returns to the form.
 */
export function PickerSheet({
  title,
  open,
  onClose,
  path,
  toItem,
  onPick,
  searchLabel,
  emptyTitle,
  pinned,
}: PickerSheetProps) {
  const { t } = useTranslation();
  // The sheet is mounted only while it is open, so the query starts empty on every visit
  // and there is nothing to reset when it closes.
  const [query, setQuery] = useState('');
  // One request when the typing stops, not one per letter (NFR-03).
  const term = useDebouncedValue(query);

  const results = useQuery({
    queryKey: [path, 'picker', term],
    queryFn: () =>
      apiRequest<{ items: unknown[] }>(`${path}${path.includes('?') ? '&' : '?'}q=${encodeURIComponent(term)}&page_size=25`),
    enabled: open,
  });

  const rows = results.data?.items ?? [];

  return (
    <BottomSheet title={title} open={open} onClose={onClose} closeLabel={t('common:close')}>
      <div className="mz-stack">
        <TextField
          label={searchLabel}
          type="search"
          inputMode="search"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        <QueryStates query={results} isEmpty={rows.length === 0 && !pinned} emptyTitle={emptyTitle} skeletonLines={4}>
          <ul className="mz-list">
            {pinned ? (
              <li key={pinned.id}>
                <button
                  type="button"
                  className="mz-list__item mz-list__item--interactive"
                  onClick={() => onPick(pinned.id, pinned.row)}
                >
                  <span className="mz-list__body">
                    <span className="mz-list__title">{pinned.title}</span>
                    {pinned.subtitle ? <span className="mz-caption">{pinned.subtitle}</span> : null}
                  </span>
                  {pinned.detail}
                </button>
              </li>
            ) : null}
            {rows.map((row) => {
              const item = toItem(row as never);
              if (pinned && item.id === pinned.id) return null;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className="mz-list__item mz-list__item--interactive"
                    onClick={() => onPick(item.id, row as never)}
                  >
                    <span className="mz-list__body">
                      <span className="mz-list__title">{item.title}</span>
                      {item.subtitle ? <span className="mz-caption">{item.subtitle}</span> : null}
                    </span>
                    {item.detail}
                  </button>
                </li>
              );
            })}
          </ul>
        </QueryStates>
      </div>
    </BottomSheet>
  );
}

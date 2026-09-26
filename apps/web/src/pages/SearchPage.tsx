import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Card, EmptyState, TextField } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { useDebouncedValue } from '../lib/debounce.js';
import { usePageTitle } from '../lib/page-title.js';
import { QueryStates } from '../components/states.js';

interface Hit {
  kind: 'item' | 'customer' | 'order' | 'purchase';
  id: string;
  title: string;
  subtitle: string | null;
}

const PATHS: Record<Hit['kind'], string> = {
  item: '/materials',
  customer: '/customers',
  order: '/orders',
  purchase: '/purchases',
};

const ORDER: Hit['kind'][] = ['item', 'customer', 'order', 'purchase'];

/**
 * Global search (FR-1310, **Proposed — not requested**): one field, results grouped by what
 * they are. "کاوا" typed on an Arabic keyboard finds "كاوا" because the API normalises both
 * (2.10.7), and a bare number finds the order or purchase with that number.
 */
export function SearchPage() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  // One request when the typing stops, not one per letter (NFR-03).
  const term = useDebouncedValue(query).trim();

  const search = useQuery({
    queryKey: ['search', term],
    queryFn: () => apiRequest<{ query: string; hits: Hit[] }>(`/search?q=${encodeURIComponent(term)}`),
    enabled: term.length >= 2,
  });

  const hits = search.data?.hits ?? [];

  usePageTitle(t('search:title'));

  return (
    <>
      <div className="mz-stack">
        <TextField
          label={t('search:title')}
          placeholder={t('search:placeholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          type="search"
          inputMode="search"
          autoFocus
        />

        {term.length < 2 ? (
          <EmptyState title={t('search:prompt')} icon="search" />
        ) : (
          <QueryStates
            query={search}
            isEmpty={hits.length === 0}
            emptyTitle={t('search:empty', { query: term })}
            skeletonLines={4}
          >
            {ORDER.filter((kind) => hits.some((hit) => hit.kind === kind)).map((kind) => (
              <Card key={kind}>
                <h3 className="mz-heading">{t(`search:kind.${kind}`)}</h3>
                <ul className="mz-list">
                  {hits
                    .filter((hit) => hit.kind === kind)
                    .map((hit) => (
                      <li key={`${hit.kind}-${hit.id}`}>
                        <Link
                          to={`${PATHS[hit.kind]}/${hit.id}`}
                          className="mz-list__item mz-list__item--interactive"
                        >
                          <span className="mz-list__body">
                            <span className="mz-list__title"><bdi>{hit.title}</bdi></span>
                            {hit.subtitle ? <span className="mz-caption"><bdi>{hit.subtitle}</bdi></span> : null}
                          </span>
                        </Link>
                      </li>
                    ))}
                </ul>
              </Card>
            ))}
          </QueryStates>
        )}
      </div>
    </>
  );
}

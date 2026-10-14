import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Chip, Menu, TextField } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { DataList } from '../components/DataList.js';
import type { Column } from '../components/DataList.js';
import { DualAmount } from '../components/DualAmount.js';
import { QueryStates } from '../components/states.js';
import { Pager } from '../components/Pager.js';
import { useKeepPageInRange, usePaging } from '../lib/paging.js';
import { useDebouncedValue } from '../lib/debounce.js';
import { useFormatter } from '../lib/store.js';
import { useIsWide } from '../lib/wide.js';

export interface ItemRow {
  id: string;
  name: string;
  code: string | null;
  pricing_unit: 'per_piece' | 'per_kg';
  is_active: boolean;
  stock: {
    priced_measure: 'count' | 'kg';
    priced_quantity: string;
    priced_complete: boolean;
    stock_count: number;
    stock_kg: string;
    count_complete: boolean;
    kg_complete: boolean;
    is_low: boolean;
  };
  sale: { amount_iqd: number; amount_usd_cents: number; from_month: string; source: string } | null;
  /** This month's bought price, in the currency it was set in; absent without the bought-price flag. */
  bought?: { amount_iqd: number; amount_usd_cents: number; entered_currency: 'IQD' | 'USD' } | null;
  last_sold_on: string | null;
}

type StockFilter = 'all' | 'in' | 'out';

/**
 * The Materials page (FR-307, spec 3.3): a search box and one **Filter** dropdown, then the
 * materials as a table on a desktop and cards on a phone — both from one row description via
 * DataList (spec 2.10.2). A material is a thing you count: the stock reads in pieces, and the
 * only weight in the system lives on an order line. Each row leads with its name, its stock,
 * and this month's sale price in both currencies; the bought price only for those allowed to
 * see it — the API sends it to no one else. The whole row is the link to its detail.
 */
export function MaterialsPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [search, setSearch] = useState('');
  // The request waits for the typing to stop (NFR-03): one search, not one per letter.
  const query = useDebouncedValue(search);
  const [stock, setStock] = useState<StockFilter>('all');
  const [onlyInactive, setOnlyInactive] = useState(false);

  const isWide = useIsWide();
  const paging = usePaging({ storageKey: 'materials', resetOn: [query, stock, onlyInactive] });

  const items = useQuery({
    queryKey: ['items', query, stock, onlyInactive, paging.page, paging.pageSize],
    queryFn: () => {
      // "Deactivated" is a filter like the two above it: it shows the deactivated materials
      // alone, not the whole list with them mixed in.
      const params = new URLSearchParams({ q: query, only_inactive: String(onlyInactive) });
      if (stock !== 'all') params.set('stock', stock);
      return apiRequest<{ items: ItemRow[]; total: number }>(`/items?${params.toString()}&${paging.query}`);
    },
    placeholderData: keepPreviousData,
  });
  useKeepPageInRange(paging, items);

  const rows = items.data?.items ?? [];

  usePageTitle(t('materials:title'));

  const quantityText = (item: ItemRow) =>
    item.stock.count_complete
      ? `${formatter.number(item.stock.stock_count)} ${t('common:count_symbol')}`
      : '—';

  const statusChips = (item: ItemRow) => (
    <span className="mz-row" style={{ gap: 'var(--space-1)' }}>
      {item.stock.is_low ? <Chip tone="warning">{t('materials:low')}</Chip> : null}
      {!item.is_active ? <Chip icon="close">{t('common:deactivated')}</Chip> : null}
    </span>
  );

  const columns: Column<ItemRow>[] = [
    {
      header: t('materials:name'),
      cell: (item) => (
        <span className="mz-cell">
          <span className="mz-cell__body">
            <bdi>{item.name}</bdi>
            {item.code ? (
              <span className="mz-caption">
                <bdi dir="ltr">{item.code}</bdi>
              </span>
            ) : null}
          </span>
        </span>
      ),
    },
    {
      header: t('glossary:quantity'),
      numeric: true,
      cell: (item) => <span data-tabular>{quantityText(item)}</span>,
    },
    {
      header: t('glossary:sale_price'),
      numeric: true,
      cell: (item) =>
        item.sale ? (
          <DualAmount
            amount_iqd={item.sale.amount_iqd}
            amount_usd_cents={item.sale.amount_usd_cents}
          />
        ) : (
          <span className="mz-caption">{t('materials:no_price_yet')}</span>
        ),
    },
    {
      header: t('glossary:bought_price'),
      numeric: true,
      secondary: true,
      cell: (item) =>
        item.bought ? (
          <span data-tabular>{formatter.money(item.bought.amount_iqd, 'IQD')}</span>
        ) : (
          <span className="mz-muted">—</span>
        ),
    },
    {
      header: t('glossary:date_sold'),
      secondary: true,
      cell: (item) =>
        item.last_sold_on ? (
          <span data-tabular>{formatter.date(item.last_sold_on)}</span>
        ) : (
          <span className="mz-muted">—</span>
        ),
    },
    { header: t('users:status'), cell: statusChips },
  ];

  return (
    <>
      <div className="mz-stack">
        <div className="mz-toolbar">
          <div className="mz-toolbar__filters">
            <div className="mz-toolbar__search">
              <TextField
                label={t('common:search')}
                placeholder={t('materials:search_placeholder')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                type="search"
                inputMode="search"
              />
            </div>
            {/* All the list's filters folded into one labelled dropdown button, next to search. */}
            <Menu
              label={t('common:filter')}
              icon="filter"
              variant="button"
              // Hung from the button's own leading edge on a desktop, like every dropdown; on a
              // phone the button may sit at the row's end, and the list opens inward.
              align={isWide ? 'start' : 'end'}
              items={[
                {
                  label: t('materials:filter_in_stock'),
                  current: stock === 'in',
                  onSelect: () => setStock(stock === 'in' ? 'all' : 'in'),
                },
                {
                  label: t('materials:filter_out_of_stock'),
                  current: stock === 'out',
                  onSelect: () => setStock(stock === 'out' ? 'all' : 'out'),
                },
                {
                  label: t('common:deactivated'),
                  current: onlyInactive,
                  onSelect: () => setOnlyInactive(!onlyInactive),
                },
              ]}
            />
          </div>
        </div>

        <QueryStates
          query={items}
          isEmpty={rows.length === 0}
          emptyTitle={query ? t('materials:empty_search', { query }) : t('materials:empty')}
          emptyBody={query ? undefined : t('materials:empty_body')}
        >
          <DataList
            rows={rows}
            columns={columns}
            rowKey={(item) => item.id}
            href={(item) => `/materials/${item.id}`}
            card={(item) => (
              <>
                <span className="mz-list__body">
                  <span className="mz-list__title">
                    <bdi>{item.name}</bdi>
                  </span>
                  <span className="mz-caption" style={{ display: 'block' }} data-tabular>
                    {t('glossary:quantity')}: {quantityText(item)}
                  </span>
                  {item.sale ? (
                    <DualAmount
                      amount_iqd={item.sale.amount_iqd}
                      amount_usd_cents={item.sale.amount_usd_cents}
                    />
                  ) : (
                    <span className="mz-caption">{t('materials:no_price_yet')}</span>
                  )}
                  {item.bought ? (
                    <span className="mz-caption" style={{ display: 'block' }}>
                      {t('glossary:bought_price')}: {formatter.money(item.bought.amount_iqd, 'IQD')}
                    </span>
                  ) : null}
                </span>
                {statusChips(item)}
              </>
            )}
          />
          <Pager
            page={paging.page}
            pageSize={paging.pageSize}
            total={items.data?.total ?? 0}
            onPage={paging.setPage}
            onPageSize={paging.setPageSize}
          />
        </QueryStates>
      </div>
    </>
  );
}

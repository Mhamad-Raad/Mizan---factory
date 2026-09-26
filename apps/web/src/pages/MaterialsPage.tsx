import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Chip, Icon, Menu, TextField } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { Can } from '../components/Can.js';
import { DataList } from '../components/DataList.js';
import type { Column } from '../components/DataList.js';
import { DualAmount } from '../components/DualAmount.js';
import { QueryStates } from '../components/states.js';
import { useFormatter } from '../lib/store.js';

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
  bought?: { amount_iqd: number; amount_usd_cents: number } | null;
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
  const [query, setQuery] = useState('');
  const [stock, setStock] = useState<StockFilter>('all');
  const [includeInactive, setIncludeInactive] = useState(false);

  const items = useQuery({
    queryKey: ['items', query, stock, includeInactive],
    queryFn: () => {
      const params = new URLSearchParams({ q: query, include_inactive: String(includeInactive) });
      if (stock !== 'all') params.set('stock', stock);
      return apiRequest<{ items: ItemRow[]; total: number }>(`/items?${params.toString()}`);
    },
  });

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
              <span className="mz-caption" dir="ltr">
                <bdi>{item.code}</bdi>
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
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                type="search"
                inputMode="search"
              />
            </div>
            {/* All the list's filters folded into one labelled dropdown button, next to search. */}
            <Menu
              label={t('common:filter')}
              icon="filter"
              variant="button"
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
                  current: includeInactive,
                  onSelect: () => setIncludeInactive(!includeInactive),
                },
              ]}
            />
          </div>

          {/* The warehouse's primary action here is a purchase, not a new material (spec 3.3). */}
          <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Can permission="purchases.create">
              <Link to="/purchases/new" className="mz-button mz-button--primary">
                <Icon name="purchases" />
                {t('purchases:add_material')}
              </Link>
            </Can>
            <Can permission="materials.create">
              <Link to="/materials/new" className="mz-button mz-button--secondary">
                <Icon name="plus" />
                {t('materials:new_material')}
              </Link>
            </Can>
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
        </QueryStates>
      </div>
    </>
  );
}

export function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className="mz-filter-chip" aria-pressed={active} onClick={onClick}>
      {active ? <Icon name="check" size={16} /> : null}
      {children}
    </button>
  );
}

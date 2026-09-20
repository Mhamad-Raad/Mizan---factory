import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Chip, TextField } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { AppShell } from '../components/AppShell.js';
import { Can } from '../components/Can.js';
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
 * The Materials page (FR-307, spec 3.3): search pinned at the top, filter chips, and rows
 * that lead with the stock in the material's own priced measure and this month's sale price
 * in both currencies. The bought price appears only for those allowed to see it — the API
 * does not send it to anyone else.
 */
export function MaterialsPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [query, setQuery] = useState('');
  const [stock, setStock] = useState<StockFilter>('all');
  const [unit, setUnit] = useState<'all' | 'per_kg' | 'per_piece'>('all');
  const [includeInactive, setIncludeInactive] = useState(false);

  const items = useQuery({
    queryKey: ['items', query, stock, unit, includeInactive],
    queryFn: () => {
      const params = new URLSearchParams({ q: query, include_inactive: String(includeInactive) });
      if (stock !== 'all') params.set('stock', stock);
      if (unit !== 'all') params.set('pricing_unit', unit);
      return apiRequest<{ items: ItemRow[]; total: number }>(`/items?${params.toString()}`);
    },
  });

  const rows = items.data?.items ?? [];

  return (
    <AppShell title={t('materials:title')}>
      <div className="mz-stack">
        <TextField
          label={t('common:search')}
          placeholder={t('materials:search_placeholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          type="search"
          inputMode="search"
        />

        <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <FilterChip active={stock === 'in'} onClick={() => setStock(stock === 'in' ? 'all' : 'in')}>
            {t('materials:filter_in_stock')}
          </FilterChip>
          <FilterChip active={stock === 'out'} onClick={() => setStock(stock === 'out' ? 'all' : 'out')}>
            {t('materials:filter_out_of_stock')}
          </FilterChip>
          <FilterChip active={unit === 'per_kg'} onClick={() => setUnit(unit === 'per_kg' ? 'all' : 'per_kg')}>
            {t('glossary:per_kg')}
          </FilterChip>
          <FilterChip active={unit === 'per_piece'} onClick={() => setUnit(unit === 'per_piece' ? 'all' : 'per_piece')}>
            {t('glossary:per_piece')}
          </FilterChip>
          <FilterChip active={includeInactive} onClick={() => setIncludeInactive(!includeInactive)}>
            {t('common:deactivated')}
          </FilterChip>
        </div>

        <Can permission="materials.create">
          <Link to="/materials/new" className="mz-button mz-button--primary mz-button--block">
            {t('materials:new_material')}
          </Link>
        </Can>

        <QueryStates
          query={items}
          isEmpty={rows.length === 0}
          emptyTitle={query ? t('materials:empty_search', { query }) : t('materials:empty')}
          emptyBody={query ? undefined : t('materials:empty_body')}
        >
          <ul className="mz-list">
            {rows.map((item) => (
              <li key={item.id}>
                <Link to={`/materials/${item.id}`} className="mz-list__item mz-list__item--interactive">
                  <span className="mz-list__body">
                    <span className="mz-list__title">{item.name}</span>
                    <span className="mz-caption" style={{ display: 'block' }} data-tabular>
                      {item.stock.priced_complete
                        ? t('materials:in_stock_quantity', {
                            quantity: formatter.number(item.stock.priced_quantity, item.stock.priced_measure === 'kg' ? 3 : 0),
                            unit: t(`common:${item.stock.priced_measure}_symbol`),
                          })
                        : t('materials:stock_unknown')}
                    </span>
                    {item.sale ? (
                      <DualAmount amount_iqd={item.sale.amount_iqd} amount_usd_cents={item.sale.amount_usd_cents} />
                    ) : (
                      <span className="mz-caption">{t('materials:no_price_yet')}</span>
                    )}
                    {item.bought ? (
                      <span className="mz-caption" style={{ display: 'block' }}>
                        {t('glossary:bought_price')}: {formatter.money(item.bought.amount_iqd, 'IQD')}
                      </span>
                    ) : null}
                  </span>
                  <span className="mz-row" style={{ gap: 'var(--space-1)' }}>
                    {item.stock.is_low ? <Chip tone="warning">{t('materials:low')}</Chip> : null}
                    {!item.is_active ? <Chip icon="close">{t('common:deactivated')}</Chip> : null}
                    <Chip>{t(`glossary:${item.pricing_unit}`)}</Chip>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </QueryStates>
      </div>
    </AppShell>
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
    <button
      type="button"
      className="mz-segmented__option"
      aria-pressed={active}
      onClick={onClick}
      style={{ borderRadius: 'var(--radius-lg)' }}
    >
      {children}
    </button>
  );
}

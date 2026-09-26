import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { DateField, Icon, TextField } from '@mizan/ui';
import type { Currency, Measure } from '@mizan/money';
import { apiRequest } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { Can } from '../components/Can.js';
import { QueryStates } from '../components/states.js';
import { Pager } from '../components/Pager.js';
import { PurchaseTable } from '../components/PurchaseTable.js';
import { usePaging } from '../lib/paging.js';
import { FilterChip } from './MaterialsPage.js';
import { useFormatter } from '../lib/store.js';

export interface PurchaseRow {
  id: string;
  number: number;
  company_id: string | null;
  company_name: string | null;
  settlement_currency: Currency | null;
  purchase_date: string;
  acting_user_id: string;
  acting_user_name: string | null;
  notes: string | null;
  rate_iqd_per_usd: string;
  rate_source: 'global' | 'manual' | 'company';
  doc_status: 'active' | 'void';
  void_reason: string | null;
  voided_by_name: string | null;
  voided_at: string | null;
  line_count: number;
  /** Absent for a caller without `fields.see_bought_price` (FR-460, spec 2.6.2). */
  cost?: {
    discount_iqd: number;
    discount_usd_cents: number;
    total_iqd: number;
    total_usd_cents: number;
  } | null;
  version: number;
  created_at: string;
}

export interface PurchaseDetail extends PurchaseRow {
  lines: {
    id: string;
    line_no: number;
    item_id: string;
    item_name: string;
    qty_count: number | null;
    qty_kg: string | null;
    priced_measure: Measure;
    rate_iqd_per_usd: string;
    rate_source: 'global' | 'manual' | 'company';
    note: string | null;
    cost?: {
      unit_price_iqd: number;
      unit_price_usd_cents: number;
      price_entered_currency: Currency;
      price_source: 'month' | 'override';
      price_from_month: string | null;
      line_total_iqd: number;
      line_total_usd_cents: number;
    } | null;
  }[];
  duplicate_item_warning?: { item_id: string; item_name: string }[];
}

type DateFilter = 'all' | 'today' | 'week' | 'month' | 'custom';

/**
 * The Purchases page (spec 3.3), laid out as the Orders page is (client review): one toolbar
 * with the search, the date, who recorded it and the two chips, "New purchase" at its end; then
 * the purchases as a table on a desktop and as cards on a phone, through the same `DataList`
 * the orders use. A purchase with no company reads "Stock only" (FR-407); the totals show only
 * to those allowed to see purchase amounts, and everything else shows either way.
 */
export function PurchasesPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [query, setQuery] = useState('');
  const [dates, setDates] = useState<DateFilter>('month');
  const [stockOnly, setStockOnly] = useState(false);
  const [voided, setVoided] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [doneBy, setDoneBy] = useState('');

  // Business dates are Asia/Baghdad days, through the same helper the rest of the app uses:
  // `new Date().toISOString()` is UTC, and for the first three hours of every Baghdad day it
  // names yesterday — which silently hid today's purchases from the list (I2 review).
  const range = dates === 'custom' ? rangeFor('all', formatter.today(), from, to) : rangeFor(dates, formatter.today(), '', '');

  const paging = usePaging({
    storageKey: 'purchases',
    resetOn: [query, range.from, range.to, stockOnly, voided, doneBy],
  });

  const purchases = useQuery({
    queryKey: ['purchases', query, range.from, range.to, stockOnly, voided, doneBy, paging.page, paging.pageSize],
    queryFn: () => {
      const params = new URLSearchParams({ q: query });
      if (range.from) params.set('from', range.from);
      if (range.to) params.set('to', range.to);
      if (stockOnly) params.set('company', 'stock_only');
      if (voided) params.set('status', 'void');
      if (doneBy) params.set('done_by', doneBy);
      return apiRequest<{ items: PurchaseRow[]; total: number }>(`/purchases?${params.toString()}&${paging.query}`);
    },
    // Keep the rows on screen while a filter or a page change refetches, as the Orders page does.
    placeholderData: keepPreviousData,
  });
  const refreshing = purchases.isFetching && purchases.isPlaceholderData;

  const directory = useQuery({
    queryKey: ['users', 'directory'],
    queryFn: () => apiRequest<{ id: string; display_name: string; is_active: boolean }[]>('/users/directory'),
  });

  const rows = purchases.data?.items ?? [];

  usePageTitle(t('purchases:title'));

  return (
    <div className="mz-stack">
      <div className="mz-toolbar">
        <div className="mz-toolbar__filters">
          <div className="mz-toolbar__search">
            <TextField
              label={t('common:search')}
              placeholder={t('purchases:search_hint')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              type="search"
              inputMode="search"
            />
          </div>
          <select
            className="mz-select"
            aria-label={t('common:date')}
            value={dates}
            onChange={(event) => setDates(event.target.value as DateFilter)}
          >
            <option value="today">{t('common:today')}</option>
            <option value="week">{t('common:this_week')}</option>
            <option value="month">{t('common:this_month')}</option>
            <option value="all">{t('orders:any_date')}</option>
            <option value="custom">{t('common:custom_range')}</option>
          </select>
          <select
            className="mz-select"
            aria-label={t('glossary:done_by')}
            value={doneBy}
            onChange={(event) => setDoneBy(event.target.value)}
          >
            <option value="">{t('orders:anyone')}</option>
            {(directory.data ?? [])
              .filter((user) => user.is_active)
              .map((user) => (
                <option key={user.id} value={user.id}>
                  {user.display_name}
                </option>
              ))}
          </select>
          <FilterChip active={stockOnly} onClick={() => setStockOnly(!stockOnly)}>
            {t('purchases:filter_stock_only')}
          </FilterChip>
          <FilterChip active={voided} onClick={() => setVoided(!voided)}>
            {t('purchases:filter_voided')}
          </FilterChip>
        </div>

        <Can permission="purchases.create">
          <Link to="/purchases/new" className="mz-button mz-button--primary">
            <Icon name="plus" />
            {t('purchases:add_material')}
          </Link>
        </Can>
      </div>

      {/* A custom period opens its two dates in place, rather than behind a sheet. */}
      {dates === 'custom' ? (
        <div className="mz-grid-2">
          <DateField
            label={t('common:date_from')}
            value={from}
            max={to || formatter.today()}
            onChange={(event) => setFrom(event.target.value)}
          />
          <DateField
            label={t('common:date_to')}
            value={to}
            min={from || undefined}
            max={formatter.today()}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
      ) : null}

      <QueryStates
        query={purchases}
        isEmpty={rows.length === 0}
        emptyTitle={query ? t('purchases:empty_search', { query }) : t('purchases:empty')}
        emptyAction={
          <Can permission="purchases.create">
            <Link to="/purchases/new" className="mz-button mz-button--primary">
              {t('purchases:add_material')}
            </Link>
          </Can>
        }
      >
        <div className="mz-refreshable" data-busy={refreshing ? 'true' : undefined} aria-busy={refreshing}>
          <PurchaseTable rows={rows} />
        </div>
        <Pager
          page={paging.page}
          pageSize={paging.pageSize}
          total={purchases.data?.total ?? 0}
          onPage={paging.setPage}
          onPageSize={paging.setPageSize}
        />
      </QueryStates>
    </div>
  );
}

/** The date chips of spec 3.3, resolved from today's **Baghdad** day (2.10.4). */
export function rangeFor(
  filter: DateFilter,
  today: string,
  from: string,
  to: string,
): { from?: string; to?: string } {
  if (from || to) return { from: from || undefined, to: to || undefined };
  if (filter === 'all') return {};
  if (filter === 'today') return { from: today, to: today };
  if (filter === 'week') {
    const start = new Date(`${today}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 6);
    return { from: start.toISOString().slice(0, 10), to: today };
  }
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

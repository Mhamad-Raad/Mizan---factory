import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { BottomSheet, Button, Chip, DateField, TextField } from '@mizan/ui';
import type { Currency, Measure } from '@mizan/money';
import { apiRequest } from '../lib/api.js';
import { AppShell } from '../components/AppShell.js';
import { Can } from '../components/Can.js';
import { DualAmount } from '../components/DualAmount.js';
import { QueryStates } from '../components/states.js';
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

type DateFilter = 'all' | 'today' | 'week' | 'month';

/**
 * The Purchases page (spec 3.3): date chips and a filter sheet, rows leading with the number,
 * the company — or "Stock only" when there is none (FR-407) — and the total in both
 * currencies for those allowed to see purchase amounts. Quantities stay visible either way.
 */
export function PurchasesPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [query, setQuery] = useState('');
  const [dates, setDates] = useState<DateFilter>('month');
  const [stockOnly, setStockOnly] = useState(false);
  const [voided, setVoided] = useState(false);
  const [filters, setFilters] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [doneBy, setDoneBy] = useState('');

  // Business dates are Asia/Baghdad days, through the same helper the rest of the app uses:
  // `new Date().toISOString()` is UTC, and for the first three hours of every Baghdad day it
  // names yesterday — which silently hid today's purchases from the list (I2 review).
  const range = rangeFor(dates, formatter.today(), from, to);

  const purchases = useQuery({
    queryKey: ['purchases', query, range.from, range.to, stockOnly, voided, doneBy],
    queryFn: () => {
      const params = new URLSearchParams({ q: query });
      if (range.from) params.set('from', range.from);
      if (range.to) params.set('to', range.to);
      if (stockOnly) params.set('company', 'stock_only');
      if (voided) params.set('status', 'void');
      if (doneBy) params.set('done_by', doneBy);
      return apiRequest<{ items: PurchaseRow[]; total: number }>(`/purchases?${params.toString()}`);
    },
  });

  const directory = useQuery({
    queryKey: ['users', 'directory'],
    queryFn: () => apiRequest<{ id: string; display_name: string; is_active: boolean }[]>('/users/directory'),
    enabled: filters,
  });

  const rows = purchases.data?.items ?? [];

  return (
    <AppShell title={t('purchases:title')}>
      <div className="mz-stack">
        <TextField
          label={t('common:search')}
          placeholder={t('purchases:search_hint')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          type="search"
          inputMode="search"
        />

        <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <FilterChip active={dates === 'today'} onClick={() => setDates(dates === 'today' ? 'all' : 'today')}>
            {t('common:today')}
          </FilterChip>
          <FilterChip active={dates === 'week'} onClick={() => setDates(dates === 'week' ? 'all' : 'week')}>
            {t('common:this_week')}
          </FilterChip>
          <FilterChip active={dates === 'month'} onClick={() => setDates(dates === 'month' ? 'all' : 'month')}>
            {t('common:this_month')}
          </FilterChip>
          <FilterChip active={stockOnly} onClick={() => setStockOnly(!stockOnly)}>
            {t('purchases:filter_stock_only')}
          </FilterChip>
          <FilterChip active={voided} onClick={() => setVoided(!voided)}>
            {t('purchases:filter_voided')}
          </FilterChip>
          <FilterChip active={filters} onClick={() => setFilters(true)}>
            {t('orders:more_filters')}
          </FilterChip>
        </div>

        <Can permission="purchases.create">
          <Link to="/purchases/new" className="mz-button mz-button--primary mz-button--block">
            {t('purchases:add_material')}
          </Link>
        </Can>

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
          <ul className="mz-list">
            {rows.map((purchase) => (
              <li key={purchase.id}>
                <Link to={`/purchases/${purchase.id}`} className="mz-list__item mz-list__item--interactive">
                  <span className="mz-list__body">
                    <span className="mz-list__title">
                      {t('purchases:number', { number: formatter.number(purchase.number) })}
                    </span>
                    <span className="mz-caption" style={{ display: 'block' }}>
                      {purchase.company_name ?? t('purchases:stock_only_badge')} · {formatter.date(purchase.purchase_date)}
                      {purchase.acting_user_name ? ` · ${purchase.acting_user_name}` : ''}
                    </span>
                    <span className="mz-caption" style={{ display: 'block' }}>
                      {t('purchases:lines_count', { count: purchase.line_count })}
                    </span>
                    {purchase.cost ? (
                      <DualAmount
                        amount_iqd={purchase.cost.total_iqd}
                        amount_usd_cents={purchase.cost.total_usd_cents}
                        primary={purchase.settlement_currency ?? 'IQD'}
                      />
                    ) : null}
                  </span>
                  <span className="mz-list__end">
                    {purchase.company_id === null ? <Chip>{t('purchases:stock_only_badge')}</Chip> : null}
                    {purchase.doc_status === 'void' ? (
                      <Chip tone="danger" icon="close">
                        {t('glossary:void')}
                      </Chip>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </QueryStates>

        {filters ? (
          <BottomSheet
            title={t('orders:more_filters')}
            open
            onClose={() => setFilters(false)}
            closeLabel={t('common:close')}
          >
            <div className="mz-stack">
              <DateField
                label={t('common:custom_range')}
                value={from}
                max={formatter.today()}
                onChange={(event) => {
                  setFrom(event.target.value);
                  setDates('all');
                }}
              />
              <DateField
                label={t('common:custom_range')}
                value={to}
                max={formatter.today()}
                onChange={(event) => {
                  setTo(event.target.value);
                  setDates('all');
                }}
              />
              <label className="mz-field">
                <span className="mz-field__label">{t('common:done_by')}</span>
                <select
                  className="mz-field__control"
                  value={doneBy}
                  onChange={(event) => setDoneBy(event.target.value)}
                >
                  <option value="">{t('history:everyone')}</option>
                  {(directory.data ?? [])
                    .filter((user) => user.is_active)
                    .map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.display_name}
                      </option>
                    ))}
                </select>
              </label>
              <Button block onClick={() => setFilters(false)}>
                {t('common:close')}
              </Button>
            </div>
          </BottomSheet>
        ) : null}
      </div>
    </AppShell>
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

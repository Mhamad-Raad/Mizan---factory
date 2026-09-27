import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Chip, Icon, TextField } from '@mizan/ui';
import type { Currency, Measure } from '@mizan/money';
import { apiRequest } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { Can } from '../components/Can.js';
import { DualAmount } from '../components/DualAmount.js';
import { QueryStates } from '../components/states.js';
import { DataList } from '../components/DataList.js';
import type { Column } from '../components/DataList.js';
import { Pager } from '../components/Pager.js';
import { usePaging } from '../lib/paging.js';
import type { DamageAttribution, ReturnStatus } from '../components/chips.js';
import { FilterChip } from './MaterialsPage.js';
import { useFormatter } from '../lib/store.js';

export interface DamageRow {
  id: string;
  number: number;
  item_id: string;
  item_name: string;
  priced_measure: Measure;
  qty_count: number | null;
  qty_kg: string | null;
  damage_date: string;
  acting_user_id: string;
  acting_user_name: string | null;
  reason: string | null;
  attribution: DamageAttribution;
  order_id: string | null;
  order_number: number | null;
  customer_id: string | null;
  customer_name: string | null;
  company_id: string | null;
  company_name: string | null;
  purchase_id: string | null;
  purchase_number: number | null;
  is_returnable: boolean;
  return_status: ReturnStatus;
  returned_at: string | null;
  returned_by_name: string | null;
  stock_effect: 'reduced' | 'none' | 'returned_in';
  credited: boolean;
  notes: string | null;
  doc_status: 'active' | 'void';
  void_reason: string | null;
  voided_by_name: string | null;
  version: number;
  created_at: string;
  /**
   * A company's damage is owed by that company until it is marked paid back, in money or in
   * materials (D-062); our own damage is simply a loss (`none`).
   */
  compensation: 'none' | 'owed' | 'paid_money' | 'paid_materials';
  compensated_at: string | null;
  /** Absent for a caller without `fields.see_bought_price` (FR-807). */
  cost?: {
    est_value_iqd: number | null;
    est_value_usd_cents: number | null;
    est_value_source: 'month' | 'fallback' | 'lots' | 'none';
  } | null;
}

export interface DamageDetail extends DamageRow {
  credit_prefill: {
    amount_iqd: number;
    amount_usd_cents: number;
    entered_currency: Currency;
    rate_iqd_per_usd: string;
    rate_source: string;
    source: 'purchase_line' | 'month' | 'fallback';
    from_month: string | null;
  } | null;
  credits: {
    side: 'company' | 'customer';
    owner_id: string;
    owner_name: string;
    entry_id: string;
    entry_date: string;
    settlement_currency: Currency;
    note: string | null;
    cost?: { amount_iqd: number; amount_usd_cents: number } | null;
  }[];
}

export interface DamageTotals {
  records: number;
  qty_count: number;
  qty_kg: string;
  unvalued: number;
  /** Records a company still owes us for (D-062). */
  owed_count: number;
  cost?: { est_value_iqd: number; est_value_usd_cents: number; owed_iqd: number; owed_usd_cents: number } | null;
}

type DateFilter = 'month' | 'last_month' | 'all';
type Who = '' | DamageAttribution;
type Status = '' | 'owed' | 'paid';

/**
 * Broken goods (FR-801, FR-807, spec 3.3; D-062; renamed from "damaged items" at the client's
 * request), laid out as the Orders page is: one toolbar — search, the period, who broke it,
 * whether a company still owes for it, who recorded it, voided — with "Record broken goods" at
 * its end; the period's figures as tiles; then the records as a table on a desktop and cards on
 * a phone. Values only for those allowed to see bought prices; quantities always.
 */
export function DamagesPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [query, setQuery] = useState('');
  const [dates, setDates] = useState<DateFilter>('month');
  const [voided, setVoided] = useState(false);
  const [doneBy, setDoneBy] = useState('');
  const [who, setWho] = useState<Who>('');
  const [status, setStatus] = useState<Status>('');
  const [searchParams] = useSearchParams();
  const linked = {
    item_id: searchParams.get('item'),
    order_id: searchParams.get('order'),
    purchase_id: searchParams.get('purchase'),
  };
  const isLinked = Boolean(linked.item_id || linked.order_id || linked.purchase_id);

  const today = formatter.today();
  const range = isLinked ? {} : rangeOf(dates, today);

  const paging = usePaging({
    storageKey: 'damages',
    resetOn: [query, range.from, range.to, voided, doneBy, who, status, linked.item_id, linked.order_id, linked.purchase_id],
  });

  const damages = useQuery({
    queryKey: [
      'damages',
      query,
      range.from,
      range.to,
      voided,
      doneBy,
      who,
      status,
      linked.item_id,
      linked.order_id,
      linked.purchase_id,
      paging.page,
      paging.pageSize,
    ],
    queryFn: () => {
      const params = new URLSearchParams({ q: query });
      if (range.from) params.set('from', range.from);
      if (range.to) params.set('to', range.to);
      if (linked.item_id) params.set('item_id', linked.item_id);
      if (linked.order_id) params.set('order_id', linked.order_id);
      if (linked.purchase_id) params.set('purchase_id', linked.purchase_id);
      if (voided) params.set('include_void', 'true');
      if (doneBy) params.set('done_by', doneBy);
      if (who) params.set('attribution', who);
      if (status) params.set('compensation', status);
      return apiRequest<{ items: DamageRow[]; total: number; totals: DamageTotals }>(
        `/damages?${params.toString()}&${paging.query}`,
      );
    },
    // Keep the rows on screen while a filter or a page change refetches, as Orders does.
    placeholderData: keepPreviousData,
  });
  const refreshing = damages.isFetching && damages.isPlaceholderData;

  const directory = useQuery({
    queryKey: ['users', 'directory'],
    queryFn: () => apiRequest<{ id: string; display_name: string; is_active: boolean }[]>('/users/directory'),
  });

  const rows = damages.data?.items ?? [];
  const totals = damages.data?.totals;

  usePageTitle(t('damages:title'));

  const quantities = totals
    ? [
        Number(totals.qty_kg) > 0 ? `${formatter.quantity(totals.qty_kg)} ${t('common:kg_symbol')}` : null,
        totals.qty_count > 0 ? `${formatter.number(totals.qty_count)} ${t('common:count_symbol')}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  const whoOf = (damage: DamageRow) =>
    damage.attribution === 'company' && damage.company_name ? (
      <bdi>{damage.company_name}</bdi>
    ) : (
      <span className="mz-muted">{t('damages:ours_label')}</span>
    );

  const value = (damage: DamageRow) =>
    damage.cost && damage.cost.est_value_iqd !== null ? (
      <DualAmount amount_iqd={damage.cost.est_value_iqd} amount_usd_cents={damage.cost.est_value_usd_cents ?? 0} />
    ) : (
      <span className="mz-muted">—</span>
    );

  const statusOf = (damage: DamageRow) => (
    <span className="mz-rowcard__chips">
      <CompensationChip compensation={damage.compensation} />
      {damage.doc_status === 'void' ? (
        <Chip tone="danger" icon="close">
          {t('glossary:void')}
        </Chip>
      ) : null}
    </span>
  );

  const columns: Column<DamageRow>[] = [
    {
      header: t('common:number_column'),
      cell: (damage) => (
        <span className="mz-cell__body">
          <strong>{t('damages:number', { number: formatter.number(damage.number) })}</strong>
          <span className="mz-caption">{formatter.date(damage.damage_date)}</span>
        </span>
      ),
    },
    {
      header: t('damages:material_column'),
      cell: (damage) => (
        <span className="mz-cell__body">
          <bdi>{damage.item_name}</bdi>
          <span className="mz-caption" data-tabular>
            {quantityOf(damage, formatter, t)}
          </span>
        </span>
      ),
    },
    { header: t('damages:who_column'), cell: whoOf },
    { header: t('common:status'), cell: statusOf },
    {
      header: t('glossary:done_by'),
      secondary: true,
      cell: (damage) =>
        damage.acting_user_name ? <bdi>{damage.acting_user_name}</bdi> : <span className="mz-muted">—</span>,
    },
    { header: t('damages:value_column'), numeric: true, cell: value },
  ];

  return (
    <div className="mz-stack">
      <div className="mz-toolbar">
        <div className="mz-toolbar__filters">
          <div className="mz-toolbar__search">
            <TextField
              label={t('common:search')}
              placeholder={t('damages:search_hint')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              type="search"
              inputMode="search"
            />
          </div>
          {!isLinked ? (
            <select
              className="mz-select"
              aria-label={t('common:date')}
              value={dates}
              onChange={(event) => setDates(event.target.value as DateFilter)}
            >
              <option value="month">{t('common:this_month')}</option>
              <option value="last_month">{t('damages:last_month')}</option>
              <option value="all">{t('orders:any_date')}</option>
            </select>
          ) : null}
          <select
            className="mz-select"
            aria-label={t('damages:who_column')}
            value={who}
            onChange={(event) => setWho(event.target.value as Who)}
          >
            <option value="">{t('damages:who_anyone')}</option>
            <option value="us">{t('damages:who.us')}</option>
            <option value="company">{t('damages:who.company')}</option>
          </select>
          <select
            className="mz-select"
            aria-label={t('common:status')}
            value={status}
            onChange={(event) => setStatus(event.target.value as Status)}
          >
            <option value="">{t('damages:status_any')}</option>
            <option value="owed">{t('damages:compensation.owed')}</option>
            <option value="paid">{t('damages:compensation.paid')}</option>
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
          <FilterChip active={voided} onClick={() => setVoided(!voided)}>
            {t('damages:filter_voided')}
          </FilterChip>
        </div>

        <Can permission="damages.create">
          <Link to="/damages/new" className="mz-button mz-button--primary">
            <Icon name="plus" />
            {t('damages:record')}
          </Link>
        </Can>
      </div>

      {/* The period's figures (FR-807): how much broke, what it cost us, and what companies
          still owe us for — quantities always, money with the bought-price permission. */}
      {totals ? (
        <div className="mz-kpis mz-kpis--three">
          <div className="mz-kpi">
            <span className="mz-kpi__head">
              <span className="mz-kpi__icon" aria-hidden="true">
                <Icon name="warning" size={18} />
              </span>
              <span className="mz-caption">{t('damages:tile_recorded')}</span>
            </span>
            <span className="mz-kpi__count" data-tabular>
              {formatter.number(totals.records)}
            </span>
            <span className="mz-caption" data-tabular>
              {quantities || '—'}
            </span>
          </div>
          {totals.cost ? (
            <div className="mz-kpi">
              <span className="mz-kpi__head">
                <span className="mz-kpi__icon" aria-hidden="true">
                  <Icon name="materials" size={18} />
                </span>
                <span className="mz-caption">{t('damages:tile_value')}</span>
              </span>
              <DualAmount amount_iqd={totals.cost.est_value_iqd} amount_usd_cents={totals.cost.est_value_usd_cents} />
              {totals.unvalued > 0 ? (
                <span className="mz-caption">{t('damages:totals_unvalued', { count: totals.unvalued })}</span>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            className="mz-kpi mz-kpi--button"
            aria-pressed={status === 'owed'}
            onClick={() => setStatus(status === 'owed' ? '' : 'owed')}
          >
            <span className="mz-kpi__head">
              <span className="mz-kpi__icon" aria-hidden="true">
                <Icon name="clock" size={18} />
              </span>
              <span className="mz-caption">{t('damages:tile_owed')}</span>
            </span>
            <span className="mz-kpi__count" data-tabular>
              {formatter.number(totals.owed_count)}
            </span>
            {totals.cost ? (
              <DualAmount amount_iqd={totals.cost.owed_iqd} amount_usd_cents={totals.cost.owed_usd_cents} />
            ) : null}
          </button>
        </div>
      ) : null}

      <QueryStates
        query={damages}
        isEmpty={rows.length === 0}
        emptyTitle={query ? t('damages:empty_search', { query }) : t('damages:empty')}
        emptyAction={
          <Can permission="damages.create">
            <Link to="/damages/new" className="mz-button mz-button--primary">
              {t('damages:record')}
            </Link>
          </Can>
        }
      >
        <div className="mz-refreshable" data-busy={refreshing ? 'true' : undefined} aria-busy={refreshing}>
          <DataList
            rows={rows}
            rowKey={(damage) => damage.id}
            href={(damage) => `/damages/${damage.id}`}
            columns={columns}
            card={(damage) => (
              <span className="mz-rowcard">
                <span className="mz-rowcard__head">
                  <span className="mz-list__title">
                    <bdi>{damage.item_name}</bdi>
                  </span>
                  {statusOf(damage)}
                </span>
                <span className="mz-caption" data-tabular>
                  {t('damages:number', { number: formatter.number(damage.number) })} ·{' '}
                  {quantityOf(damage, formatter, t)} · {formatter.date(damage.damage_date)}
                </span>
                {damage.reason ? (
                  <span className="mz-caption">
                    <bdi>{damage.reason}</bdi>
                  </span>
                ) : null}
                <span className="mz-rowcard__foot">
                  <span className="mz-caption">{whoOf(damage)}</span>
                  {value(damage)}
                </span>
              </span>
            )}
          />
        </div>
        <Pager
          page={paging.page}
          pageSize={paging.pageSize}
          total={damages.data?.total ?? 0}
          onPage={paging.setPage}
          onPageSize={paging.setPageSize}
        />
      </QueryStates>
    </div>
  );
}

/** The period chips, from today's Baghdad day. */
function rangeOf(filter: DateFilter, today: string): { from?: string; to?: string } {
  if (filter === 'all') return {};
  if (filter === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  const first = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  first.setUTCDate(0);
  const last = first.toISOString().slice(0, 10);
  return { from: `${last.slice(0, 7)}-01`, to: last };
}

/** The quantity as the material measures it, with the other measure when it was recorded. */
export function quantityOf(
  damage: Pick<DamageRow, 'priced_measure' | 'qty_count' | 'qty_kg'>,
  formatter: ReturnType<typeof useFormatter>,
  t: (key: string) => string,
): string {
  const parts: string[] = [];
  if (damage.qty_kg !== null) parts.push(`${formatter.quantity(damage.qty_kg)} ${t('common:kg_symbol')}`);
  if (damage.qty_count !== null) parts.push(`${formatter.number(damage.qty_count)} ${t('common:count_symbol')}`);
  return damage.priced_measure === 'kg' ? parts.join(' · ') : parts.reverse().join(' · ');
}

/**
 * Where a company's damage stands (D-062): owed until it is paid back. Our own damage has no
 * chip — it is a loss, and there is nothing to wait for. Icon and word, never colour alone.
 */
export function CompensationChip({ compensation }: { compensation: DamageRow['compensation'] }) {
  const { t } = useTranslation();
  if (compensation === 'none') return null;
  if (compensation === 'owed') {
    return (
      <Chip tone="warning" icon="clock">
        {t('damages:compensation.owed')}
      </Chip>
    );
  }
  return (
    <Chip tone="success" icon="check">
      {t('damages:compensation.paid')}
    </Chip>
  );
}

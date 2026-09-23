import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { BottomSheet, Button, Card, Chip, TextField } from '@mizan/ui';
import type { Currency, Measure } from '@mizan/money';
import { apiRequest } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { Can } from '../components/Can.js';
import { DualAmount } from '../components/DualAmount.js';
import { QueryStates } from '../components/states.js';
import { AttributionChip, ReturnStatusChip } from '../components/chips.js';
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
  /** Absent for a caller without `fields.see_bought_price` (FR-807). */
  cost?: {
    est_value_iqd: number | null;
    est_value_usd_cents: number | null;
    est_value_source: 'month' | 'fallback' | 'none';
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
  cost?: { est_value_iqd: number; est_value_usd_cents: number } | null;
}

type DateFilter = 'all' | 'month';

/**
 * The Damaged items page (FR-801, FR-807, spec 3.3): the chips an owner scans with — what is
 * still expected back, what can go back at all, this period — the period totals of FR-807, and
 * rows that lead with the material and its quantity. The value appears only for those allowed
 * to see bought prices; the quantities never disappear.
 */
export function DamagesPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [query, setQuery] = useState('');
  const [dates, setDates] = useState<DateFilter>('month');
  const [pending, setPending] = useState(false);
  const [returnable, setReturnable] = useState(false);
  const [voided, setVoided] = useState(false);
  const [filters, setFilters] = useState(false);
  const [doneBy, setDoneBy] = useState('');
  const [attribution, setAttribution] = useState<DamageAttribution | ''>('');
  // The links from a material, an order and a purchase arrive as a filter on this list rather
  // than as a page of their own (FR-807: the list is where damage is listed).
  const [searchParams] = useSearchParams();
  const linked = {
    item_id: searchParams.get('item'),
    order_id: searchParams.get('order'),
    purchase_id: searchParams.get('purchase'),
  };
  const isLinked = Boolean(linked.item_id || linked.order_id || linked.purchase_id);

  // A link from a document shows everything it has had damaged, whatever the period chip says.
  const range =
    dates === 'month' && !isLinked
      ? { from: `${formatter.today().slice(0, 7)}-01`, to: formatter.today() }
      : {};

  const damages = useQuery({
    queryKey: [
      'damages',
      query,
      range.from,
      range.to,
      pending,
      returnable,
      voided,
      doneBy,
      attribution,
      linked.item_id,
      linked.order_id,
      linked.purchase_id,
    ],
    queryFn: () => {
      const params = new URLSearchParams({ q: query });
      if (range.from) params.set('from', range.from);
      if (range.to) params.set('to', range.to);
      if (linked.item_id) params.set('item_id', linked.item_id);
      if (linked.order_id) params.set('order_id', linked.order_id);
      if (linked.purchase_id) params.set('purchase_id', linked.purchase_id);
      if (pending) params.set('return_status', 'pending');
      if (returnable) params.set('returnable', 'true');
      if (voided) params.set('include_void', 'true');
      if (doneBy) params.set('done_by', doneBy);
      if (attribution) params.set('attribution', attribution);
      return apiRequest<{ items: DamageRow[]; total: number; totals: DamageTotals }>(
        `/damages?${params.toString()}`,
      );
    },
  });

  const directory = useQuery({
    queryKey: ['users', 'directory'],
    queryFn: () => apiRequest<{ id: string; display_name: string; is_active: boolean }[]>('/users/directory'),
    enabled: filters,
  });

  const rows = damages.data?.items ?? [];
  const totals = damages.data?.totals;

  usePageTitle(t('damages:title'));

  return (
    <>
      <div className="mz-stack">
        <TextField
          label={t('common:search')}
          placeholder={t('damages:search_hint')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          type="search"
          inputMode="search"
        />

        <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <FilterChip active={pending} onClick={() => setPending(!pending)}>
            {t('damages:filter_pending')}
          </FilterChip>
          <FilterChip active={returnable} onClick={() => setReturnable(!returnable)}>
            {t('damages:filter_returnable')}
          </FilterChip>
          {!isLinked ? (
            <FilterChip active={dates === 'month'} onClick={() => setDates(dates === 'month' ? 'all' : 'month')}>
              {t('common:this_month')}
            </FilterChip>
          ) : null}
          <FilterChip active={voided} onClick={() => setVoided(!voided)}>
            {t('damages:filter_voided')}
          </FilterChip>
          <FilterChip active={filters} onClick={() => setFilters(true)}>
            {t('orders:more_filters')}
          </FilterChip>
        </div>

        {/* The period totals of FR-807: quantities always, value with the permission. */}
        {totals ? (
          <Card>
            <div className="mz-row mz-row--between">
              <span className="mz-caption">{t('damages:period_totals')}</span>
              <span className="mz-caption">{t('damages:totals_records', { count: totals.records })}</span>
            </div>
            <div className="mz-row mz-row--between">
              <span data-tabular>
                {Number(totals.qty_kg) > 0
                  ? `${formatter.number(totals.qty_kg, 3)} ${t('common:kg_symbol')}`
                  : null}
                {totals.qty_count > 0
                  ? ` ${formatter.number(totals.qty_count)} ${t('common:count_symbol')}`
                  : null}
              </span>
              {totals.cost ? (
                <DualAmount
                  amount_iqd={totals.cost.est_value_iqd}
                  amount_usd_cents={totals.cost.est_value_usd_cents}
                />
              ) : null}
            </div>
            {totals.cost && totals.unvalued > 0 ? (
              <span className="mz-caption">{t('damages:totals_unvalued', { count: totals.unvalued })}</span>
            ) : null}
          </Card>
        ) : null}

        <Can permission="damages.create">
          <Link to="/damages/new" className="mz-button mz-button--primary mz-button--block">
            {t('damages:record')}
          </Link>
        </Can>

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
          <ul className="mz-list">
            {rows.map((damage) => (
              <li key={damage.id}>
                <Link to={`/damages/${damage.id}`} className="mz-list__item mz-list__item--interactive">
                  {/* Everything in the body, chips included: a trailing chip column squeezed
                      the material's name to one word per line (REVIEW-I1 finding 9). */}
                  <span className="mz-list__body">
                    <span className="mz-list__title"><bdi>{damage.item_name}</bdi></span>
                    <span className="mz-caption" style={{ display: 'block' }} data-tabular>
                      {quantityOf(damage, formatter, t)} · {formatter.date(damage.damage_date)}
                      {damage.acting_user_name ? ` · ${damage.acting_user_name}` : ''}
                    </span>
                    {damage.reason ? <span className="mz-caption">{damage.reason}</span> : null}
                    <span className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                      <AttributionChip attribution={damage.attribution} />
                      <ReturnStatusChip status={damage.return_status} />
                      {damage.doc_status === 'void' ? (
                        <Chip tone="danger" icon="close">
                          {t('glossary:void')}
                        </Chip>
                      ) : null}
                    </span>
                    {damage.cost?.est_value_iqd !== null && damage.cost ? (
                      <DualAmount
                        amount_iqd={damage.cost.est_value_iqd ?? 0}
                        amount_usd_cents={damage.cost.est_value_usd_cents ?? 0}
                      />
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
              <label className="mz-field">
                <span className="mz-field__label">{t('damages:attribution')}</span>
                <select
                  className="mz-field__control"
                  value={attribution}
                  onChange={(event) => setAttribution(event.target.value as DamageAttribution | '')}
                >
                  <option value="">{t('common:all')}</option>
                  {(['customer_order', 'us', 'company', 'none'] as DamageAttribution[]).map((value) => (
                    <option key={value} value={value}>
                      {t(`damages:attribution.${value}`)}
                    </option>
                  ))}
                </select>
              </label>
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
                        <bdi>{user.display_name}</bdi>
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
    </>
  );
}

/** The quantity as the material measures it, with the other measure when it was recorded. */
export function quantityOf(
  damage: Pick<DamageRow, 'priced_measure' | 'qty_count' | 'qty_kg'>,
  formatter: { number: (value: string | number, decimals?: number) => string },
  t: (key: string) => string,
): string {
  const parts: string[] = [];
  if (damage.qty_kg !== null) parts.push(`${formatter.number(damage.qty_kg, 3)} ${t('common:kg_symbol')}`);
  if (damage.qty_count !== null) parts.push(`${formatter.number(damage.qty_count)} ${t('common:count_symbol')}`);
  return damage.priced_measure === 'kg' ? parts.join(' · ') : parts.reverse().join(' · ');
}

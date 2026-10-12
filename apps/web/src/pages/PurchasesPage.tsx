import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Button, Icon, TextField } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { Can } from '../components/Can.js';
import { QueryStates } from '../components/states.js';
import { DualAmount } from '../components/DualAmount.js';
import { KpiHead } from '../components/KpiHead.js';
import { FilterChip } from '../components/FilterChip.js';
import { PurchaseTable } from '../components/PurchaseTable.js';
import { PrintSelectionBar, usePrintSelection } from '../components/PrintSelection.js';
import { Pager } from '../components/Pager.js';
import { useKeepPageInRange, usePaging } from '../lib/paging.js';
import { useDebouncedValue } from '../lib/debounce.js';
import { presetPeriod } from '../lib/periods.js';
import { usePrint } from '../lib/print.js';
import { useFormatter } from '../lib/store.js';
import { useGlobalRate } from '../lib/rates.js';
import { bothOf } from '../lib/money.js';
import type { Currency, Rate } from '@mizan/money';
import type { PurchaseRow } from '../lib/purchases.js';

type DateChip = 'today' | 'week' | 'month' | 'all';

/** The list's figures over the whole filter; each part is absent without its flag. */
interface PurchaseTotals {
  buys: number;
  cost?: { total_iqd: number; total_usd_cents: number };
  owed_by_us?: { companies: number; owed_iqd: number; owed_usd_cents: number };
}

/**
 * The Purchases page (D-085): everything we bought, from which company, and what it came to.
 *
 * The business keeps this system mostly to keep up with its buying, so the page is laid out as
 * Orders is — a toolbar of filters, three figures over the whole filter, and the list — and its
 * third figure is what we still owe the companies altogether, which opens the companies we owe.
 * Old purchases can be ticked and their receipts printed again, or the whole list printed.
 */
export function PurchasesPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const print = usePrint();

  const [chip, setChip] = useState<DateChip>('month');
  const [voidedOnly, setVoidedOnly] = useState(false);
  const [doneBy, setDoneBy] = useState('');
  const [search, setSearch] = useState('');
  const query = useDebouncedValue(search);

  const range = presetPeriod(chip, formatter.today());
  const paging = usePaging({ storageKey: 'purchases', resetOn: [chip, voidedOnly, doneBy, query] });

  const filters = new URLSearchParams();
  if (range.from) filters.set('from', range.from);
  if (range.to) filters.set('to', range.to);
  if (voidedOnly) filters.set('status', 'void');
  if (doneBy) filters.set('done_by', doneBy);
  if (query) filters.set('q', query);
  const filterQuery = filters.toString();

  const purchases = useQuery({
    queryKey: ['purchases', 'list', filterQuery, paging.page, paging.pageSize],
    queryFn: () =>
      apiRequest<{ items: PurchaseRow[]; total: number; totals: PurchaseTotals }>(
        `/purchases?${filterQuery}${filterQuery ? '&' : ''}${paging.query}`,
      ),
    placeholderData: keepPreviousData,
  });
  useKeepPageInRange(paging, purchases);
  const refreshing = purchases.isFetching && purchases.isPlaceholderData;

  const directory = useQuery({
    queryKey: ['users', 'directory'],
    queryFn: () => apiRequest<{ id: string; display_name: string; is_active: boolean }[]>('/users/directory'),
  });

  const selecting = usePrintSelection<PurchaseRow>(
    (row) => ({ kind: 'purchase', id: row.id }),
    (row) => row.id,
  );

  const { rate: globalRate } = useGlobalRate();
  const rows = purchases.data?.items ?? [];
  const totals = purchases.data?.totals;

  usePageTitle(t('purchases:title'));

  const newPurchase = (
    <Can permission="purchases.create">
      <Link to="/purchases/new" className="mz-button mz-button--primary">
        <Icon name="plus" />
        {t('purchases:new_purchase')}
      </Link>
    </Can>
  );

  return (
    <>
      <div className="mz-stack">
        <div className="mz-toolbar">
          <div className="mz-toolbar__filters">
            <div className="mz-toolbar__search">
              <TextField
                label={t('common:search')}
                placeholder={t('purchases:search_hint')}
                value={search}
                type="search"
                inputMode="search"
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <select
              className="mz-select"
              aria-label={t('common:date')}
              value={chip}
              onChange={(event) => setChip(event.target.value as DateChip)}
            >
              <option value="today">{t('common:today')}</option>
              <option value="week">{t('common:this_week')}</option>
              <option value="month">{t('common:this_month')}</option>
              <option value="all">{t('orders:any_date')}</option>
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
            <FilterChip active={voidedOnly} onClick={() => setVoidedOnly(!voidedOnly)}>
              {t('purchases:filter_voided')}
            </FilterChip>
          </div>
          {newPurchase}
        </div>

        {totals ? (
          <div className="mz-kpis mz-kpis--three">
            <div className="mz-kpi">
              <KpiHead icon="purchases" label={t('purchases:tile_purchases')} />
              <span className="mz-kpi__count" data-tabular>
                {formatter.number(totals.buys)}
              </span>
            </div>
            {totals.cost ? (
              <div className="mz-kpi">
                <KpiHead icon="chart" label={t('purchases:tile_bought')} />
                <DualAmount amount_iqd={totals.cost.total_iqd} amount_usd_cents={totals.cost.total_usd_cents} />
              </div>
            ) : null}
            {/* What we owe every company, whatever the filter: it opens the companies we owe. */}
            {totals.owed_by_us ? (
              <Link to="/customers?balance=we_owe" className="mz-kpi mz-kpi--button mz-card-link">
                <KpiHead icon="companies" label={t('purchases:tile_we_owe')} />
                <span className="mz-kpi__count" data-tabular>
                  {t('purchases:tile_we_owe_count', { count: totals.owed_by_us.companies })}
                </span>
                {/* The dinar companies in dinars and the dollar companies in dollars, each with the
                    other side at today's rate — never one sum of both (review, lesson 4). */}
                {owedFigures(totals.owed_by_us, globalRate).map((figure) => (
                  <span key={figure.primary} className="mz-owed">
                    <DualAmount {...figure} kind="derived" />
                  </span>
                ))}
              </Link>
            ) : null}
          </div>
        ) : null}

        <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          {selecting.active || rows.length > 0 ? <PrintSelectionBar state={selecting} /> : null}
          {!selecting.active && rows.length > 0 ? (
            <Button
              variant="secondary"
              icon="print"
              onClick={() =>
                print([{ kind: 'purchase_list', query: filterQuery, from: range.from ?? null, to: range.to ?? null }])
              }
            >
              {t('print:print_list')}
            </Button>
          ) : null}
        </div>

        <QueryStates
          query={purchases}
          isEmpty={rows.length === 0}
          emptyTitle={query.trim() ? t('purchases:empty_search', { query: query.trim() }) : t('purchases:empty')}
          emptyAction={newPurchase}
        >
          <div className="mz-refreshable" data-busy={refreshing ? 'true' : undefined} aria-busy={refreshing}>
            <PurchaseTable rows={rows} selection={selecting.selection} />
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

    </>
  );
}

/**
 * What we owe the companies, as figures to show: what the dinar companies are owed in dinars and
 * the dollar companies in dollars, each one only when there is any — and one zero when there is
 * nothing at all. Without a rate the other side is not invented.
 */
function owedFigures(
  owed: { owed_iqd: number; owed_usd_cents: number },
  rate: Rate | null,
): { amount_iqd: number; amount_usd_cents: number; primary: Currency }[] {
  const figure = (amount: number, primary: Currency) => ({
    ...(rate === null
      ? primary === 'IQD'
        ? { amount_iqd: amount, amount_usd_cents: 0 }
        : { amount_iqd: 0, amount_usd_cents: amount }
      : bothOf(amount, primary, rate)),
    primary,
  });
  const figures = [
    ...(owed.owed_iqd !== 0 ? [figure(owed.owed_iqd, 'IQD')] : []),
    ...(owed.owed_usd_cents !== 0 ? [figure(owed.owed_usd_cents, 'USD')] : []),
  ];
  return figures.length > 0 ? figures : [figure(0, 'IQD')];
}

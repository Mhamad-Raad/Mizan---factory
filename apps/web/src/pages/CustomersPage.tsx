import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Icon, TextField } from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { apiRequest } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { DataList } from '../components/DataList.js';
import { DualAmount } from '../components/DualAmount.js';
import { QueryStates } from '../components/states.js';
import { Pager } from '../components/Pager.js';
import { useKeepPageInRange, usePaging } from '../lib/paging.js';
import { useDebouncedValue } from '../lib/debounce.js';
import { FilterChip } from '../components/FilterChip.js';
import { DIRECTION_LABELS, customerName, directionOf } from '../lib/customers.js';
import { InactiveChip } from '../components/chips.js';
import { usePermission } from '../lib/store.js';

export interface BalanceValue {
  amount_iqd: number;
  amount_usd_cents: number;
  currency: Currency;
  kind: 'derived';
}

/** One account (D-054, D-055, D-062): a company that buys from us. */
export interface CustomerRow {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  settlement_currency: Currency;
  is_system: boolean;
  is_active: boolean;
  credit_limit: { amount_iqd: number; amount_usd_cents: number } | null;
  /** What they owe us; absent without `fields.see_customer_balances`. */
  balance?: BalanceValue | null;
  /** Their own IQD-per-USD rate, or the global one when they have none. */
  rate: { rate_iqd_per_usd: string; since: string | null; is_customer_rate: boolean } | null;
  version: number;
}

type BalanceFilter = 'all' | 'owes' | 'settled' | 'credit';

/**
 * The Companies page (D-054, D-055, FR-505): every company that buys from us.
 *
 * Buying stock is the factory's own business, never a company's (D-062), so a row carries one
 * balance — what the company owes us — labelled by which way it points: owing, settled, or in
 * credit when they have paid ahead.
 */
export function CustomersPage() {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  // The request waits for the typing to stop (NFR-03): one search, not one per letter.
  const query = useDebouncedValue(search);
  const [balance, setBalance] = useState<BalanceFilter>('all');
  const seesSelling = usePermission('fields.see_customer_balances');
  const seesBuying = usePermission('fields.see_company_balances');
  const seesNet = seesSelling && seesBuying;
  const [includeInactive, setIncludeInactive] = useState(false);
  const [sort, setSort] = useState<'name' | 'balance'>('name');

  const paging = usePaging({ storageKey: 'companies', resetOn: [query, balance, includeInactive, sort] });

  const customers = useQuery({
    queryKey: ['customers', query, balance, includeInactive, sort, paging.page, paging.pageSize],
    queryFn: () => {
      const search = new URLSearchParams({ q: query, include_inactive: String(includeInactive), sort });
      if (balance !== 'all') search.set('balance', balance);
      return apiRequest<{ items: CustomerRow[]; total: number }>(`/customers?${search.toString()}&${paging.query}`);
    },
    placeholderData: keepPreviousData,
  });
  useKeepPageInRange(paging, customers);
  const refreshing = customers.isFetching && customers.isPlaceholderData;

  const rows = customers.data?.items ?? [];

  usePageTitle(t('customers:title'));

  return (
    <div className="mz-stack">
      <div className="mz-toolbar">
        <div className="mz-toolbar__filters">
          <div className="mz-toolbar__search">
            <TextField
              label={t('common:search')}
              placeholder={t('customers:search_placeholder')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              type="search"
              inputMode="search"
            />
          </div>
          {/* The net balance needs both sides' flags (D-054); without them the server ignores
              this filter and sort, so they are not offered (review). */}
          {seesNet ? (
            <>
              <select
                className="mz-select"
                aria-label={t('customers:net_balance')}
                value={balance}
                onChange={(event) => setBalance(event.target.value as BalanceFilter)}
              >
                <option value="all">{t('customers:all_balances')}</option>
                <option value="owes">{t('customers:filter_owes')}</option>
                <option value="credit">{t('customers:filter_credit')}</option>
                <option value="settled">{t('customers:filter_settled')}</option>
              </select>
              <FilterChip active={sort === 'balance'} onClick={() => setSort(sort === 'balance' ? 'name' : 'balance')}>
                {t('customers:sort_by_balance')}
              </FilterChip>
            </>
          ) : null}
          <FilterChip active={includeInactive} onClick={() => setIncludeInactive(!includeInactive)}>
            {t('common:deactivated')}
          </FilterChip>
        </div>

        <NewPartyLink />
      </div>

      <QueryStates
        query={customers}
        isEmpty={rows.length === 0}
        emptyTitle={query ? t('customers:empty_search', { query }) : t('customers:empty')}
      >
        <div className="mz-refreshable" data-busy={refreshing ? 'true' : undefined} aria-busy={refreshing}>
          <DataList
            rows={rows}
            rowKey={(row) => row.id}
            href={(row) => `/customers/${row.id}`}
            columns={[
              {
                header: t('customers:name'),
                cell: (row) => (
                  <span className="mz-cell__body">
                    <strong>
                      <bdi>{customerName(row, t)}</bdi>
                    </strong>
                    <PartyCaption row={row} />
                  </span>
                ),
              },
              {
                header: t('customers:net_balance'),
                numeric: true,
                cell: (row) => <PartyBalance row={row} />,
              },
            ]}
            card={(row) => (
              <span className="mz-rowcard">
                <span className="mz-rowcard__head">
                  <span className="mz-list__title">
                    <bdi>{customerName(row, t)}</bdi>
                  </span>
                  <InactiveChip row={row} />
                </span>
                <PartyCaption row={row} />
                <span className="mz-rowcard__foot">
                  <PartyBalance row={row} />
                </span>
              </span>
            )}
          />
        </div>
        <Pager
          page={paging.page}
          pageSize={paging.pageSize}
          total={customers.data?.total ?? 0}
          onPage={paging.setPage}
          onPageSize={paging.setPageSize}
        />
      </QueryStates>
    </div>
  );
}

/** "New company", for whoever may create an account. */
function NewPartyLink() {
  const { t } = useTranslation();
  const mayCreateCustomer = usePermission('customers.create');
  const mayCreateCompany = usePermission('companies.create');
  if (!mayCreateCustomer && !mayCreateCompany) return null;
  return (
    <Link to="/customers/new" className="mz-button mz-button--primary mz-button--block">
      <Icon name="plus" />
      {t('customers:new_party')}
    </Link>
  );
}

/** The contact and the phone, as one quiet line. */
function PartyCaption({ row }: { row: CustomerRow }) {
  const parts = [row.contact_name, row.phone].filter((part): part is string => Boolean(part));
  if (parts.length === 0) return null;
  return (
    <span className="mz-caption">
      {parts.map((part, index) => (
        <span key={part}>
          {index > 0 ? ' · ' : ''}
          <bdi>{part}</bdi>
        </span>
      ))}
    </span>
  );
}


/** What the company owes us, labelled by which way it points. */
export function PartyBalance({ row }: { row: CustomerRow }) {
  const { t } = useTranslation();
  if (!row.balance) return <span className="mz-muted">—</span>;
  const direction = directionOf(row.balance);
  return (
    <span className="mz-cell__body">
      <span className={direction === 'owes' ? 'mz-caption mz-owed' : 'mz-caption'}>
        {t(DIRECTION_LABELS[direction])}
      </span>
      {/* The label says which way it points, so the amount reads as a size, never a sign. */}
      <DualAmount
        amount_iqd={Math.abs(row.balance.amount_iqd)}
        amount_usd_cents={Math.abs(row.balance.amount_usd_cents)}
        primary={row.balance.currency}
        kind="derived"
      />
    </span>
  );
}


import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Chip, Icon, TextField } from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { apiRequest } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { DataList } from '../components/DataList.js';
import { DualAmount } from '../components/DualAmount.js';
import { QueryStates } from '../components/states.js';
import { Pager } from '../components/Pager.js';
import { usePaging } from '../lib/paging.js';
import { FilterChip } from './MaterialsPage.js';
import { customerName } from '../lib/customers.js';
import { usePermission } from '../lib/store.js';

export interface BalanceValue {
  amount_iqd: number;
  amount_usd_cents: number;
  currency: Currency;
  kind: 'derived';
}

/** One account (D-054, D-055): a company we sell to and buy from. */
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
  /** What they owe us on the selling side; absent without `fields.see_customer_balances`. */
  balance?: BalanceValue | null;
  /** What we owe them on the buying side; absent without `fields.see_company_balances`. */
  payable?: BalanceValue | null;
  /** They owe us − we owe them; null unless the caller may see both sides. */
  net?: BalanceValue | null;
  /** Their own IQD-per-USD rate, or the global one when they have none. */
  rate: { rate_iqd_per_usd: string; since: string | null; is_customer_rate: boolean } | null;
  version: number;
}

type BalanceFilter = 'all' | 'owes' | 'settled' | 'credit';

/**
 * The Companies page (D-054, D-055, FR-505, FR-709): every account the factory deals with.
 *
 * A row carries the account's one balance — what it owes us less what we owe it — labelled by
 * which way it points. A caller who may see only one side sees that side's balance instead,
 * never a net they could work the other side out of.
 */
export function CustomersPage() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [balance, setBalance] = useState<BalanceFilter>('all');
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
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              type="search"
              inputMode="search"
            />
          </div>
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

/** "New company", for whoever may create an account on either side. */
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

/** A deactivated account says so wherever it is listed. */
export function InactiveChip({ row }: { row: Pick<CustomerRow, 'is_active'> }) {
  const { t } = useTranslation();
  if (row.is_active) return null;
  return (
    <span className="mz-rowcard__chips">
      <Chip icon="close">{t('common:deactivated')}</Chip>
    </span>
  );
}

/**
 * The one balance, labelled by which way it points. The net when the caller may see both sides;
 * otherwise the one side they may see, labelled as that side.
 */
export function PartyBalance({ row }: { row: CustomerRow }) {
  const { t } = useTranslation();
  const shown = balanceToShow(row);
  if (!shown) return <span className="mz-muted">—</span>;
  const direction = directionOf(shown);
  return (
    <span className="mz-cell__body">
      <span className={direction === 'they_owe_us' ? 'mz-caption mz-owed' : 'mz-caption'}>
        {t(`companies:${direction}`)}
      </span>
      {/* The label says which way it points, so the amount reads as a size, never a sign. */}
      <DualAmount
        amount_iqd={Math.abs(shown.value.amount_iqd)}
        amount_usd_cents={Math.abs(shown.value.amount_usd_cents)}
        primary={shown.value.currency}
        kind="derived"
      />
    </span>
  );
}

type Shown = { kind: 'net' | 'receivable' | 'payable'; value: BalanceValue };

/** Which way a balance points. The buying side's ledger counts what *we* owe as positive. */
export function directionOf(shown: Shown): 'they_owe_us' | 'we_owe_them' | 'settled' {
  const amount = shown.value.currency === 'IQD' ? shown.value.amount_iqd : shown.value.amount_usd_cents;
  if (amount === 0) return 'settled';
  const weOwe = shown.kind === 'payable' ? amount > 0 : amount < 0;
  return weOwe ? 'we_owe_them' : 'they_owe_us';
}

export function balanceToShow(row: CustomerRow): Shown | null {
  if (row.net) return { kind: 'net', value: row.net };
  if (row.balance) return { kind: 'receivable', value: row.balance };
  if (row.payable) return { kind: 'payable', value: row.payable };
  return null;
}

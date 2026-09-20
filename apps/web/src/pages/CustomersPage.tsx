import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Chip, TextField } from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { apiRequest } from '../lib/api.js';
import { AppShell } from '../components/AppShell.js';
import { Can } from '../components/Can.js';
import { DualAmount } from '../components/DualAmount.js';
import { QueryStates } from '../components/states.js';
import { FilterChip } from './MaterialsPage.js';
import { customerName } from '../lib/customers.js';

export interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  settlement_currency: Currency;
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  is_system: boolean;
  is_active: boolean;
  credit_limit: { amount_iqd: number; amount_usd_cents: number } | null;
  balance?: {
    amount_iqd: number;
    amount_usd_cents: number;
    currency: Currency;
    kind: 'derived';
  } | null;
  version: number;
}

/**
 * The Customers page (FR-505). Search finds a name typed on either keyboard and a phone
 * number however it was written; the balance appears only for those allowed to see it, and an
 * employee without "sees all customers" sees their own customers and the walk-in record.
 */
export function CustomersPage() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [balance, setBalance] = useState<'all' | 'owes' | 'settled' | 'credit'>('all');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [sort, setSort] = useState<'name' | 'balance'>('name');

  const customers = useQuery({
    queryKey: ['customers', query, balance, includeInactive, sort],
    queryFn: () => {
      const params = new URLSearchParams({ q: query, include_inactive: String(includeInactive), sort });
      if (balance !== 'all') params.set('balance', balance);
      return apiRequest<{ items: CustomerRow[]; total: number }>(`/customers?${params.toString()}`);
    },
  });

  const rows = customers.data?.items ?? [];

  return (
    <AppShell title={t('customers:title')}>
      <div className="mz-stack">
        <TextField
          label={t('common:search')}
          placeholder={t('customers:search_placeholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          type="search"
          inputMode="search"
        />

        <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <FilterChip active={balance === 'owes'} onClick={() => setBalance(balance === 'owes' ? 'all' : 'owes')}>
            {t('customers:filter_owes')}
          </FilterChip>
          <FilterChip active={balance === 'settled'} onClick={() => setBalance(balance === 'settled' ? 'all' : 'settled')}>
            {t('customers:filter_settled')}
          </FilterChip>
          <FilterChip active={balance === 'credit'} onClick={() => setBalance(balance === 'credit' ? 'all' : 'credit')}>
            {t('customers:filter_credit')}
          </FilterChip>
          <FilterChip active={sort === 'balance'} onClick={() => setSort(sort === 'balance' ? 'name' : 'balance')}>
            {t('customers:sort_by_balance')}
          </FilterChip>
          <FilterChip active={includeInactive} onClick={() => setIncludeInactive(!includeInactive)}>
            {t('common:deactivated')}
          </FilterChip>
        </div>

        <Can permission="customers.create">
          <Link to="/customers/new" className="mz-button mz-button--primary mz-button--block">
            {t('customers:new_customer')}
          </Link>
        </Can>

        <QueryStates
          query={customers}
          isEmpty={rows.length === 0}
          emptyTitle={query ? t('customers:empty_search', { query }) : t('customers:empty')}
        >
          <ul className="mz-list">
            {rows.map((customer) => (
              <li key={customer.id}>
                <Link to={`/customers/${customer.id}`} className="mz-list__item mz-list__item--interactive">
                  <span className="mz-list__body">
                    <span className="mz-list__title">{customerName(customer, t)}</span>
                    {customer.phone ? (
                      <span className="mz-caption" style={{ display: 'block' }} dir="ltr">
                        {customer.phone}
                      </span>
                    ) : null}
                    {customer.assigned_user_name ? (
                      <span className="mz-caption">
                        {t('glossary:assigned_to')}: {customer.assigned_user_name}
                      </span>
                    ) : null}
                  </span>
                  <span className="mz-list__end">
                    {customer.balance ? (
                      <DualAmount
                        amount_iqd={customer.balance.amount_iqd}
                        amount_usd_cents={customer.balance.amount_usd_cents}
                        primary={customer.balance.currency}
                        kind="derived"
                      />
                    ) : null}
                    {!customer.is_active ? <Chip icon="close">{t('common:deactivated')}</Chip> : null}
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

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
import { useFormatter } from '../lib/store.js';

export interface CompanyRow {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  settlement_currency: Currency;
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  is_active: boolean;
  rate: { rate_iqd_per_usd: string; since: string; is_company_rate: boolean } | null;
  /** Absent for a caller without `fields.see_company_balances` (FR-704). */
  balance?: {
    amount_iqd: number;
    amount_usd_cents: number;
    currency: Currency;
    kind: 'derived';
  } | null;
  version: number;
}

/**
 * The Companies page (FR-709, spec 3.3). Every user with `companies.view` sees every company —
 * the supplier side has no scope rule (FR-711) — and the balance appears only for those
 * allowed to see money. "Highest balance first" is the collections view an owner asks for.
 */
export function CompaniesPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [query, setQuery] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [sort, setSort] = useState<'name' | 'balance'>('name');

  const companies = useQuery({
    queryKey: ['companies', query, includeInactive, sort],
    queryFn: () => {
      const params = new URLSearchParams({ q: query, include_inactive: String(includeInactive), sort });
      return apiRequest<{ items: CompanyRow[]; total: number }>(`/companies?${params.toString()}`);
    },
  });

  const rows = companies.data?.items ?? [];

  return (
    <AppShell title={t('companies:title')}>
      <div className="mz-stack">
        <TextField
          label={t('common:search')}
          placeholder={t('companies:search_placeholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          type="search"
          inputMode="search"
        />

        <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <FilterChip active={sort === 'balance'} onClick={() => setSort(sort === 'balance' ? 'name' : 'balance')}>
            {t('companies:sort_by_balance')}
          </FilterChip>
          <FilterChip active={includeInactive} onClick={() => setIncludeInactive(!includeInactive)}>
            {t('common:deactivated')}
          </FilterChip>
        </div>

        <Can permission="companies.create">
          <Link to="/companies/new" className="mz-button mz-button--primary mz-button--block">
            {t('companies:new_company')}
          </Link>
        </Can>

        <QueryStates
          query={companies}
          isEmpty={rows.length === 0}
          emptyTitle={query ? t('companies:empty_search', { query }) : t('companies:empty')}
        >
          <ul className="mz-list">
            {rows.map((company) => (
              <li key={company.id}>
                <Link to={`/companies/${company.id}`} className="mz-list__item mz-list__item--interactive">
                  <span className="mz-list__body">
                    <span className="mz-list__title">{company.name}</span>
                    {company.phone ? (
                      <span className="mz-caption" style={{ display: 'block' }} dir="ltr">
                        {company.phone}
                      </span>
                    ) : null}
                    <span className="mz-caption" style={{ display: 'block' }}>
                      {t('glossary:settlement_currency')}: {t(`glossary:${company.settlement_currency.toLowerCase()}`)}
                      {company.rate
                        ? ` · ${formatter.rate(company.rate.rate_iqd_per_usd)}${
                            company.rate.is_company_rate ? '' : ` (${t('companies:rate_is_global')})`
                          }`
                        : ''}
                    </span>
                    {company.assigned_user_name ? (
                      <span className="mz-caption">
                        {t('glossary:assigned_to')}: {company.assigned_user_name}
                      </span>
                    ) : null}
                  </span>
                  <span className="mz-list__end">
                    {company.balance ? (
                      <>
                        <span className="mz-caption" style={{ display: 'block' }}>
                          {company.balance.amount_iqd >= 0
                            ? t('companies:we_owe_them')
                            : t('companies:they_owe_us')}
                        </span>
                        <DualAmount
                          amount_iqd={company.balance.amount_iqd}
                          amount_usd_cents={company.balance.amount_usd_cents}
                          primary={company.balance.currency}
                          kind="derived"
                        />
                      </>
                    ) : null}
                    {!company.is_active ? <Chip icon="close">{t('common:deactivated')}</Chip> : null}
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

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BottomSheet,
  Button,
  Card,
  Chip,
  DateField,
  Icon,
  NumberField,
  SegmentedControl,
  TextField,
  Toast,
} from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { ApiError, apiRequest, newIdempotencyKey } from '../lib/api.js';
import { AppShell } from '../components/AppShell.js';
import { Can } from '../components/Can.js';
import { DualAmount } from '../components/DualAmount.js';
import { LedgerList } from '../components/LedgerList.js';
import type { LedgerRow } from '../components/LedgerList.js';
import { MoneyInput } from '../components/MoneyInput.js';
import type { MoneyValue } from '../components/MoneyInput.js';
import { PaymentSheet } from '../components/PaymentSheet.js';
import { ShareDocumentSheet } from '../components/ShareDocumentSheet.js';
import { QueryStates } from '../components/states.js';
import { FilterChip } from './MaterialsPage.js';
import { useApp, useFormatter, usePermission } from '../lib/store.js';
import type { CompanyRow } from './CompaniesPage.js';
import type { PurchaseRow } from './PurchasesPage.js';

type Tab = 'overview' | 'accounting' | 'purchases' | 'history';
type Sheet = 'payment' | 'adjustment' | 'credit' | 'opening' | 'rate' | 'rate_history' | 'currency' | 'assign';
type EntryFilter = 'all' | 'payments' | 'adjustments' | 'credits' | 'purchases';

interface Allocation {
  purchases: { purchase_id: string; total: number; linked: number; allocated: number; remaining: number }[];
  general: number;
  balance: number;
}

interface Breakdown {
  settlement_currency: Currency;
  allocation: Allocation;
  purchases: { id: string; number: number; purchase_date: string; status: string }[];
  settled_count: number;
  owing_count: number;
  owing_total: number;
}

/**
 * The company profile and its accounting (FR-703 to FR-712, spec 3.3).
 *
 * The header card carries what an accountant looks for first: the rate this company's amounts
 * are filled at and since when, and the balance in both currencies with ≈ on the converted
 * side. Then the ledger with its running balance, the per-purchase view that needs nothing
 * linked (FR-712), the purchases themselves, and History.
 */
export function CompanyDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const formatter = useFormatter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const maySeeBalance = usePermission('fields.see_company_balances');
  const mayRecordPayment = usePermission('companies.record_payment');
  const mayAdjust = usePermission('companies.adjust_owed');
  const mayCredit = usePermission('companies.record_credit');
  const mayOpening = usePermission('companies.opening_balance');
  const maySetRate = usePermission('companies.set_rate');
  const isAdmin = useApp((state) => state.user?.role === 'admin');

  const [tab, setTab] = useState<Tab>('overview');
  /** The accounting tab asks for a page of the ledger, not an account's whole life (I2 review). */
  const [ledgerLimit, setLedgerLimit] = useState(100);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [entryFilter, setEntryFilter] = useState<EntryFilter>('all');
  const [statement, setStatement] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const company = useQuery({
    queryKey: ['companies', id],
    queryFn: () => apiRequest<CompanyRow>(`/companies/${id}`),
  });

  const ledger = useQuery({
    queryKey: ['companies', id, 'ledger', ledgerLimit],
    queryFn: () =>
      apiRequest<{
        company: { settlement_currency: Currency };
        balance: number;
        items: LedgerRow[];
        total: number;
        has_more: boolean;
      }>(`/companies/${id}/ledger?limit=${ledgerLimit}`),
    enabled: maySeeBalance && (tab === 'accounting' || tab === 'overview'),
  });

  const breakdown = useQuery({
    queryKey: ['companies', id, 'breakdown'],
    queryFn: () =>
      apiRequest<Breakdown>(`/companies/${id}/purchase-breakdown`),
    // The purchases tab needs it too: a purchase's remaining is its oldest-first share, not a
    // sum of what happens to name it (FR-712).
    enabled: maySeeBalance && (tab === 'accounting' || tab === 'purchases' || tab === 'overview' || sheet === 'payment'),
  });

  const purchases = useQuery({
    queryKey: ['companies', id, 'purchases'],
    queryFn: () => apiRequest<{ items: PurchaseRow[]; total: number }>(`/companies/${id}/purchases`),
    enabled: tab === 'purchases' || tab === 'overview',
  });

  const rates = useQuery({
    queryKey: ['companies', id, 'rates'],
    queryFn: () =>
      apiRequest<{
        items: { id: string; rate_iqd_per_usd: string; effective_from: string; note: string | null; created_by_name: string | null }[];
      }>(`/companies/${id}/rates`),
    enabled: sheet === 'rate_history',
  });

  const history = useQuery({
    queryKey: ['companies', id, 'history'],
    queryFn: () =>
      apiRequest<{
        items: { id: string; action: string; occurred_at: string; actor_display_name: string | null; note: string | null }[];
      }>(`/companies/${id}/history`),
    enabled: tab === 'history',
  });

  const statementData = useQuery({
    queryKey: ['companies', id, 'statement'],
    queryFn: () =>
      apiRequest<{
        company: { name: string; settlement_currency: Currency };
        from: string | null;
        to: string | null;
        opening_balance: number;
        closing_balance: number;
        items: LedgerRow[];
      }>(`/companies/${id}/statement`),
    enabled: statement,
  });

  const directory = useQuery({
    queryKey: ['users', 'directory'],
    queryFn: () => apiRequest<{ id: string; display_name: string; is_active: boolean }[]>('/users/directory'),
    enabled: sheet === 'assign',
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['companies'] });
    await queryClient.invalidateQueries({ queryKey: ['purchases'] });
  };

  const payment = useMutation({
    mutationFn: (body: unknown) =>
      apiRequest(`/companies/${id}/payments`, { method: 'POST', body, idempotencyKey: newIdempotencyKey() }),
    onSuccess: async () => {
      setSheet(null);
      setToast(t('companies:payment_recorded'));
      await invalidate();
    },
  });

  const entry = useMutation({
    mutationFn: (input: { path: string; body: unknown }) =>
      apiRequest(`/companies/${id}/${input.path}`, {
        method: 'POST',
        body: input.body,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      setSheet(null);
      setToast(t('companies:entry_recorded'));
      await invalidate();
    },
  });

  const setRate = useMutation({
    mutationFn: (body: unknown) =>
      apiRequest(`/companies/${id}/rates`, { method: 'POST', body, idempotencyKey: newIdempotencyKey() }),
    onSuccess: async () => {
      setSheet(null);
      setToast(t('companies:rate_saved'));
      await invalidate();
    },
  });

  const setCurrency = useMutation({
    mutationFn: (body: unknown) =>
      apiRequest(`/companies/${id}/settlement-currency`, {
        method: 'PUT',
        body,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      setSheet(null);
      await invalidate();
    },
  });

  const assign = useMutation({
    mutationFn: (userId: string | null) =>
      apiRequest(`/companies/${id}/assignment`, {
        method: 'PUT',
        body: { user_id: userId },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      setSheet(null);
      await invalidate();
    },
  });

  const balance = company.data?.balance ?? null;
  const settlement = company.data?.settlement_currency ?? 'IQD';
  const companyRate = company.data?.rate?.rate_iqd_per_usd ?? '1310.0000';
  const owed = balance ? (settlement === 'IQD' ? balance.amount_iqd : balance.amount_usd_cents) : 0;
  const allocation = breakdown.data?.allocation ?? null;
  const purchaseNumbers = new Map(
    (breakdown.data?.purchases ?? []).map((purchase) => [purchase.id, purchase.number]),
  );

  const ledgerRows = (ledger.data?.items ?? []).filter((row) => {
    if (entryFilter === 'all') return true;
    if (entryFilter === 'payments') return row.entry_type === 'payment';
    if (entryFilter === 'adjustments') return row.entry_type === 'adjustment';
    if (entryFilter === 'credits') return row.entry_type === 'credit';
    return row.entry_type === 'purchase';
  });

  return (
    <AppShell title={company.data?.name ?? t('companies:title')}>
      <div className="mz-stack">
        <QueryStates query={company}>
          {company.data ? (
            <>
              <Card>
                <div className="mz-row mz-row--between">
                  <div>
                    <h2 className="mz-title">{company.data.name}</h2>
                    {company.data.contact_name ? (
                      <span className="mz-caption" style={{ display: 'block' }}>
                        {company.data.contact_name}
                      </span>
                    ) : null}
                    {company.data.phone ? (
                      <a href={`tel:${company.data.phone}`} className="mz-caption" dir="ltr">
                        {company.data.phone}
                      </a>
                    ) : null}
                    {company.data.assigned_user_name ? (
                      <span className="mz-caption" style={{ display: 'block' }}>
                        {t('glossary:assigned_to')}: {company.data.assigned_user_name}
                      </span>
                    ) : null}
                  </div>
                  {!company.data.is_active ? <Chip icon="close">{t('common:deactivated')}</Chip> : null}
                </div>

                <div className="mz-row mz-row--between" style={{ marginBlockStart: 'var(--space-3)' }}>
                  <span className="mz-caption">{t('glossary:settlement_currency')}</span>
                  <span>{t(`glossary:${settlement.toLowerCase()}`)}</span>
                </div>

                {/* The rate every calculated amount for this company is filled at (2.3.3). */}
                <div className="mz-row mz-row--between">
                  <span className="mz-caption">
                    {company.data.rate?.is_company_rate ? t('glossary:company_rate') : t('companies:rate_is_global')}
                  </span>
                  <span>
                    <span data-tabular>{formatter.rate(companyRate)}</span>
                    {company.data.rate ? (
                      <span className="mz-caption">
                        {' '}
                        {t('companies:rate_since', { date: formatter.date(company.data.rate.since.slice(0, 10)) })}
                      </span>
                    ) : null}
                  </span>
                </div>

                {balance ? (
                  <div style={{ marginBlockStart: 'var(--space-3)' }}>
                    <span className="mz-caption" style={{ display: 'block' }}>
                      {owed >= 0 ? t('companies:we_owe_them') : t('companies:they_owe_us')}
                    </span>
                    <DualAmount
                      amount_iqd={balance.amount_iqd}
                      amount_usd_cents={balance.amount_usd_cents}
                      primary={balance.currency}
                      kind="derived"
                      size="large"
                    />
                  </div>
                ) : null}
              </Card>

              <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                {mayRecordPayment ? (
                  <Button onClick={() => setSheet('payment')}>{t('companies:record_payment')}</Button>
                ) : null}
                {mayAdjust ? (
                  <Button variant="secondary" onClick={() => setSheet('adjustment')}>
                    {t('companies:adjust_owed')}
                  </Button>
                ) : null}
                {mayCredit ? (
                  <Button variant="secondary" onClick={() => setSheet('credit')}>
                    {t('glossary:credit')}
                  </Button>
                ) : null}
                {mayOpening ? (
                  <Button variant="secondary" onClick={() => setSheet('opening')}>
                    {t('glossary:opening_balance')}
                  </Button>
                ) : null}
                {maySetRate ? (
                  <Button variant="secondary" onClick={() => setSheet('rate')}>
                    {t('companies:set_rate')}
                  </Button>
                ) : null}
                <Button variant="ghost" onClick={() => setSheet('rate_history')}>
                  {t('companies:rate_history')}
                </Button>
                <Can permission="companies.assign">
                  <Button variant="secondary" onClick={() => setSheet('assign')}>
                    {t('companies:assign')}
                  </Button>
                </Can>
                {isAdmin ? (
                  <Button variant="ghost" onClick={() => setSheet('currency')}>
                    {t('companies:settlement_currency_change')}
                  </Button>
                ) : null}
                {maySeeBalance ? (
                  <Button variant="ghost" onClick={() => setStatement(true)}>
                    {t('glossary:statement')}
                  </Button>
                ) : null}
              </div>

              <SegmentedControl
                label={t('common:more')}
                value={tab}
                onChange={setTab}
                options={[
                  { value: 'overview', label: t('companies:tab_overview') },
                  ...(maySeeBalance ? [{ value: 'accounting' as Tab, label: t('companies:tab_accounting') }] : []),
                  { value: 'purchases', label: t('companies:tab_purchases') },
                  { value: 'history', label: t('glossary:history') },
                ]}
              />

              {tab === 'overview' ? (
                <Card>
                  <h3 className="mz-heading">{t('companies:tab_purchases')}</h3>
                  <QueryStates
                    query={purchases}
                    isEmpty={(purchases.data?.items.length ?? 0) === 0}
                    emptyTitle={t('companies:no_purchases')}
                    emptyAction={
                      <Can permission="purchases.create">
                        <Link to={`/purchases/new?company=${id}`} className="mz-button mz-button--primary">
                          {t('purchases:add_material')}
                        </Link>
                      </Can>
                    }
                    skeletonLines={3}
                  >
                    <ul className="mz-list">
                      {(purchases.data?.items ?? []).slice(0, 5).map((purchase) => (
                        <PurchaseListItem
                          key={purchase.id}
                          purchase={purchase}
                          settlement={settlement}
                          remaining={remainingOf(allocation, purchase.id)}
                        />
                      ))}
                    </ul>
                  </QueryStates>
                </Card>
              ) : null}

              {tab === 'accounting' ? (
                <>
                  <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                    {(['payments', 'adjustments', 'credits', 'purchases'] as EntryFilter[]).map((filter) => (
                      <FilterChip
                        key={filter}
                        active={entryFilter === filter}
                        onClick={() => setEntryFilter(entryFilter === filter ? 'all' : filter)}
                      >
                        {t(`companies:entry.${singularOf(filter)}`)}
                      </FilterChip>
                    ))}
                  </div>

                  <QueryStates
                    query={ledger}
                    isEmpty={ledgerRows.length === 0}
                    emptyTitle={t('companies:no_entries')}
                  >
                    <Card>
                      <LedgerList
                        items={ledgerRows}
                        settlement_currency={ledger.data?.company.settlement_currency ?? settlement}
                        namespace="companies"
                      />
                      {ledger.data?.has_more ? (
                        <div className="mz-stack" style={{ marginBlockStart: 'var(--space-3)' }}>
                          <span className="mz-caption">
                            {t('companies:more_entries', {
                              shown: formatter.number(ledger.data.items.length),
                              total: formatter.number(ledger.data.total),
                            })}
                          </span>
                          <Button variant="secondary" onClick={() => setLedgerLimit(ledgerLimit + 100)}>
                            {t('companies:show_more')}
                          </Button>
                        </div>
                      ) : null}
                    </Card>
                  </QueryStates>

                  {/* FR-712: what we owe per purchase, with nothing linked by hand. */}
                  {allocation ? (
                    <Card>
                      <h3 className="mz-heading">{t('companies:per_purchase')}</h3>
                      <p className="mz-caption">{t('companies:per_purchase_hint')}</p>
                      <ul className="mz-list">
                        {allocation.purchases
                          .filter((row) => row.remaining !== 0)
                          .map((row) => (
                            <li key={row.purchase_id}>
                              <Link
                                to={`/purchases/${row.purchase_id}`}
                                className="mz-list__item mz-list__item--interactive"
                              >
                                <span className="mz-list__body">
                                  <span className="mz-list__title">
                                    {t('purchases:number', {
                                      number: formatter.number(purchaseNumbers.get(row.purchase_id) ?? 0),
                                    })}
                                  </span>
                                </span>
                                <span className="mz-list__end" data-tabular>
                                  {formatter.money(row.remaining, settlement)}
                                </span>
                              </Link>
                            </li>
                          ))}
                        {breakdown.data && breakdown.data.owing_count > allocation.purchases.length ? (
                          <li className="mz-list__item">
                            <span className="mz-list__body">
                              <span className="mz-caption">
                                {t('companies:more_entries', {
                                  shown: formatter.number(allocation.purchases.length),
                                  total: formatter.number(breakdown.data.owing_count),
                                })}
                              </span>
                            </span>
                            <span className="mz-list__end" data-tabular>
                              {formatter.money(breakdown.data.owing_total, settlement)}
                            </span>
                          </li>
                        ) : null}
                        {allocation.general !== 0 ? (
                          <li className="mz-list__item">
                            <span className="mz-list__body">
                              <span className="mz-list__title">{t('companies:general_bucket')}</span>
                            </span>
                            <span className="mz-list__end" data-tabular>
                              {formatter.money(allocation.general, settlement)}
                            </span>
                          </li>
                        ) : null}
                      </ul>
                    </Card>
                  ) : null}
                </>
              ) : null}

              {tab === 'purchases' ? (
                <QueryStates
                  query={purchases}
                  isEmpty={(purchases.data?.items.length ?? 0) === 0}
                  emptyTitle={t('companies:no_purchases')}
                  emptyAction={
                    <Can permission="purchases.create">
                      <Link to={`/purchases/new?company=${id}`} className="mz-button mz-button--primary">
                        {t('purchases:add_material')}
                      </Link>
                    </Can>
                  }
                >
                  <ul className="mz-list">
                    {(purchases.data?.items ?? []).map((purchase) => (
                      <PurchaseListItem
                        key={purchase.id}
                        purchase={purchase}
                        settlement={settlement}
                        remaining={remainingOf(allocation, purchase.id)}
                      />
                    ))}
                  </ul>
                </QueryStates>
              ) : null}

              {tab === 'history' ? (
                <QueryStates
                  query={history}
                  isEmpty={(history.data?.items.length ?? 0) === 0}
                  emptyTitle={t('history:empty')}
                >
                  <Card>
                    <ul className="mz-list">
                      {(history.data?.items ?? []).map((row) => (
                        <li key={row.id} className="mz-list__item">
                          <span className="mz-list__body">
                            <span className="mz-list__title">{t(`history:action.${row.action}`)}</span>
                            <span className="mz-caption">
                              {formatter.timestamp(new Date(row.occurred_at))}
                              {row.actor_display_name ? ` · ${row.actor_display_name}` : ''}
                              {row.note ? ` · ${row.note}` : ''}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                </QueryStates>
              ) : null}
            </>
          ) : null}
        </QueryStates>

        {sheet === 'payment' && company.data ? (
          <PaymentSheet
            open
            title={t('companies:sheet.payment')}
            amountLabel={t('companies:amount_paid')}
            remainingLabel={t('companies:we_owe_them')}
            saveLabel={t('companies:record_payment')}
            remainingHint={t('companies:settle_in_full_hint')}
            remaining={Math.max(owed, 0)}
            settlement_currency={settlement}
            rate={companyRate}
            saving={payment.isPending}
            purchases={(allocation?.purchases ?? [])
              .filter((row) => row.remaining > 0)
              .map((row) => ({
                id: row.purchase_id,
                label: `${t('purchases:number', {
                  number: formatter.number(purchaseNumbers.get(row.purchase_id) ?? 0),
                })} · ${formatter.money(row.remaining, settlement)}`,
              }))}
            error={
              payment.error instanceof ApiError
                ? t(payment.error.messageKey, { defaultValue: t('errors:VALIDATION_FAILED') })
                : undefined
            }
            onClose={() => setSheet(null)}
            onSave={(body) => payment.mutate(body)}
          />
        ) : null}

        {sheet === 'adjustment' ? (
          <AdjustOwedSheet
            balance={owed}
            settlement_currency={settlement}
            rate={companyRate}
            saving={entry.isPending}
            error={entry.error instanceof ApiError ? t(entry.error.messageKey, { defaultValue: t('errors:VALIDATION_FAILED') }) : undefined}
            onClose={() => setSheet(null)}
            onSave={(body) => entry.mutate({ path: 'adjustments', body })}
          />
        ) : null}

        {sheet === 'credit' || sheet === 'opening' ? (
          <CompanyEntrySheet
            kind={sheet}
            rate={companyRate}
            saving={entry.isPending}
            error={entry.error instanceof ApiError ? t(entry.error.messageKey, { defaultValue: t('errors:VALIDATION_FAILED') }) : undefined}
            onClose={() => setSheet(null)}
            onSave={(body) =>
              entry.mutate({ path: sheet === 'credit' ? 'credits' : 'opening-balance', body })
            }
          />
        ) : null}

        {sheet === 'rate' ? (
          <SetRateSheet
            current={company.data?.rate ?? null}
            saving={setRate.isPending}
            guard={setRate.error instanceof ApiError && setRate.error.code === 'RATE_GUARD' ? setRate.error.params : null}
            onClose={() => setSheet(null)}
            onSave={(body) => setRate.mutate(body)}
          />
        ) : null}

        {sheet === 'rate_history' ? (
          <BottomSheet
            title={t('companies:rate_history')}
            open
            onClose={() => setSheet(null)}
            closeLabel={t('common:close')}
          >
            <QueryStates query={rates} isEmpty={(rates.data?.items.length ?? 0) === 0} emptyTitle={t('companies:rate_is_global')}>
              <ul className="mz-list">
                {(rates.data?.items ?? []).map((row) => (
                  <li key={row.id} className="mz-list__item">
                    <span className="mz-list__body">
                      <span className="mz-list__title" data-tabular>
                        {formatter.rate(row.rate_iqd_per_usd)}
                      </span>
                      <span className="mz-caption">
                        {t('companies:rate_since', { date: formatter.date(row.effective_from.slice(0, 10)) })}
                        {row.created_by_name ? ` · ${row.created_by_name}` : ''}
                        {row.note ? ` · ${row.note}` : ''}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </QueryStates>
          </BottomSheet>
        ) : null}

        {sheet === 'currency' && company.data ? (
          <SettlementCurrencySheet
            current={settlement}
            balance={owed}
            rate={companyRate}
            saving={setCurrency.isPending}
            error={
              setCurrency.error instanceof ApiError
                ? t(setCurrency.error.messageKey, { defaultValue: t('errors:VALIDATION_FAILED') })
                : undefined
            }
            onClose={() => setSheet(null)}
            onSave={(body) => setCurrency.mutate(body)}
          />
        ) : null}

        {sheet === 'assign' ? (
          <BottomSheet title={t('companies:assign')} open onClose={() => setSheet(null)} closeLabel={t('common:close')}>
            <ul className="mz-list">
              <li>
                <button type="button" className="mz-list__item mz-list__item--interactive" onClick={() => assign.mutate(null)}>
                  {t('companies:unassigned')}
                </button>
              </li>
              {(directory.data ?? [])
                .filter((user) => user.is_active)
                .map((user) => (
                  <li key={user.id}>
                    <button
                      type="button"
                      className="mz-list__item mz-list__item--interactive"
                      onClick={() => assign.mutate(user.id)}
                    >
                      {user.display_name}
                    </button>
                  </li>
                ))}
            </ul>
          </BottomSheet>
        ) : null}

        {statement && statementData.data ? (
          <ShareDocumentSheet
            title={t('glossary:statement')}
            open
            onClose={() => setStatement(false)}
            text={`${statementData.data.company.name}: ${formatter.money(
              statementData.data.closing_balance,
              statementData.data.company.settlement_currency,
            )}`}
          >
            <div className="mz-receipt">
              <strong>{statementData.data.company.name}</strong>
              {/* A statement is a document for a period, so it says which one (D-025). */}
              <span className="mz-caption">
                {t('companies:statement_range', {
                  from: statementData.data.from ? formatter.date(statementData.data.from) : '—',
                  to: formatter.date(statementData.data.to ?? formatter.today()),
                })}
              </span>
              <div className="mz-receipt__line">
                <span>{t('glossary:opening_balance')}</span>
                <span data-tabular>
                  {formatter.money(statementData.data.opening_balance, statementData.data.company.settlement_currency)}
                </span>
              </div>
              {statementData.data.items.map((row) => (
                <div key={row.entry_id} className="mz-receipt__line">
                  <span>
                    {formatter.date(row.entry_date)} · {t(`companies:entry.${row.entry_type}`)}
                  </span>
                  <span data-tabular>
                    {formatter.money(
                      statementData.data.company.settlement_currency === 'IQD' ? row.amount_iqd : row.amount_usd_cents,
                      statementData.data.company.settlement_currency,
                    )}
                  </span>
                </div>
              ))}
              <div className="mz-receipt__line">
                <strong>{t('glossary:balance')}</strong>
                <strong data-tabular>
                  {formatter.money(statementData.data.closing_balance, statementData.data.company.settlement_currency)}
                </strong>
              </div>
            </div>
          </ShareDocumentSheet>
        ) : null}

        {toast ? <Toast message={toast} actionLabel={t('common:close')} onAction={() => setToast(null)} /> : null}
        <Button variant="ghost" onClick={() => navigate('/companies')}>
          {t('common:back')}
        </Button>
      </div>
    </AppShell>
  );
}

function singularOf(filter: EntryFilter): string {
  if (filter === 'payments') return 'payment';
  if (filter === 'adjustments') return 'adjustment';
  if (filter === 'credits') return 'credit';
  return 'purchase';
}

/** The purchase's oldest-first remaining, or null when the caller may not see money. */
function remainingOf(allocation: Allocation | null, purchaseId: string): number | null {
  if (!allocation) return null;
  return allocation.purchases.find((row) => row.purchase_id === purchaseId)?.remaining ?? null;
}

function PurchaseListItem({
  purchase,
  settlement,
  remaining,
}: {
  purchase: PurchaseRow;
  settlement: Currency;
  remaining: number | null;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  return (
    <li>
      <Link to={`/purchases/${purchase.id}`} className="mz-list__item mz-list__item--interactive">
        <span className="mz-list__body">
          <span className="mz-list__title">
            {t('purchases:number', { number: formatter.number(purchase.number) })}
          </span>
          <span className="mz-caption" style={{ display: 'block' }}>
            {formatter.date(purchase.purchase_date)}
          </span>
          {purchase.cost ? (
            <DualAmount
              amount_iqd={purchase.cost.total_iqd}
              amount_usd_cents={purchase.cost.total_usd_cents}
              primary={settlement}
            />
          ) : null}
        </span>
        <span className="mz-list__end">
          {purchase.doc_status === 'void' ? <Chip tone="danger" icon="close">{t('glossary:void')}</Chip> : null}
          {remaining !== null && remaining > 0 ? (
            <span className="mz-caption" data-tabular>
              {t('glossary:remaining')}: {formatter.money(remaining, settlement)}
            </span>
          ) : null}
        </span>
      </Link>
    </li>
  );
}

/**
 * "Change how much we owe" (FR-706): the accountant types the **new balance** or the change,
 * never both, and sees what it will become before saving. A note is required, because this is
 * somebody deciding a figure by hand.
 */
function AdjustOwedSheet({
  balance,
  settlement_currency,
  rate,
  saving,
  error,
  onClose,
  onSave,
}: {
  balance: number;
  settlement_currency: Currency;
  rate: string;
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (body: unknown) => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [mode, setMode] = useState<'new_balance' | 'delta'>('delta');
  const [amount, setAmount] = useState<MoneyValue>({ amount: null, currency: settlement_currency, other_amount: null });
  const [date, setDate] = useState(formatter.today());
  const [note, setNote] = useState('');

  const typed = amount.amount;
  const after = typed === null ? balance : mode === 'new_balance' ? typed : balance + typed;

  return (
    <BottomSheet title={t('companies:sheet.adjustment')} open onClose={onClose} closeLabel={t('common:close')}>
      <div className="mz-stack">
        <SegmentedControl
          label={t('companies:adjust_mode_hint')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'delta', label: t('companies:adjust_delta') },
            { value: 'new_balance', label: t('companies:adjust_new_balance') },
          ]}
        />

        <MoneyInput
          label={mode === 'new_balance' ? t('companies:adjust_new_balance') : t('companies:adjust_delta')}
          value={amount}
          rate={rate}
          onChange={setAmount}
          error={error}
        />

        <div className="mz-row mz-row--between">
          <span className="mz-caption">{t('companies:adjust_before')}</span>
          <span data-tabular>{formatter.money(balance, settlement_currency)}</span>
        </div>
        <div className="mz-row mz-row--between">
          <span className="mz-caption">{t('companies:adjust_after')}</span>
          <span data-tabular>{formatter.money(after, settlement_currency)}</span>
        </div>

        <DateField
          label={t('common:date')}
          value={date}
          max={formatter.today()}
          onChange={(event) => setDate(event.target.value)}
        />
        <TextField
          label={t('common:note')}
          value={note}
          hint={t('companies:note_required')}
          onChange={(event) => setNote(event.target.value)}
        />

        <Button
          block
          loading={saving}
          disabled={typed === null || note.trim().length < 3}
          onClick={() =>
            onSave({
              ...(mode === 'new_balance' ? { new_balance: typed } : { delta: typed }),
              currency: amount.currency,
              other_amount: amount.other_amount ?? null,
              entry_date: date,
              note: note.trim(),
            })
          }
        >
          {t('common:save')}
        </Button>
      </div>
    </BottomSheet>
  );
}

/** A credit for goods returned (FR-707) and the opening debt at go-live (FR-708). */
function CompanyEntrySheet({
  kind,
  rate,
  saving,
  error,
  onClose,
  onSave,
}: {
  kind: 'credit' | 'opening';
  rate: string;
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (body: unknown) => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [amount, setAmount] = useState<MoneyValue>({ amount: null, currency: 'IQD', other_amount: null });
  const [date, setDate] = useState(formatter.today());
  const [note, setNote] = useState('');

  return (
    <BottomSheet title={t(`companies:sheet.${kind}`)} open onClose={onClose} closeLabel={t('common:close')}>
      <div className="mz-stack">
        <MoneyInput label={t('companies:amount')} value={amount} rate={rate} onChange={setAmount} error={error} />
        <DateField
          label={t('common:date')}
          value={date}
          max={formatter.today()}
          onChange={(event) => setDate(event.target.value)}
        />
        <TextField
          label={t('common:note')}
          value={note}
          hint={t('companies:note_required')}
          onChange={(event) => setNote(event.target.value)}
        />
        <Button
          block
          loading={saving}
          disabled={amount.amount === null || note.trim() === ''}
          onClick={() =>
            onSave({
              amount: amount.amount,
              currency: amount.currency,
              other_amount: amount.other_amount ?? null,
              entry_date: date,
              note: note.trim(),
            })
          }
        >
          {t('common:save')}
        </Button>
      </div>
    </BottomSheet>
  );
}

/**
 * The company's own rate (FR-703). It applies from now on; every stored entry keeps the rate
 * it was written with, which the sheet says in so many words. A change beyond the guard asks
 * for a confirmation instead of refusing.
 */
function SetRateSheet({
  current,
  saving,
  guard,
  onClose,
  onSave,
}: {
  current: { rate_iqd_per_usd: string; is_company_rate: boolean } | null;
  saving: boolean;
  guard: Record<string, unknown> | null;
  onClose: () => void;
  onSave: (body: unknown) => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [rate, setRate] = useState(current?.is_company_rate ? current.rate_iqd_per_usd : '');
  const [note, setNote] = useState('');

  return (
    <BottomSheet title={t('companies:set_rate')} open onClose={onClose} closeLabel={t('common:close')}>
      <div className="mz-stack">
        <NumberField
          label={t('glossary:company_rate')}
          decimals={4}
          value={rate}
          onChange={(event) => setRate(event.target.value)}
        />
        <p className="mz-caption">{t('companies:rate_applies_to_new')}</p>
        <TextField
          label={t('common:note')}
          hint={t('common:optional')}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />

        {guard ? (
          <div className="mz-warning" role="alert">
            {t('companies:rate_guard', {
              percent: formatter.number(Number(guard.percent ?? 0)),
              previous: formatter.rate(String(guard.previous ?? '')),
            })}
          </div>
        ) : null}

        <Button
          block
          loading={saving}
          disabled={rate.trim() === ''}
          onClick={() =>
            onSave({
              rate_iqd_per_usd: rate.trim(),
              note: note.trim() === '' ? null : note.trim(),
              // The second tap is the confirmation the guard asked for (FR-703).
              confirm: guard ? true : undefined,
            })
          }
        >
          {guard ? t('glossary:confirm') : t('common:save')}
        </Button>
      </div>
    </BottomSheet>
  );
}

/**
 * Changing the settlement currency (FR-702, 2.3.5): with money on the account it needs the
 * rate the balance is carried over at, and it writes one marker entry — no stored amount is
 * ever recalculated.
 */
function SettlementCurrencySheet({
  current,
  balance,
  rate,
  saving,
  error,
  onClose,
  onSave,
}: {
  current: Currency;
  balance: number;
  rate: string;
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (body: unknown) => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const target: Currency = current === 'IQD' ? 'USD' : 'IQD';
  const [rebaseRate, setRebaseRate] = useState(rate);
  const [note, setNote] = useState('');

  return (
    <BottomSheet
      title={t('companies:settlement_currency_change')}
      open
      onClose={onClose}
      closeLabel={t('common:close')}
    >
      <div className="mz-stack">
        <div className="mz-row mz-row--between">
          <span className="mz-caption">{t('glossary:settlement_currency')}</span>
          <span className="mz-row" style={{ gap: 'var(--space-1)' }}>
            {t(`glossary:${current.toLowerCase()}`)}
            {/* The registry's arrow, which mirrors in RTL — a `→` character does not. */}
            <Icon name="next" size={16} />
            {t(`glossary:${target.toLowerCase()}`)}
          </span>
        </div>
        <div className="mz-row mz-row--between">
          <span className="mz-caption">{t('glossary:balance')}</span>
          <span data-tabular>{formatter.money(balance, current)}</span>
        </div>

        {balance !== 0 ? (
          <NumberField
            label={t('companies:rebase_rate')}
            decimals={4}
            value={rebaseRate}
            onChange={(event) => setRebaseRate(event.target.value)}
            error={error}
          />
        ) : null}
        <p className="mz-caption">{t('companies:rebase_hint')}</p>

        <TextField label={t('common:note')} value={note} onChange={(event) => setNote(event.target.value)} />

        <Button
          block
          loading={saving}
          disabled={note.trim() === '' || (balance !== 0 && rebaseRate.trim() === '')}
          onClick={() =>
            onSave({
              currency: target,
              note: note.trim(),
              rebase_rate: balance === 0 ? null : rebaseRate.trim(),
            })
          }
        >
          {t('glossary:confirm')}
        </Button>
      </div>
    </BottomSheet>
  );
}

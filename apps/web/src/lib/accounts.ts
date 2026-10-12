import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Rate, RateSource } from '@mizan/money';
import { apiRequest } from './api.js';
import { useGlobalRate } from './rates.js';
import type { BalanceValue, CustomerRow } from '../pages/CustomersPage.js';

/**
 * One account (a company) by id, from the query every screen shares — the purchase form, "Buy
 * more", a new material's first purchase and a purchase's page all read the same cache entry.
 * Nothing is asked for until there is an id.
 */
export function useAccount(id: string | null | undefined) {
  return useQuery({
    queryKey: ['customers', id],
    queryFn: () => apiRequest<CustomerRow>(`/customers/${id}`),
    enabled: Boolean(id),
  });
}

/**
 * The rate a document for an account is valued at, and what to call it (2.3.3): a rate typed for
 * this document, else the account's own, else the system's — the precedence the server applies.
 * The label is the one the money fields show under their conversion, so a figure converted at a
 * company's own rate never says "the system rate" (review).
 */
export function useDocumentRate(
  account: CustomerRow | undefined,
  typed: { rate: Rate | null; label: string } | null = null,
): { rate: Rate | null; source: RateSource; label: string } {
  const { t } = useTranslation();
  const { rate: globalRate } = useGlobalRate();
  return documentRateOf(account, typed, globalRate, t);
}

/** The rule of `useDocumentRate`, apart from where its inputs come from (and so testable). */
export function documentRateOf(
  account: Pick<CustomerRow, 'rate'> | undefined,
  typed: { rate: Rate | null; label: string } | null,
  globalRate: Rate | null,
  t: (key: string) => string,
): { rate: Rate | null; source: RateSource; label: string } {
  if (typed?.rate) return { rate: typed.rate, source: 'manual', label: typed.label };
  if (account?.rate?.is_customer_rate) {
    return { rate: account.rate.rate_iqd_per_usd, source: 'company', label: t('glossary:customer_rate') };
  }
  return { rate: account?.rate?.rate_iqd_per_usd ?? globalRate, source: 'global', label: t('glossary:system_rate') };
}

/** What we owe a company, read in its own currency: positive — we owe them. */
export function payableAmount(payable: BalanceValue): number {
  return payable.currency === 'IQD' ? payable.amount_iqd : payable.amount_usd_cents;
}

/** How "what we owe them" reads, by which way it points (D-085). */
export function payableLabel(amount: number): string {
  if (amount > 0) return 'companies:we_owe_them';
  if (amount < 0) return 'print:paid_ahead';
  return 'companies:we_owe_nothing';
}

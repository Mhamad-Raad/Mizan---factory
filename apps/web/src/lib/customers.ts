import type { TFunction } from 'i18next';
import type { BalanceValue } from '../pages/CustomersPage.js';

/**
 * The walk-in customer is stored with an English name and rendered from the glossary, so it
 * reads زبون نقدي in Arabic and کڕیاری نەقد in Kurdish without a translated column (D-016).
 */
export function customerName(
  customer: { name: string; is_system?: boolean },
  t: TFunction,
): string {
  return customer.is_system ? t('glossary:walk_in_customer') : customer.name;
}

/** The label for each way a balance can point. */
export const DIRECTION_LABELS: Record<'owes' | 'settled' | 'credit', string> = {
  owes: 'companies:they_owe_us',
  settled: 'companies:settled',
  credit: 'customers:in_credit',
};

/** Which way what a company owes us points: owing, settled, or in credit (paid ahead). */
export function directionOf(balance: BalanceValue): 'owes' | 'settled' | 'credit' {
  const amount = balance.currency === 'IQD' ? balance.amount_iqd : balance.amount_usd_cents;
  if (amount === 0) return 'settled';
  return amount > 0 ? 'owes' : 'credit';
}

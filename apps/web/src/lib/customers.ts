import type { TFunction } from 'i18next';

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

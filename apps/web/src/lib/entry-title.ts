import type { TFunction } from 'i18next';

/**
 * What a row is, with the document it names: "Order #1004" for the order itself rather than
 * "Order · Order #1004", and "Payment received · Order #1004" for money against it.
 */
export function entryTitle(
  row: { entry_type: string; order_number?: number | null; purchase_number?: number | null },
  namespace: 'customers' | 'companies',
  t: TFunction,
  identifier: (value: number) => string,
): string {
  const document = row.order_number
    ? t('orders:number', { number: identifier(row.order_number) })
    : row.purchase_number
      ? t('purchases:number', { number: identifier(row.purchase_number) })
      : null;
  if (document && (row.entry_type === 'order' || row.entry_type === 'purchase')) return document;
  const label = t(`${namespace}:entry.${row.entry_type}`);
  return document ? `${label} · ${document}` : label;
}

import { useTranslation } from 'react-i18next';
import type { Currency } from '@mizan/money';
import { useFormatter } from '../lib/store.js';

/** What a saved order warned about: stock it sold beyond, and a credit limit it passed. */
export interface OrderSaveWarnings {
  stock_warnings: { item_id: string; item_name: string; available: string; requested: string }[];
  credit_limit_warning: { limit: number; balance_after: number; currency: Currency } | null;
}

/**
 * The warnings of an order just saved (FR-606, FR-503), shown on the page the save lands on —
 * the Orders list after a new order, the order itself after an edit — since the form that
 * received them is gone by then. A warning never blocks the save; it only has to be seen.
 */
export function OrderSaveWarningsNotice({ warnings }: { warnings: OrderSaveWarnings | null | undefined }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  if (!warnings) return null;
  const { stock_warnings: stock, credit_limit_warning: credit } = warnings;
  if (stock.length === 0 && !credit) return null;
  return (
    <div className="mz-warning" role="status">
      {stock.map((warning) => (
        <span key={warning.item_id}>
          {t('orders:stock_warning', {
            item: warning.item_name,
            available: formatter.quantity(warning.available),
            requested: formatter.quantity(warning.requested),
          })}
        </span>
      ))}
      {credit ? (
        <span>
          {t('orders:credit_limit_warning', {
            limit: formatter.money(credit.limit, credit.currency),
            balance: formatter.money(credit.balance_after, credit.currency),
          })}
        </span>
      ) : null}
    </div>
  );
}

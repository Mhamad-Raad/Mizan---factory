import type { Currency } from '@mizan/money';
import { useFormatter } from '../lib/store.js';

export interface DualAmountProps {
  amount_iqd: number;
  amount_usd_cents: number;
  /** The settlement currency, or the entered one where there is no counterparty. */
  primary?: Currency;
  /** `derived` marks the secondary figure with ≈ because it was converted, not stored. */
  kind?: 'stored' | 'derived';
  size?: 'normal' | 'large';
}

/**
 * The only way an amount is ever rendered (FR-1302, spec 2.3.6). A screen that shows a single
 * currency fails review, so there is deliberately no single-currency component to reach for.
 */
export function DualAmount({ amount_iqd, amount_usd_cents, primary = 'IQD', kind = 'stored', size = 'normal' }: DualAmountProps) {
  const formatter = useFormatter();
  const parts = formatter.dualAmount({ amount_iqd, amount_usd_cents, primary_currency: primary, kind });

  return (
    <span className="mz-dual" data-tabular>
      <bdi style={{ fontWeight: 600, fontSize: size === 'large' ? '1.75rem' : '1.125rem' }}>{parts.primary}</bdi>{' '}
      <bdi className="mz-caption">{parts.secondary}</bdi>
    </span>
  );
}

import type { Currency } from '@mizan/money';
import { useRollingNumber } from '../lib/motion.js';
import { useFormatter } from '../lib/store.js';

export interface DualAmountProps {
  amount_iqd: number;
  amount_usd_cents: number;
  /** The settlement currency, or the entered one where there is no counterparty. */
  primary?: Currency;
  /** `derived` marks the secondary figure with ≈ because it was converted, not stored. */
  kind?: 'stored' | 'derived';
  size?: 'normal' | 'large';
  /**
   * Roll the digits when the figure changes (signature moment 1, spec 3.6.2). On by default
   * only where a figure *changes under the reader's hands* — a form's total, a balance being
   * settled — because a list of fifty rolling rows is noise, not delight (3.6.1 budget).
   */
  roll?: boolean;
}

/**
 * The only way an amount is ever rendered (FR-1302, spec 2.3.6). A screen that shows a single
 * currency fails review, so there is deliberately no single-currency component to reach for.
 */
export function DualAmount({
  amount_iqd,
  amount_usd_cents,
  primary = 'IQD',
  kind = 'stored',
  size = 'normal',
  roll = false,
}: DualAmountProps) {
  const formatter = useFormatter();
  const rollingIqd = useRollingNumber(amount_iqd);
  const rollingUsd = useRollingNumber(amount_usd_cents);
  const parts = formatter.dualAmount({
    amount_iqd: roll ? rollingIqd : amount_iqd,
    amount_usd_cents: roll ? rollingUsd : amount_usd_cents,
    primary_currency: primary,
    kind,
  });

  return (
    <span className="mz-dual" data-tabular>
      <bdi style={{ fontWeight: 600, fontSize: size === 'large' ? '1.75rem' : '1.125rem' }}>{parts.primary}</bdi>{' '}
      <bdi className="mz-caption">{parts.secondary}</bdi>
    </span>
  );
}

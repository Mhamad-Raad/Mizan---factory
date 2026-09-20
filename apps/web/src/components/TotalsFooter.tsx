import { useTranslation } from 'react-i18next';
import { Button } from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { DualAmount } from './DualAmount.js';

export interface TotalsFooterProps {
  total_iqd: number;
  total_usd_cents: number;
  primary: Currency;
  lineCount: number;
  saving?: boolean;
  disabled?: boolean;
  onSave: () => void;
  /** Proposed — not requested (FR-616): the discount row above the total. */
  discount?: React.ReactNode;
  saveLabel?: string;
}

/**
 * The sticky footer of the order form (wireframe 3.4.1, signature moment 1): the totals in
 * both currencies stay visible while lines are added, and the primary action sits in the
 * thumb zone. The totals are sums of the stored line values, never a conversion (2.3.4).
 */
export function TotalsFooter({
  total_iqd,
  total_usd_cents,
  primary,
  lineCount,
  saving,
  disabled,
  onSave,
  discount,
  saveLabel,
}: TotalsFooterProps) {
  const { t } = useTranslation();
  return (
    <div className="mz-sticky-footer">
      {discount}
      <div className="mz-totals">
        <span>{t('glossary:total')}</span>
        <DualAmount amount_iqd={total_iqd} amount_usd_cents={total_usd_cents} primary={primary} />
      </div>
      <Button block loading={saving} disabled={disabled} onClick={onSave}>
        {saveLabel ?? t('orders:save_order', { count: lineCount })}
      </Button>
    </div>
  );
}

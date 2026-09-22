import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { DualAmount } from './DualAmount.js';
import { useMotionAllowed } from '../lib/motion.js';

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
  // The pulse of signature moment 1: a line was added, so the total leans forward once.
  const motion = useMotionAllowed();
  const [pulse, setPulse] = useState(false);
  const previousLines = useRef(lineCount);
  useEffect(() => {
    if (!motion || lineCount <= previousLines.current) {
      previousLines.current = lineCount;
      return;
    }
    previousLines.current = lineCount;
    let timer = 0;
    const frame = requestAnimationFrame(() => {
      setPulse(true);
      timer = window.setTimeout(() => setPulse(false), 300);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [lineCount, motion]);

  return (
    <div className="mz-sticky-footer">
      {discount}
      <div className={pulse ? 'mz-totals mz-totals--pulse' : 'mz-totals'}>
        <span>{t('glossary:total')}</span>
        {/* Rolls, because this is the figure the employee is watching grow (3.6.2). */}
        <DualAmount amount_iqd={total_iqd} amount_usd_cents={total_usd_cents} primary={primary} roll />
      </div>
      <Button block loading={saving} disabled={disabled} onClick={onSave}>
        {saveLabel ?? t('orders:save_order', { count: lineCount })}
      </Button>
    </div>
  );
}

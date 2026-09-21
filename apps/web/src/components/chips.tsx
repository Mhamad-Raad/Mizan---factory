import { useTranslation } from 'react-i18next';
import { Chip } from '@mizan/ui';
import type { Rate } from '@mizan/money';
import { useFormatter } from '../lib/store.js';

export type OrderStatus = 'unpaid' | 'partially_paid' | 'paid' | 'void';

/**
 * The status chips (FR-607, spec 3.2). Each carries an icon as well as a colour, because
 * colour alone is never the signal (spec 2.10.8).
 */
export function OrderStatusChip({ status, settling }: { status: OrderStatus; settling?: boolean }) {
  const { t } = useTranslation();
  const tone = status === 'paid' ? 'success' : status === 'partially_paid' ? 'warning' : status === 'void' ? 'danger' : 'neutral';
  const icon = status === 'paid' ? 'check' : status === 'void' ? 'close' : 'clock';
  return (
    // `settling` draws the check rather than dropping it in — the moment a balance reaches
    // zero, and only then (signature moment 2, spec 3.6.2).
    <span className={settling ? 'mz-chip-settling' : undefined}>
      <Chip tone={tone} icon={icon}>
        {t(`glossary:${status}`)}
      </Chip>
    </span>
  );
}

export function PaymentTypeChip({ type }: { type: 'cash' | 'borrowed' }) {
  const { t } = useTranslation();
  return <Chip tone={type === 'cash' ? 'primary' : 'neutral'}>{t(`glossary:${type}`)}</Chip>;
}

/** "Rate for this document", shown wherever an amount was filled with one (spec 2.3.3). */
export function RateBadge({ rate, source }: { rate: Rate; source: string }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  return (
    <Chip tone={source === 'manual' ? 'warning' : 'neutral'}>
      {source === 'manual'
        ? t('common:manual_rate', { rate: formatter.rate(rate) })
        : t('common:rate_used', { rate: formatter.rate(rate) })}
    </Chip>
  );
}

/**
 * "from August" on a line whose price was carried forward (FR-306). Quiet by design: a
 * warning on every line of a thousand-material floor is noise, not information.
 */
export function PriceFromMonth({ month }: { month: string }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  return <span className="mz-caption">{t('materials:price_from', { month: formatter.month(month.slice(0, 7)) })}</span>;
}

export type ReturnStatus = 'not_returnable' | 'pending' | 'returned' | 'returned_credited' | 'written_off';

/**
 * The return-status chip of FR-803. Each state carries an icon as well as a colour, because
 * colour alone is never the signal (spec 2.10.8) — and "pending" is the one an owner scans the
 * list for, so it is the only one that reads as a warning.
 */
export function ReturnStatusChip({ status }: { status: ReturnStatus }) {
  const { t } = useTranslation();
  const tone =
    status === 'returned_credited'
      ? 'success'
      : status === 'returned'
        ? 'primary'
        : status === 'pending'
          ? 'warning'
          : 'neutral';
  const icon =
    status === 'returned_credited' ? 'check' : status === 'pending' ? 'clock' : status === 'returned' ? 'check' : 'close';
  return (
    <Chip tone={tone} icon={icon}>
      {t(`damages:status.${status}`)}
    </Chip>
  );
}

export type DamageAttribution = 'none' | 'customer_order' | 'us' | 'company';

/** Where the damage came from (FR-802), shown on the list row and the detail header. */
export function AttributionChip({ attribution }: { attribution: DamageAttribution }) {
  const { t } = useTranslation();
  if (attribution === 'none') return null;
  return <Chip tone="neutral">{t(`damages:attribution.${attribution}`)}</Chip>;
}

import { useTranslation } from 'react-i18next';
import { Chip } from '@mizan/ui';
import type { Rate } from '@mizan/money';
import { useFormatter } from '../lib/store.js';

export type OrderStatus = 'unpaid' | 'partially_paid' | 'paid' | 'void';

/**
 * The status chips (FR-607, spec 3.2). Each carries an icon as well as a colour, because
 * colour alone is never the signal (spec 2.10.8).
 */
export function OrderStatusChip({ status }: { status: OrderStatus }) {
  const { t } = useTranslation();
  const tone = status === 'paid' ? 'success' : status === 'partially_paid' ? 'warning' : status === 'void' ? 'danger' : 'neutral';
  const icon = status === 'paid' ? 'check' : status === 'void' ? 'close' : 'clock';
  return (
    <Chip tone={tone} icon={icon}>
      {t(`glossary:${status}`)}
    </Chip>
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

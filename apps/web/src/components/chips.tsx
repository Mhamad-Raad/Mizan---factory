import { useTranslation } from 'react-i18next';
import { Chip } from '@mizan/ui';
import type { Rate } from '@mizan/money';
import type { CustomerRow } from '../pages/CustomersPage.js';
import type { DamageRow } from '../pages/DamagesPage.js';
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
    // Which rate the document was made at, snapshotted on it (2.3.3, D-055): the company's own,
    // the system-wide one, or one typed for this document alone.
    <Chip tone={source === 'manual' ? 'warning' : source === 'company' ? 'primary' : 'neutral'}>
      {t(
        source === 'manual' ? 'common:manual_rate' : source === 'company' ? 'common:rate_company' : 'common:rate_system',
        { rate: formatter.rate(rate) },
      )}
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

export type DamageAttribution = 'none' | 'customer_order' | 'us' | 'company';

/** A deactivated account says so wherever it is listed. */
export function InactiveChip({ row }: { row: Pick<CustomerRow, 'is_active'> }) {
  const { t } = useTranslation();
  if (row.is_active) return null;
  return (
    <span className="mz-rowcard__chips">
      <Chip icon="close">{t('common:deactivated')}</Chip>
    </span>
  );
}

/**
 * Where a company's damage stands (D-062): owed until it is paid back. Our own damage has no
 * chip — it is a loss, and there is nothing to wait for. Icon and word, never colour alone.
 */
export function CompensationChip({ compensation }: { compensation: DamageRow['compensation'] }) {
  const { t } = useTranslation();
  if (compensation === 'none') return null;
  if (compensation === 'owed') {
    return (
      <Chip tone="warning" icon="clock">
        {t('damages:compensation.owed')}
      </Chip>
    );
  }
  return (
    <Chip tone="success" icon="check">
      {t('damages:compensation.paid')}
    </Chip>
  );
}

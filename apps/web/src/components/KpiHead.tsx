import { Icon } from '@mizan/ui';
import type { IconName } from '@mizan/ui';

/**
 * The head of a figure tile — its icon and what it counts — the same on Today, Orders, Damages,
 * Accounts and Reports. The tile around it stays the caller's: a link on Today, a filter button
 * where the figure is also a filter, a plain box elsewhere.
 */
export function KpiHead({ icon, label }: { icon: IconName; label: string }) {
  return (
    <span className="mz-kpi__head">
      <span className="mz-kpi__icon" aria-hidden="true">
        <Icon name={icon} size={18} />
      </span>
      <span className="mz-caption">{label}</span>
    </span>
  );
}

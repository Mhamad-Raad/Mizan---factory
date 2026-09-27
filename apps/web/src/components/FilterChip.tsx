import type { ReactNode } from 'react';
import { Icon } from '@mizan/ui';

/** A filter that is on or off — "Unpaid", "Show inactive" — with a tick when it is on. */
export function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="mz-filter-chip" aria-pressed={active} onClick={onClick}>
      {active ? <Icon name="check" size={16} /> : null}
      {children}
    </button>
  );
}

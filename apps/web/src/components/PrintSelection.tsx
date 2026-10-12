import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@mizan/ui';
import { PRINT_LIMIT, usePrint } from '../lib/print.js';
import type { PrintDocument } from '../lib/print.js';

/** What a list hands its rows for "select to print": whether a row is ticked, and how to tick it. */
export interface RowSelection<Row> {
  isSelected: (row: Row) => boolean;
  onToggle: (row: Row) => void;
}

/**
 * "Select to print" on a list (D-086): tick old records — purchases, orders, payments — and print
 * their receipts again, each on its own page. The ticks survive paging, so a selection can be
 * gathered across pages, up to what one print may carry.
 */
export function usePrintSelection<Row>(documentOf: (row: Row) => PrintDocument, keyOf: (row: Row) => string) {
  const [active, setActive] = useState(false);
  const [selected, setSelected] = useState<Map<string, PrintDocument>>(() => new Map());
  const print = usePrint();

  const selection: RowSelection<Row> | undefined = active
    ? {
        isSelected: (row) => selected.has(keyOf(row)),
        onToggle: (row) =>
          setSelected((current) => {
            const next = new Map(current);
            const key = keyOf(row);
            if (next.has(key)) next.delete(key);
            else if (next.size < PRINT_LIMIT) next.set(key, documentOf(row));
            return next;
          }),
      }
    : undefined;

  return {
    active,
    count: selected.size,
    full: selected.size >= PRINT_LIMIT,
    selection,
    start: () => setActive(true),
    stop: () => {
      setActive(false);
      setSelected(new Map());
    },
    clear: () => setSelected(new Map()),
    print: () => print([...selected.values()]),
  };
}

/**
 * The bar above a list while selecting: how many are ticked, print them, start again, or stop.
 * Outside selection it is one quiet button, so a list that is only being read stays calm.
 */
export function PrintSelectionBar({ state }: { state: ReturnType<typeof usePrintSelection<never>> }) {
  const { t } = useTranslation();
  if (!state.active) {
    return (
      <Button variant="secondary" icon="print" onClick={state.start}>
        {t('print:select')}
      </Button>
    );
  }
  return (
    <div className="mz-selection-bar" role="region" aria-label={t('print:select')}>
      <span className="mz-selection-bar__count" aria-live="polite">
        {t('print:selected_count', { count: state.count })}
      </span>
      {state.full ? <span className="mz-caption">{t('print:limit_reached', { count: PRINT_LIMIT })}</span> : null}
      <span className="mz-selection-bar__actions">
        <Button icon="print" disabled={state.count === 0} onClick={state.print}>
          {t('print:print_receipts')}
        </Button>
        {state.count > 0 ? (
          <Button variant="ghost" onClick={state.clear}>
            {t('print:clear_selection')}
          </Button>
        ) : null}
        <Button variant="secondary" onClick={state.stop}>
          {t('print:select_done')}
        </Button>
      </span>
    </div>
  );
}

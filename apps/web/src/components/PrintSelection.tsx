import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@mizan/ui';
import { PRINT_LIMIT, usePrint } from '../lib/print.js';
import type { PrintDocument } from '../lib/print.js';

/** What a list hands its rows: whether each is ticked, how to tick it, and the whole page at once. */
export interface RowSelection<Row> {
  isSelected: (row: Row) => boolean;
  onToggle: (row: Row) => void;
  /**
   * The heading's tick box: how much of this page is ticked — all, some (the print limit can stop
   * a "tick all" part way) or none. Pressed with anything ticked it clears the page; with nothing
   * ticked it ticks it, as far as the limit allows (review).
   */
  pageState: (rows: readonly Row[]) => 'all' | 'some' | 'none';
  onToggleAll: (rows: readonly Row[], on: boolean) => void;
}

/**
 * The tick boxes of a list (D-086): every row has one, always — ticking a row puts it on the
 * print list, and the ticks survive paging, so receipts can be gathered across pages, up to what
 * one print may carry. There is no "select" mode to switch on first, and no second button: the
 * list's one Print button prints what is ticked.
 */
export function usePrintSelection<Row>(documentOf: (row: Row) => PrintDocument, keyOf: (row: Row) => string) {
  const [selected, setSelected] = useState<Map<string, PrintDocument>>(() => new Map());
  const print = usePrint();

  const selection: RowSelection<Row> = {
    isSelected: (row) => selected.has(keyOf(row)),
    onToggle: (row) =>
      setSelected((current) => {
        const next = new Map(current);
        const key = keyOf(row);
        if (next.has(key)) next.delete(key);
        else if (next.size < PRINT_LIMIT) next.set(key, documentOf(row));
        return next;
      }),
    pageState: (rows) => {
      const ticked = rows.filter((row) => selected.has(keyOf(row))).length;
      return ticked === 0 ? 'none' : ticked === rows.length ? 'all' : 'some';
    },
    onToggleAll: (rows, on) =>
      setSelected((current) => {
        const next = new Map(current);
        for (const row of rows) {
          const key = keyOf(row);
          if (!on) next.delete(key);
          else if (!next.has(key) && next.size < PRINT_LIMIT) next.set(key, documentOf(row));
        }
        return next;
      }),
  };

  return {
    count: selected.size,
    full: selected.size >= PRINT_LIMIT,
    selection,
    clear: () => setSelected(new Map()),
    print: () => print([...selected.values()]),
  };
}

/**
 * A list's one Print button. With rows ticked it prints them — "Print selected (3)", a page each
 * — and offers to clear the ticks. With none, a list's button waits, greyed out, for a tick (the
 * business: a list prints what is chosen, never the whole of it unasked); an account's prints
 * what printing it means there, its statement for the dates chosen.
 */
export function PrintButton({
  state,
  wholeLabel,
  onPrintWhole,
}: {
  state: ReturnType<typeof usePrintSelection<never>>;
  /** An account's "Print account": what the button does with nothing ticked. Absent on a list. */
  wholeLabel?: string;
  onPrintWhole?: () => void;
}) {
  const { t } = useTranslation();
  const ticked = state.count > 0;
  const whole = wholeLabel !== undefined && onPrintWhole !== undefined;
  return (
    <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
      <Button
        variant="secondary"
        icon="print"
        disabled={!ticked && !whole}
        onClick={ticked ? state.print : onPrintWhole}
      >
        {ticked ? t('print:print_selected', { count: state.count }) : whole ? wholeLabel : t('print:print_list')}
      </Button>
      {ticked ? (
        <Button variant="ghost" onClick={state.clear}>
          {t('print:clear_selection')}
        </Button>
      ) : !whole ? (
        <span className="mz-caption">{t('print:tick_to_print')}</span>
      ) : null}
      {state.full ? (
        <span className="mz-caption" role="status">
          {t('print:limit_reached', { count: PRINT_LIMIT })}
        </span>
      ) : null}
    </div>
  );
}

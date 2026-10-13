import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Checkbox } from '@mizan/ui';
import { useIsWide } from '../lib/wide.js';
import type { RowSelection } from './PrintSelection.js';

export interface Column<Row> {
  /** The column heading, already translated. */
  header: string;
  /** What the cell shows. */
  cell: (row: Row) => ReactNode;
  /** Money and counts read better aligned to the end of their column. */
  numeric?: boolean;
  /** Dropped on narrower desktops, where only the columns that decide things fit. */
  secondary?: boolean;
}

/**
 * One list, two layouts (spec 2.10.2).
 *
 * On a phone a row is a **card**: the name large, everything else beneath it, the whole thing a
 * 44 px target for a thumb. On a desktop the same rows are a **table** with headings, because
 * an office compares twenty rows down a column and a column of cards cannot be compared.
 *
 * Both come from one description of the row — the columns below for the table, and the card
 * the caller already had for the phone — so a field cannot appear in one and be forgotten in
 * the other, and no string is written twice.
 */
export function DataList<Row>({
  rows,
  columns,
  rowKey,
  href,
  card,
  selection,
  rowLabel,
}: {
  rows: readonly Row[];
  columns: readonly Column<Row>[];
  rowKey: (row: Row) => string;
  /** Where the row leads; a table row is as clickable as a card. */
  href: (row: Row) => string;
  /** The phone layout, which is what the screenshot suite and the 360 px checks assert. */
  card: (row: Row) => ReactNode;
  /** The print tick boxes (D-086): one at the start of every row, and one for the page. */
  selection?: RowSelection<Row>;
  /** What a row is called, for its tick box's label: "Purchase #12". */
  rowLabel?: (row: Row) => string;
}) {
  const wide = useIsWide();
  const { t } = useTranslation();
  const tick = (row: Row) =>
    selection ? (
      <Checkbox
        labelHidden
        label={t('print:select_row', { name: rowLabel?.(row) ?? '' })}
        checked={selection.isSelected(row)}
        onChange={() => selection.onToggle(row)}
      />
    ) : null;

  if (!wide) {
    return (
      <ul className="mz-list">
        {rows.map((row) => (
          <li key={rowKey(row)} className={selection ? 'mz-selectable' : undefined}>
            {tick(row)}
            <Link to={href(row)} className="mz-list__item mz-list__item--interactive">
              {card(row)}
            </Link>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="mz-table-wrap">
      <table className="mz-table">
        <thead>
          <tr>
            {selection ? (
              <th scope="col" className="mz-table__tick">
                <Checkbox
                  labelHidden
                  label={t('print:select_all_page')}
                  checked={selection.allSelected(rows)}
                  onChange={(on) => selection.onToggleAll(rows, on)}
                />
              </th>
            ) : null}
            {columns.map((column) => (
              <th
                key={column.header}
                scope="col"
                className={column.secondary ? 'mz-table__secondary' : undefined}
                data-numeric={column.numeric ? 'true' : undefined}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} data-selected={selection?.isSelected(row) ? 'true' : undefined}>
              {selection ? <td className="mz-table__tick">{tick(row)}</td> : null}
              {columns.map((column, index) => (
                <td
                  key={column.header}
                  className={column.secondary ? 'mz-table__secondary' : undefined}
                  data-numeric={column.numeric ? 'true' : undefined}
                >
                  {/* The first cell carries the link, so the row is reachable by keyboard once
                      rather than once per column. */}
                  {index === 0 ? (
                    <Link to={href(row)} className="mz-table__link">
                      {column.cell(row)}
                    </Link>
                  ) : (
                    <Fragment>{column.cell(row)}</Fragment>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

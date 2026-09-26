import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useIsWide } from '../lib/wide.js';

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
}: {
  rows: readonly Row[];
  columns: readonly Column<Row>[];
  rowKey: (row: Row) => string;
  /** Where the row leads; a table row is as clickable as a card. */
  href: (row: Row) => string;
  /** The phone layout, which is what the screenshot suite and the 360 px checks assert. */
  card: (row: Row) => ReactNode;
}) {
  const wide = useIsWide();

  if (!wide) {
    return (
      <ul className="mz-list">
        {rows.map((row) => (
          <li key={rowKey(row)}>
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
            <tr key={rowKey(row)}>
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

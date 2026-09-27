import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

export interface BarListRow {
  key: string;
  label: string;
  href: string;
  /** The bar's length, in one unit for every row. */
  value: number;
  /** What is written at the end of the row — the amount in both currencies. */
  display: ReactNode;
}

/**
 * A ranked list with a bar under each name: one hue for magnitude (dataviz: sequential is the
 * safe default), the text in text tokens, and each row a link to the record it is about — a
 * number on a dashboard is never a dead end (spec 3.3).
 */
export function BarList({ rows, color }: { rows: readonly BarListRow[]; color: string }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <ul className="mz-barlist">
      {rows.map((row) => (
        <li key={row.key}>
          <Link to={row.href} className="mz-barlist__row">
            <span className="mz-barlist__head">
              <bdi className="mz-barlist__label">{row.label}</bdi>
              <span className="mz-barlist__value">{row.display}</span>
            </span>
            <span className="mz-barlist__track" aria-hidden="true">
              <span
                className="mz-barlist__bar"
                style={{ inlineSize: `${Math.max(2, (row.value / max) * 100)}%`, background: color }}
              />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

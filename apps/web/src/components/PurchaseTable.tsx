import { useTranslation } from 'react-i18next';
import { Chip, Icon } from '@mizan/ui';
import { DataList } from './DataList.js';
import type { Column } from './DataList.js';
import type { RowSelection } from './PrintSelection.js';
import { DualAmount } from './DualAmount.js';
import { OrderStatusChip } from './chips.js';
import { useFormatter } from '../lib/store.js';
import { bothOf } from '../lib/money.js';
import type { PurchaseRow } from '../lib/purchases.js';

/**
 * Purchases as the Purchases page lists them (D-085) — a table on a desktop, a card each on a
 * phone — and as a company's Purchases tab does, where every row is the same company and that
 * column gives its place to who recorded it. Each row's payment state — paid, partly paid or
 * unpaid, and what is still owed — comes with it from the API, for readers who may see what we
 * owe; for anyone else those columns are not drawn.
 */
export function PurchaseTable({
  rows,
  showCompany = true,
  selection,
}: {
  rows: readonly PurchaseRow[];
  showCompany?: boolean;
  selection?: RowSelection<PurchaseRow>;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const numberOf = (row: PurchaseRow) => t('purchases:number', { number: formatter.identifier(row.number) });

  const recordedBy = (row: PurchaseRow) =>
    row.acting_user_name ? (
      <span className="mz-caption" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
        <Icon name="user" size={12} />
        <bdi>{row.acting_user_name}</bdi>
      </span>
    ) : null;

  const company = (row: PurchaseRow) =>
    row.company_name ? <bdi>{row.company_name}</bdi> : <span className="mz-muted">{t('purchases:no_company')}</span>;

  const total = (row: PurchaseRow) =>
    row.cost ? (
      <DualAmount
        amount_iqd={row.cost.total_iqd}
        amount_usd_cents={row.cost.total_usd_cents}
        primary={row.settlement_currency ?? 'IQD'}
      />
    ) : (
      <span className="mz-muted">—</span>
    );

  // Drawn only when the API sent payment states — a reader who may see what we owe.
  const seesPayment = rows.some((row) => row.payment !== undefined);

  const owed = (row: PurchaseRow) => {
    const remaining = row.payment?.remaining ?? null;
    if (remaining === null) return <span className="mz-muted">—</span>;
    if (remaining <= 0) return <span className="mz-muted">—</span>;
    const currency = row.settlement_currency ?? 'IQD';
    // In both currencies, the other at the purchase's own rate (rule 7).
    return (
      <span className="mz-owed">
        <DualAmount {...bothOf(remaining, currency, row.rate_iqd_per_usd)} primary={currency} kind="derived" />
      </span>
    );
  };

  const columns: Column<PurchaseRow>[] = [
    {
      header: t('common:number_column'),
      cell: (row) => (
        <span className="mz-cell__body">
          <strong>{numberOf(row)}</strong>
          <span className="mz-caption">{formatter.date(row.purchase_date)}</span>
        </span>
      ),
    },
    showCompany
      ? {
          header: t('glossary:company'),
          cell: (row) => (
            <span className="mz-cell__body">
              {company(row)}
              {recordedBy(row)}
            </span>
          ),
        }
      : { header: t('glossary:done_by'), cell: (row) => recordedBy(row) ?? <span className="mz-muted">—</span> },
    {
      header: t('purchases:materials_column'),
      secondary: true,
      cell: (row) => <bdi>{row.item_names ?? ''}</bdi>,
    },
    { header: t('glossary:total'), numeric: true, cell: total },
    ...(seesPayment ? [{ header: t('purchases:still_owed'), numeric: true, cell: owed }] : []),
    // Void, or paid / partly paid / unpaid — never an empty cell for a purchase that stands.
    { header: t('common:status'), cell: (row) => <PurchaseStatus row={row} /> },
  ];

  return (
    <DataList
      rows={rows}
      rowKey={(row) => row.id}
      href={(row) => `/purchases/${row.id}`}
      columns={columns}
      selection={selection}
      rowLabel={numberOf}
      card={(row) => (
        <span className="mz-rowcard">
          <span className="mz-rowcard__head">
            <span className="mz-list__title">{numberOf(row)}</span>
            <span className="mz-rowcard__chips">
              <PurchaseStatus row={row} />
            </span>
          </span>
          <span className="mz-caption">
            {showCompany ? (
              <>
                {company(row)}
                {' · '}
              </>
            ) : null}
            {formatter.date(row.purchase_date)}
          </span>
          {row.item_names ? (
            <span className="mz-caption">
              <bdi>{row.item_names}</bdi>
            </span>
          ) : null}
          <span className="mz-rowcard__foot">
            {total(row)}
            {seesPayment ? owed(row) : null}
          </span>
        </span>
      )}
    />
  );
}

/**
 * Where a purchase stands: void, or paid / partly paid / unpaid as its own page reads it. A
 * purchase from no company owes nobody and says so; for a reader who may not see what we owe,
 * a standing purchase shows nothing rather than a guess.
 */
function PurchaseStatus({ row }: { row: PurchaseRow }) {
  const { t } = useTranslation();
  if (row.doc_status === 'void') return <OrderStatusChip status="void" />;
  if (!row.company_id) return <Chip>{t('purchases:owes_nobody')}</Chip>;
  return row.payment ? <OrderStatusChip status={row.payment.status} /> : null;
}

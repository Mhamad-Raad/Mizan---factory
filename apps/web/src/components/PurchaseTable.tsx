import { useTranslation } from 'react-i18next';
import { Chip, Icon } from '@mizan/ui';
import { DataList } from './DataList.js';
import type { Column } from './DataList.js';
import type { RowSelection } from './PrintSelection.js';
import { DualAmount } from './DualAmount.js';
import { useFormatter } from '../lib/store.js';
import { bothOf } from '../lib/money.js';
import type { PurchaseRow } from '../lib/purchases.js';

/**
 * Purchases as the Purchases page lists them (D-085) — a table on a desktop, a card each on a
 * phone — and as a company's Purchases tab does, where every row is the same company and that
 * column gives its place to who recorded it. `remainingOf` is what is still owed on a row, which
 * only the company's page knows (it is an oldest-first share of the company's payments, FR-712).
 */
export function PurchaseTable({
  rows,
  showCompany = true,
  remainingOf,
  selection,
}: {
  rows: readonly PurchaseRow[];
  showCompany?: boolean;
  remainingOf?: (row: PurchaseRow) => number | null;
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
    row.company_name ? <bdi>{row.company_name}</bdi> : <span className="mz-muted">{t('purchases:stock_only_badge')}</span>;

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

  const owed = (row: PurchaseRow) => {
    const remaining = row.doc_status === 'void' ? null : (remainingOf?.(row) ?? null);
    if (remaining === null) return <span className="mz-muted">—</span>;
    if (remaining <= 0) return <Chip tone="success">{t('glossary:paid')}</Chip>;
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
    ...(remainingOf ? [{ header: t('purchases:still_owed'), numeric: true, cell: owed }] : []),
    {
      header: t('common:status'),
      cell: (row) =>
        row.doc_status === 'void' ? (
          <Chip tone="danger" icon="close">
            {t('glossary:void')}
          </Chip>
        ) : null,
    },
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
              {row.doc_status === 'void' ? <Chip tone="danger">{t('glossary:void')}</Chip> : null}
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
            {remainingOf ? owed(row) : null}
          </span>
        </span>
      )}
    />
  );
}

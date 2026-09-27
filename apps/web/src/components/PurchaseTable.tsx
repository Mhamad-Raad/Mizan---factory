import { useTranslation } from 'react-i18next';
import { Chip, Icon } from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { DataList } from './DataList.js';
import type { Column } from './DataList.js';
import { DualAmount } from './DualAmount.js';
import { useFormatter } from '../lib/store.js';
import type { PurchaseRow } from '../pages/PurchasesPage.js';

/**
 * Purchases as the Purchases page shows them — a table on a desktop, a card per purchase on a
 * phone — the buying twin of `OrderTable`, so a company's Purchases tab reads exactly like the
 * list it is a slice of (client review).
 *
 * `showCompany` is off where every row is the same company. `remainingOf` is passed where what
 * is still owed per purchase is known — the company page, from its oldest-first allocation
 * (FR-712) — and adds the column an office chases; the all-companies list has no such figure.
 */
export function PurchaseTable({
  rows,
  showCompany = true,
  remainingOf,
  settlement,
}: {
  rows: readonly PurchaseRow[];
  showCompany?: boolean;
  remainingOf?: (purchase: PurchaseRow) => number | null;
  /** The company's settlement currency where it is one company; each row's own otherwise. */
  settlement?: Currency;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const currencyOf = (purchase: PurchaseRow): Currency => settlement ?? purchase.settlement_currency ?? 'IQD';

  const recordedBy = (purchase: PurchaseRow) =>
    purchase.acting_user_name ? (
      <span className="mz-caption" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
        <Icon name="user" size={12} />
        <bdi>{purchase.acting_user_name}</bdi>
      </span>
    ) : null;

  const company = (purchase: PurchaseRow) =>
    purchase.company_id ? <bdi>{purchase.company_name}</bdi> : <Chip>{t('purchases:stock_only_badge')}</Chip>;

  const total = (purchase: PurchaseRow) =>
    purchase.cost ? (
      <DualAmount
        amount_iqd={purchase.cost.total_iqd}
        amount_usd_cents={purchase.cost.total_usd_cents}
        primary={currencyOf(purchase)}
      />
    ) : (
      <span className="mz-muted">—</span>
    );

  const remaining = (purchase: PurchaseRow) => {
    const value = remainingOf?.(purchase) ?? null;
    return value !== null && value > 0 && purchase.doc_status === 'active' ? (
      <span className="mz-owed" data-tabular>
        {formatter.money(value, currencyOf(purchase))}
      </span>
    ) : (
      <span className="mz-muted">—</span>
    );
  };

  // A purchase is either standing or voided; only the exception wears a chip.
  const voided = (purchase: PurchaseRow) =>
    purchase.doc_status === 'void' ? (
      <Chip tone="danger" icon="close">
        {t('glossary:void')}
      </Chip>
    ) : null;

  const columns: Column<PurchaseRow>[] = [
    {
      // Purchase number over its date, as an order's is.
      header: t('common:number_column'),
      cell: (purchase) => (
        <span className="mz-cell__body">
          <strong>{t('purchases:number', { number: formatter.number(purchase.number) })}</strong>
          <span className="mz-caption">{formatter.date(purchase.purchase_date)}</span>
          {voided(purchase)}
        </span>
      ),
    },
    showCompany
      ? {
          header: t('glossary:company'),
          cell: (purchase) => (
            <span className="mz-cell__body">
              <span>{company(purchase)}</span>
              {recordedBy(purchase)}
            </span>
          ),
        }
      : { header: t('glossary:done_by'), cell: (purchase) => recordedBy(purchase) ?? <span className="mz-muted">—</span> },
    {
      header: t('purchases:materials_column'),
      numeric: true,
      secondary: true,
      cell: (purchase) => <span data-tabular>{formatter.number(purchase.line_count)}</span>,
    },
    { header: t('glossary:total'), numeric: true, cell: total },
    ...(remainingOf ? [{ header: t('glossary:remaining'), numeric: true, cell: remaining }] : []),
  ];

  return (
    <DataList
      rows={rows}
      rowKey={(purchase) => purchase.id}
      href={(purchase) => `/purchases/${purchase.id}`}
      columns={columns}
      card={(purchase) => {
        const owed = remainingOf?.(purchase) ?? null;
        return (
          <span className="mz-rowcard">
            <span className="mz-rowcard__head">
              <span className="mz-list__title">{t('purchases:number', { number: formatter.number(purchase.number) })}</span>
              <span className="mz-rowcard__chips">
                {purchase.company_id === null ? <Chip>{t('purchases:stock_only_badge')}</Chip> : null}
                {voided(purchase)}
              </span>
            </span>
            <span className="mz-caption">
              {showCompany && purchase.company_id ? (
                <>
                  <bdi>{purchase.company_name}</bdi>
                  {' · '}
                </>
              ) : null}
              {formatter.date(purchase.purchase_date)}
              {purchase.acting_user_name ? (
                <>
                  {' · '}
                  <bdi>{purchase.acting_user_name}</bdi>
                </>
              ) : null}
              {' · '}
              {t('purchases:lines_count', { count: formatter.number(purchase.line_count) })}
            </span>
            <span className="mz-rowcard__foot">
              {total(purchase)}
              {owed !== null && owed > 0 && purchase.doc_status === 'active' ? (
                <span className="mz-caption mz-owed" data-tabular>
                  {t('glossary:remaining')}: {formatter.money(owed, currencyOf(purchase))}
                </span>
              ) : null}
            </span>
          </span>
        );
      }}
    />
  );
}

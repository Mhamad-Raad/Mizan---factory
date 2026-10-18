import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Chip, Icon } from '@mizan/ui';
import type { Currency, Rate } from '@mizan/money';
import { DataList } from './DataList.js';
import type { Column } from './DataList.js';
import type { RowSelection } from './PrintSelection.js';
import { DualAmount } from './DualAmount.js';
import { OrderStatusChip } from './chips.js';
import { customerName } from '../lib/customers.js';
import { bothOf } from '../lib/money.js';
import { useFormatter } from '../lib/store.js';
import type { OrderRow } from '../lib/orders.js';
import type { PurchaseRow } from '../lib/purchases.js';

/** One row of Buying & selling (D-089): a sale or a purchase, each as its own list sends it. */
export type TradeRow = ({ kind: 'sale' } & OrderRow) | ({ kind: 'purchase' } & PurchaseRow);

/** What every row has, whichever kind it is — so the columns are written once. */
interface Shown {
  number: string;
  date: string;
  company: string | null;
  recordedBy: string | null;
  total: { amount_iqd: number; amount_usd_cents: number } | null;
  currency: Currency;
  rate: Rate;
  /** Still owed, in the company's currency; null when it is nobody's to know or nothing applies. */
  owed: number | null;
  status: 'unpaid' | 'partially_paid' | 'paid' | 'void' | 'owes_nobody' | null;
  href: string;
}

export function shownOf(row: TradeRow, t: TFunction, identifier: (n: number) => string): Shown {
  if (row.kind === 'sale') {
    return {
      number: t('orders:number', { number: identifier(row.number) }),
      date: row.order_date,
      company: customerName({ name: row.customer_name, is_system: row.customer_is_system }, t),
      recordedBy: row.acting_user_name,
      total: { amount_iqd: row.total_iqd, amount_usd_cents: row.total_usd_cents },
      currency: row.settlement_currency,
      rate: row.rate_iqd_per_usd,
      owed: row.status === 'void' ? null : row.remaining,
      status: row.status,
      href: `/orders/${row.id}`,
    };
  }
  return {
    number: t('purchases:number', { number: identifier(row.number) }),
    date: row.purchase_date,
    company: row.company_name,
    recordedBy: row.acting_user_name,
    total: row.cost ? { amount_iqd: row.cost.total_iqd, amount_usd_cents: row.cost.total_usd_cents } : null,
    currency: row.settlement_currency ?? 'IQD',
    rate: row.rate_iqd_per_usd,
    owed: row.payment?.remaining ?? null,
    status: row.doc_status === 'void' ? 'void' : !row.company_id ? 'owes_nobody' : (row.payment?.status ?? null),
    href: `/purchases/${row.id}`,
  };
}

/**
 * Sales and purchases on one table (D-089) — a table on a desktop, a card each on a phone. A row
 * says which it is before anything else: a green "Sale" (money comes to us) or an amber
 * "Purchase" (money goes out), the colours of "They paid us" and "We paid them" (D-088); and
 * "Still owed" is owed *to us* on a sale and *by us* on a purchase, coloured to match.
 */
export function TradeTable({ rows, selection }: { rows: readonly TradeRow[]; selection?: RowSelection<TradeRow> }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const shown = (row: TradeRow) => shownOf(row, t, formatter.identifier);

  const kindChip = (row: TradeRow) => (
    <span className={`mz-trade-kind mz-trade-kind--${row.kind}`}>
      <Icon name={row.kind === 'sale' ? 'money-in' : 'money-out'} size={14} />
      {t(row.kind === 'sale' ? 'trade:kind_sale' : 'trade:kind_purchase')}
    </span>
  );

  const recorded = (row: TradeRow) => {
    const who = shown(row).recordedBy;
    return who ? (
      <span className="mz-caption">
        {t('trade:recorded_by')}: <bdi>{who}</bdi>
      </span>
    ) : null;
  };

  // Who took a sale (D-105), under the company it went to.
  const driven = (row: TradeRow) =>
    row.kind === 'sale' && row.driver_name ? (
      <span className="mz-caption" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
        <Icon name="drivers" size={12} />
        <bdi>{row.driver_name}</bdi>
      </span>
    ) : null;

  const total = (row: TradeRow) => {
    const s = shown(row);
    return s.total ? (
      <DualAmount amount_iqd={s.total.amount_iqd} amount_usd_cents={s.total.amount_usd_cents} primary={s.currency} />
    ) : (
      <span className="mz-muted">—</span>
    );
  };

  const owed = (row: TradeRow) => {
    const s = shown(row);
    if (s.owed === null || s.owed <= 0) return <span className="mz-muted">—</span>;
    return (
      <span className={row.kind === 'sale' ? 'mz-owed-in' : 'mz-owed-out'}>
        <DualAmount {...bothOf(s.owed, s.currency, s.rate)} primary={s.currency} kind="derived" />
      </span>
    );
  };

  const status = (row: TradeRow) => {
    const value = shown(row).status;
    if (value === null) return null;
    if (value === 'owes_nobody') return <Chip>{t('purchases:owes_nobody')}</Chip>;
    return <OrderStatusChip status={value} />;
  };

  const columns: Column<TradeRow>[] = [
    {
      header: t('common:number_column'),
      cell: (row) => (
        <span className="mz-cell__body">
          {kindChip(row)}
          <strong>{shown(row).number}</strong>
          <span className="mz-caption">{formatter.date(shown(row).date)}</span>
        </span>
      ),
    },
    {
      header: t('glossary:company'),
      cell: (row) => (
        <span className="mz-cell__body">
          {shown(row).company ? <bdi>{shown(row).company}</bdi> : <span className="mz-muted">{t('purchases:no_company')}</span>}
          {driven(row)}
          {recorded(row)}
        </span>
      ),
    },
    { header: t('glossary:total'), numeric: true, cell: total },
    { header: t('purchases:still_owed'), numeric: true, cell: owed },
    {
      header: t('glossary:payment_type'),
      secondary: true,
      cell: (row) =>
        row.kind === 'sale' ? <Chip>{t(`glossary:${row.payment_type}`)}</Chip> : <span className="mz-muted">—</span>,
    },
    { header: t('common:status'), cell: status },
  ];

  return (
    <DataList
      rows={rows}
      rowKey={(row) => `${row.kind}:${row.id}`}
      href={(row) => shown(row).href}
      columns={columns}
      selection={selection}
      rowLabel={(row) => shown(row).number}
      card={(row) => (
        <span className="mz-rowcard">
          <span className="mz-rowcard__head">
            <span className="mz-list__title">{shown(row).number}</span>
            <span className="mz-rowcard__chips">
              {kindChip(row)}
              {status(row)}
            </span>
          </span>
          <span className="mz-caption">
            {shown(row).company ? <bdi>{shown(row).company}</bdi> : t('purchases:no_company')}
            {' · '}
            {formatter.date(shown(row).date)}
          </span>
          {driven(row)}
          {recorded(row)}
          <span className="mz-rowcard__foot">
            {total(row)}
            {owed(row)}
          </span>
        </span>
      )}
    />
  );
}

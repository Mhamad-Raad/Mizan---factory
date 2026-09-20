import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Chip } from '@mizan/ui';
import type { Currency, Rate } from '@mizan/money';
import { DualAmount } from './DualAmount.js';
import { useFormatter } from '../lib/store.js';

export interface LedgerRow {
  kind: string;
  entry_id: string;
  entry_type: string;
  entry_date: string;
  amount_iqd: number;
  amount_usd_cents: number;
  entered_currency: Currency | null;
  rate_iqd_per_usd: Rate;
  balance_after: number;
  note: string | null;
  order_id: string | null;
  performed_by_name: string | null;
  voucher_number: number | null;
  received_currency: Currency | null;
  hidden_by_default: boolean;
  rows: {
    id: string;
    entry_type: string;
    entry_date: string;
    amount_iqd: number;
    amount_usd_cents: number;
    note: string | null;
    balance_after: number;
    performed_by_name: string | null;
  }[];
}

export interface LedgerListProps {
  items: LedgerRow[];
  settlement_currency: Currency;
  /** Rendered at the end of a row: a voucher action, a link to the order, a reversal. */
  actions?: (row: LedgerRow) => React.ReactNode;
}

/**
 * A customer's ledger, already grouped by the API per the presentation rules of 2.4.5: an
 * edited document is one row labelled "edited", a cash order is one row naming the currency
 * received, an undone pair is greyed. Expanding a group shows the rows behind it with who,
 * when and why — the append-only truth is never hidden, only calmed down.
 *
 * The running balance is the one the API computed in posting order, so it always equals the
 * before/after History recorded for that write (2.4.1 rule 5).
 */
export function LedgerList({ items, settlement_currency, actions }: LedgerListProps) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div>
      {items.map((row) => {
        const isMarker = row.kind === 'rebase';
        const isGroup = row.rows.length > 1;
        return (
          <div
            key={row.entry_id}
            className={`mz-ledger-row${row.kind === 'undone' ? ' mz-ledger-row--undone' : ''}${
              isMarker ? ' mz-ledger-row--marker' : ''
            }`}
          >
            <div>
              <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <strong>{t(`customers:entry.${row.entry_type}`)}</strong>
                {row.kind === 'edited' ? <Chip tone="warning">{t('customers:edited')}</Chip> : null}
                {row.kind === 'undone' ? <Chip>{t('customers:undone')}</Chip> : null}
                {row.kind === 'cash_order' && row.received_currency ? (
                  <Chip tone="primary">
                    {t('orders:paid_in_currency', { currency: t(`glossary:${row.received_currency.toLowerCase()}`) })}
                  </Chip>
                ) : null}
                {row.voucher_number !== null ? (
                  <span className="mz-caption">
                    {t('customers:voucher_number', { number: formatter.number(row.voucher_number) })}
                  </span>
                ) : null}
              </div>
              <span className="mz-caption" style={{ display: 'block' }}>
                {formatter.date(row.entry_date)}
                {row.performed_by_name ? ` · ${row.performed_by_name}` : ''}
              </span>
              {row.note ? <span className="mz-caption">{row.note}</span> : null}
              {isGroup ? (
                <button
                  type="button"
                  className="mz-button mz-button--ghost"
                  aria-expanded={expanded === row.entry_id}
                  onClick={() => setExpanded(expanded === row.entry_id ? null : row.entry_id)}
                >
                  {t('customers:show_rows', { count: row.rows.length })}
                </button>
              ) : null}
            </div>

            <div className="mz-ledger-row__amounts">
              <DualAmount
                amount_iqd={row.amount_iqd}
                amount_usd_cents={row.amount_usd_cents}
                primary={settlement_currency}
              />
              {!isMarker ? (
                <span className="mz-caption" style={{ display: 'block' }} data-tabular>
                  {t('glossary:running_balance')}:{' '}
                  {formatter.money(row.balance_after, settlement_currency)}
                </span>
              ) : null}
              {actions?.(row)}
            </div>

            {isGroup && expanded === row.entry_id ? (
              <ul className="mz-list" style={{ gridColumn: '1 / -1' }}>
                {row.rows.map((underlying) => (
                  <li key={underlying.id} className="mz-list__item">
                    <span className="mz-list__body">
                      <span className="mz-list__title">{t(`customers:entry.${underlying.entry_type}`)}</span>
                      <span className="mz-caption">
                        {formatter.date(underlying.entry_date)}
                        {underlying.performed_by_name ? ` · ${underlying.performed_by_name}` : ''}
                        {underlying.note ? ` · ${underlying.note}` : ''}
                      </span>
                    </span>
                    <DualAmount
                      amount_iqd={underlying.amount_iqd}
                      amount_usd_cents={underlying.amount_usd_cents}
                      primary={settlement_currency}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

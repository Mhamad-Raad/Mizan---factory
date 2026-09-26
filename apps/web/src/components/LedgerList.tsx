import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';
import { useLandedFirstRow } from '../lib/motion.js';
import { useTranslation } from 'react-i18next';
import { Chip } from '@mizan/ui';
import type { Currency, Rate } from '@mizan/money';
import { DualAmount } from './DualAmount.js';
import { useFormatter } from '../lib/store.js';
import { useIsWide } from '../lib/wide.js';

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
  actions?: (row: LedgerRow) => ReactNode;
  /**
   * Which catalog names the entry types. The two ledgers read differently in every language —
   * a customer's `payment` is money received, a company's is money paid — so the namespace is
   * the caller's choice and the component stays one component (spec 1.6, 2.4.2).
   */
  namespace?: 'customers' | 'companies';
  /**
   * Increment after a write that adds a row here, and the newest row carries the highlight for
   * 600 ms (signature moment 3: "the row lands", spec 3.6.2) — so somebody who has just
   * recorded a payment sees where it went instead of a blank success message.
   */
  landedVersion?: number;
}

/**
 * An account, read the way an accountant reads a statement: when, what, how much, and what the
 * balance was after it. A table on a desktop, a card per entry on a phone.
 *
 * The rows are grouped by the API per the presentation rules of 2.4.5: an edited document is
 * one row labelled "edited", a cash order is one row naming the currency received, an undone
 * pair is greyed. Expanding a group shows the rows behind it with who, when and why — the
 * append-only truth is never hidden, only calmed down.
 *
 * A negative amount — money that lowers the balance — and a negative balance read in red, and
 * a one-line key above the list says what that means on this side, because "−300,000" on a
 * customer's account and on a company's are the same sign for opposite pieces of news. The
 * running balance is the one the API computed in posting order, so it always equals the
 * before/after History recorded for that write (2.4.1 rule 5).
 */
export function LedgerList({
  items,
  settlement_currency,
  actions,
  namespace = 'customers',
  landedVersion = 0,
}: LedgerListProps) {
  const { t } = useTranslation();
  const wide = useIsWide();
  const [expanded, setExpanded] = useState<string | null>(null);
  const landedId = useLandedFirstRow(items[0]?.entry_id ?? null, landedVersion);
  const toggle = (id: string) => setExpanded(expanded === id ? null : id);

  const rowClass = (row: LedgerRow) =>
    [
      row.kind === 'undone' ? 'mz-ledger-row--undone' : '',
      row.kind === 'rebase' ? 'mz-ledger-row--marker' : '',
      row.entry_id === landedId ? 'mz-landed' : '',
    ]
      .filter(Boolean)
      .join(' ');

  return (
    <div className="mz-stack" style={{ gap: 'var(--space-2)' }}>
      <p className="mz-caption mz-ledger-key">
        <span className="mz-ledger-key__swatch" aria-hidden="true" />
        {t(`${namespace}:ledger_key`)}
      </p>

      {wide ? (
        <div className="mz-table-wrap">
          <table className="mz-table mz-ledger-table">
            <thead>
              <tr>
                <th scope="col">{t('common:date')}</th>
                <th scope="col">{t('customers:ledger_entry')}</th>
                <th scope="col" data-numeric="true">
                  {t('glossary:amount')}
                </th>
                <th scope="col" data-numeric="true">
                  {t('customers:balance_after')}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <Fragment key={row.entry_id}>
                  <tr className={rowClass(row)}>
                    <td data-tabular><EntryDate date={row.entry_date} /></td>
                    <td>
                      <EntryLabel
                        row={row}
                        namespace={namespace}
                        expanded={expanded === row.entry_id}
                        onToggle={() => toggle(row.entry_id)}
                      />
                    </td>
                    <td data-numeric="true">
                      <SignedAmount row={row} currency={settlement_currency} />
                      {actions?.(row)}
                    </td>
                    <td data-numeric="true">
                      {row.kind === 'rebase' ? null : <Balance amount={row.balance_after} currency={settlement_currency} />}
                    </td>
                  </tr>
                  {expanded === row.entry_id
                    ? row.rows.map((underlying) => (
                        <tr key={underlying.id} className="mz-ledger-table__underlying">
                          <td data-tabular>
                            <EntryDate date={underlying.entry_date} />
                          </td>
                          <td>
                            <span className="mz-caption">
                              {t(`${namespace}:entry.${underlying.entry_type}`)}
                              {underlying.performed_by_name ? ` · ${underlying.performed_by_name}` : ''}
                            </span>
                            {underlying.note ? (
                              <span className="mz-caption" style={{ display: 'block' }}>
                                <bdi>{underlying.note}</bdi>
                              </span>
                            ) : null}
                          </td>
                          <td data-numeric="true">
                            <SignedAmount row={underlying} currency={settlement_currency} />
                          </td>
                          <td data-numeric="true">
                            <Balance amount={underlying.balance_after} currency={settlement_currency} />
                          </td>
                        </tr>
                      ))
                    : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="mz-list">
          {items.map((row) => (
            <li key={row.entry_id} className={`mz-list__item mz-ledger-card ${rowClass(row)}`}>
              <div className="mz-ledger-card__main">
                <EntryLabel
                  row={row}
                  namespace={namespace}
                  expanded={expanded === row.entry_id}
                  onToggle={() => toggle(row.entry_id)}
                />
                <span className="mz-caption" data-tabular>
                  <EntryDate date={row.entry_date} />
                </span>
              </div>
              <div className="mz-ledger-card__money">
                <SignedAmount row={row} currency={settlement_currency} />
                {row.kind === 'rebase' ? null : (
                  <span className="mz-caption">
                    {t('customers:balance_after')}:{' '}
                    <Balance amount={row.balance_after} currency={settlement_currency} />
                  </span>
                )}
                {actions?.(row)}
              </div>
              {expanded === row.entry_id ? (
                <ul className="mz-list mz-ledger-card__underlying">
                  {row.rows.map((underlying) => (
                    <li key={underlying.id} className="mz-list__item mz-list__item--detail">
                      <span className="mz-list__body">
                        <span className="mz-list__title">{t(`${namespace}:entry.${underlying.entry_type}`)}</span>
                        <span className="mz-caption">
                          <EntryDate date={underlying.entry_date} />
                          {underlying.performed_by_name ? ` · ${underlying.performed_by_name}` : ''}
                        </span>
                      </span>
                      <span className="mz-list__end">
                        <SignedAmount row={underlying} currency={settlement_currency} />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EntryDate({ date }: { date: string }) {
  const formatter = useFormatter();
  return <>{formatter.date(date)}</>;
}

/** What the entry was, the chips that qualify it, who recorded it, and why. */
function EntryLabel({
  row,
  namespace,
  expanded,
  onToggle,
}: {
  row: LedgerRow;
  namespace: 'customers' | 'companies';
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  return (
    <span className="mz-cell__body">
      <span className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <strong>{t(`${namespace}:entry.${row.entry_type}`)}</strong>
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
      </span>
      {row.performed_by_name ? (
        <span className="mz-caption">
          <bdi>{row.performed_by_name}</bdi>
        </span>
      ) : null}
      {row.note ? (
        <span className="mz-caption">
          <bdi>{row.note}</bdi>
        </span>
      ) : null}
      {row.rows.length > 1 ? (
        <button type="button" className="mz-link-button" aria-expanded={expanded} onClick={onToggle}>
          {t('customers:show_rows', { count: row.rows.length })}
        </button>
      ) : null}
    </span>
  );
}

/** The entry's amount in both currencies, in red when it lowers the balance. */
function SignedAmount({
  row,
  currency,
}: {
  row: { amount_iqd: number; amount_usd_cents: number };
  currency: Currency;
}) {
  const settled = currency === 'IQD' ? row.amount_iqd : row.amount_usd_cents;
  return (
    <span className={settled < 0 ? 'mz-amount mz-amount--negative' : 'mz-amount'}>
      <DualAmount amount_iqd={row.amount_iqd} amount_usd_cents={row.amount_usd_cents} primary={currency} />
    </span>
  );
}

/** A running balance, in red when it has gone below zero. */
function Balance({ amount, currency }: { amount: number; currency: Currency }) {
  const formatter = useFormatter();
  return (
    <span className={amount < 0 ? 'mz-amount--negative' : undefined} data-tabular>
      {formatter.money(amount, currency)}
    </span>
  );
}

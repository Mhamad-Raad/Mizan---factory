import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, SegmentedControl } from '@mizan/ui';
import type { Currency, Rate } from '@mizan/money';
import { DualAmount } from './DualAmount.js';
import { MoneyInput } from './MoneyInput.js';
import type { MoneyValue } from './MoneyInput.js';
import { PickerSheet } from './PickerSheet.js';
import type { CustomerRow } from '../pages/CustomersPage.js';

/*
 * The two questions every buy asks (D-085) — who did we buy it from, and did we pay them now —
 * asked the same way wherever stock comes in: the purchase form, "Buy more" on a material, and a
 * new material's first purchase.
 */

/** Who a purchase is from: not chosen yet, or a company — always a company (D-087). */
export type CompanyChoice =
  | { kind: 'unset' }
  | { kind: 'company'; id: string; name: string; settlement_currency: Currency };

export function companyIdOf(choice: CompanyChoice): string | null {
  return choice.kind === 'company' ? choice.id : null;
}

/**
 * "Bought from": a button that opens the company picker. The business buys from companies
 * (D-085, D-087), so a purchase names one before it can be saved — on the purchase form, on a new
 * material and on "Buy more" alike — and what it cost goes on that company's account.
 */
export function CompanyField({
  value,
  onChange,
  error,
}: {
  value: CompanyChoice;
  onChange: (choice: CompanyChoice) => void;
  error?: string;
}) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  const label =
    value.kind === 'company' ? value.name : t('purchases:pick_company');

  return (
    <div className="mz-field">
      <span className="mz-field__label">{t('print:bought_from')}</span>
      <Button variant="secondary" block icon="companies" onClick={() => setPicking(true)}>
        <bdi>{label}</bdi>
      </Button>
      {error ? (
        <span className="mz-field__error" role="alert">
          {error}
        </span>
      ) : null}
      {picking ? (
        <PickerSheet
          title={t('purchases:pick_company')}
          open
          onClose={() => setPicking(false)}
          path="/customers"
          icon="companies"
          searchLabel={t('customers:search_placeholder')}
          emptyTitle={t('customers:empty')}
          // The walk-in customer is a till, never a supplier.
          exclude={(row: never) => (row as unknown as CustomerRow).is_system}
          toItem={(row: never) => {
            const company = row as unknown as CustomerRow;
            return {
              id: company.id,
              title: company.name,
              subtitle: company.phone ?? undefined,
              // What we owe them already, so the buyer sees it before adding to it.
              detail:
                company.payable && (company.payable.amount_iqd !== 0 || company.payable.amount_usd_cents !== 0) ? (
                  <span className="mz-picker__meta">
                    <span className="mz-caption">{t('companies:we_owe_them')} </span>
                    <DualAmount
                      amount_iqd={company.payable.amount_iqd}
                      amount_usd_cents={company.payable.amount_usd_cents}
                      primary={company.payable.currency}
                      kind="derived"
                    />
                  </span>
                ) : undefined,
            };
          }}
          onPick={(id, row) => {
            setPicking(false);
            const company = row as unknown as CustomerRow;
            onChange({ kind: 'company', id: company.id, name: company.name, settlement_currency: company.settlement_currency });
          }}
        />
      ) : null}
    </div>
  );
}

/** "Paid now": nothing (it is owed), all of it, or a part typed in either currency. */
export interface PaidNow {
  mode: 'none' | 'all' | 'part';
  amount: MoneyValue;
  /**
   * For "all of it": the currency the money went out in, which the cash-up counts (FR-1013). A
   * dinar company paid in dollars is recorded as dollars handed over, not as dinars (review).
   * Null until chosen: it then follows the company's own currency, whichever way the company was
   * reached — picked, or named by the link from its page (second review).
   */
  paidIn: Currency | null;
}

export const NOTHING_PAID: PaidNow = {
  mode: 'none',
  amount: { amount: null, currency: 'IQD', other_amount: null },
  paidIn: null,
};

/** The `paid` field of a purchase request, or null when nothing was paid now. */
export function paidNowBody(
  paid: PaidNow,
  /** The company's own currency, which "paid in" follows until somebody chooses. */
  accountCurrency: Currency,
): { in_full: true; currency: Currency } | { amount: number; currency: Currency; other_amount: number | null } | null {
  if (paid.mode === 'all') return { in_full: true, currency: paid.paidIn ?? accountCurrency };
  if (paid.mode === 'part' && paid.amount.amount !== null && paid.amount.amount > 0) {
    return { amount: paid.amount.amount, currency: paid.amount.currency, other_amount: paid.amount.other_amount ?? null };
  }
  return null;
}

/** Whether what was typed can be sent: a part needs an amount above zero. */
export function paidNowValid(paid: PaidNow): boolean {
  return paid.mode !== 'part' || (paid.amount.amount !== null && paid.amount.amount > 0);
}

/**
 * Did we pay them now? Shown only for a purchase from a company, and only to someone who may pay
 * companies — "nothing now" leaves it all owed, which the company's page then tracks until it is
 * paid back.
 */
export function PaidNowField({
  value,
  onChange,
  rate,
  accountCurrency,
  error,
}: {
  value: PaidNow;
  onChange: (value: PaidNow) => void;
  rate: Rate | null;
  /** The company's own currency, which "paid in" shows until somebody chooses. */
  accountCurrency: Currency;
  error?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="mz-stack" style={{ gap: 'var(--space-2)' }}>
      <SegmentedControl
        label={t('purchases:paid_now')}
        value={value.mode}
        onChange={(mode) => onChange({ ...value, mode })}
        options={[
          { value: 'none', label: t('purchases:paid_now_none') },
          { value: 'all', label: t('purchases:paid_now_all') },
          { value: 'part', label: t('purchases:paid_now_part') },
        ]}
      />
      {value.mode === 'all' ? (
        <SegmentedControl
          label={t('purchases:paid_in')}
          value={value.paidIn ?? accountCurrency}
          onChange={(paidIn) => onChange({ ...value, paidIn })}
          options={[
            { value: 'IQD', label: t('glossary:iqd') },
            { value: 'USD', label: t('glossary:usd') },
          ]}
        />
      ) : null}
      {value.mode === 'part' ? (
        <MoneyInput
          label={t('purchases:paid_now_amount')}
          value={value.amount}
          rate={rate}
          onChange={(amount) => onChange({ ...value, amount })}
          error={error}
        />
      ) : error ? (
        <span className="mz-field__error" role="alert">
          {error}
        </span>
      ) : null}
      <span className="mz-field__hint">
        {t(value.mode === 'none' ? 'purchases:paid_now_none_hint' : 'purchases:paid_now_hint')}
      </span>
    </div>
  );
}

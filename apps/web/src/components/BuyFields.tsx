import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Chip, NumberField, SegmentedControl } from '@mizan/ui';
import type { Currency, Rate, RateSource } from '@mizan/money';
import { DualAmount } from './DualAmount.js';
import { MoneyInput } from './MoneyInput.js';
import type { MoneyValue } from './MoneyInput.js';
import { PickerSheet } from './PickerSheet.js';
import type { CustomerRow } from '../pages/CustomersPage.js';
import { useDocumentRate } from '../lib/accounts.js';
import { usableRate } from '../lib/money.js';
import { useFormatter } from '../lib/store.js';

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

/** A stored rate as a field shows it: "1312.0000" → "1312", "1305.5000" → "1305.5". */
export function rateInputText(rate: Rate): string {
  return rate.includes('.') ? rate.replace(/\.?0+$/, '') : rate;
}

export interface BuyRate {
  /** The rate the buy is valued at: one typed for it, else the company's own, else the system's. */
  rate: Rate | null;
  source: RateSource;
  /** What the money fields say under their conversion. */
  label: string;
  /**
   * What the request sends: a rate typed for this buy that differs from the default, else null —
   * the server then applies the company's or the system's rate itself and records it as such.
   */
  body: Rate | null;
  invalid: boolean;
  /** The rate the box opens with, and where it is from. */
  fallback: { rate: Rate | null; source: RateSource };
  text: string;
  setText: (text: string) => void;
  restore: () => void;
}

/**
 * The rate of a buy (D-092) or an order (D-101): its box opens filled with the company's own rate,
 * or the system's when the company has none, and may be changed for this document alone. Typing
 * the default back, or clearing the box, is the default again — never a "typed" rate that happens
 * to match. `held` lets a form keep what was typed in its own state (the order form's draft):
 * '' there is "not changed".
 */
export function useBuyRate(
  account: CustomerRow | undefined,
  typedLabel: string,
  held?: { text: string; setText: (text: string) => void },
): BuyRate {
  const [own, setOwn] = useState<string | null>(null);
  const edited = held ? (held.text === '' ? null : held.text) : own;
  const setEdited = held ? (text: string | null) => held.setText(text ?? '') : setOwn;
  const fallback = useDocumentRate(account);
  const typed = edited === null ? null : usableRate(edited);
  const differs = typed !== null && (fallback.rate === null || Number(typed) !== Number(fallback.rate));
  const chosen = useDocumentRate(account, { rate: differs ? typed : null, label: typedLabel });
  return {
    rate: chosen.rate,
    source: chosen.source,
    label: chosen.label,
    body: differs ? typed : null,
    invalid: edited !== null && edited.trim() !== '' && typed === null,
    fallback: { rate: fallback.rate, source: fallback.source },
    text: edited ?? (fallback.rate === null ? '' : rateInputText(fallback.rate)),
    setText: setEdited,
    restore: () => setEdited(null),
  };
}

/**
 * The rate box of a buy (D-092), with a tag saying where its figure is from: the company's rate,
 * the system's, or one changed for this buy — and, once changed, what it would otherwise be.
 */
export function BuyRateField({ state, label }: { state: BuyRate; label: string }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const changed = state.body !== null;
  const badge = changed ? (
    <Chip tone="warning">{t('purchases:rate_badge_changed')}</Chip>
  ) : state.fallback.source === 'company' ? (
    <Chip tone="primary">{t('purchases:rate_badge_company')}</Chip>
  ) : state.fallback.rate !== null ? (
    <Chip>{t('purchases:rate_badge_system')}</Chip>
  ) : null;
  const hint =
    state.fallback.rate === null
      ? t('common:no_rate_set')
      : changed
        ? t(state.fallback.source === 'company' ? 'purchases:rate_was_company' : 'purchases:rate_was_system', {
            rate: formatter.rate(state.fallback.rate),
          })
        : undefined;
  return (
    <NumberField
      label={label}
      badge={badge}
      hint={hint}
      decimals={4}
      error={state.invalid ? t('common:rate_invalid') : undefined}
      value={state.text}
      onChange={(event) => state.setText(event.target.value)}
      // An emptied box goes back to the default rather than staying blank.
      onBlur={() => {
        if (state.text.trim() === '') state.restore();
      }}
    />
  );
}

import type { Currency, Rate } from '@mizan/money';
import { bothOf } from './money.js';

/** One figure of what we owe: the amount in its own currency, and the other side when a rate exists. */
export interface OwedFigure {
  primary: Currency;
  amount: number;
  /** Both sides, the other at the rate; null without a rate — the other side is never invented. */
  pair: { amount_iqd: number; amount_usd_cents: number } | null;
}

/**
 * What we owe the companies as figures to show (D-085): the dinar companies in dinars and the
 * dollar companies in dollars, each only when there is any, and one dinar zero when there is
 * nothing at all — never one sum of both currencies (review, lesson 4).
 */
export function owedFigures(owed: { amount_iqd: number; amount_usd_cents: number }, rate: Rate | null): OwedFigure[] {
  const figure = (amount: number, primary: Currency): OwedFigure => ({
    primary,
    amount,
    pair: rate === null ? null : bothOf(amount, primary, rate),
  });
  const figures = [
    ...(owed.amount_iqd !== 0 ? [figure(owed.amount_iqd, 'IQD')] : []),
    ...(owed.amount_usd_cents !== 0 ? [figure(owed.amount_usd_cents, 'USD')] : []),
  ];
  return figures.length > 0 ? figures : [figure(0, 'IQD')];
}

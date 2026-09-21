import { computeLineTotals, priceSideOf, roundHalfAwayFromZero, Decimal } from '@mizan/money';
import type {
  Currency,
  LineTotals,
  Measure,
  MonthPriceRow,
  MonthPriceSelection,
  PriceSource,
  Quantity,
  Rate,
  RateSource,
} from '@mizan/money';

/**
 * The rules of a damage record (FR-801 to FR-807, A-30, A-31, A-39).
 *
 * Four decisions live here rather than in the API, because all four are asked in more than one
 * place — the form's "what will this do to stock?" sentence, the write path, the return sheet
 * and the list's totals — and because every one of them is a rule the client may change:
 *
 *   · what damage does to stock, which depends only on the attribution (A-30);
 *   · what the return status is at the start and after each action (FR-803);
 *   · what the damage was worth, snapshotted from the month's bought price (FR-807);
 *   · what a return to a supplier is worth, from the purchase line it arrived on (A-39).
 */

export type DamageAttribution = 'none' | 'customer_order' | 'us' | 'company';
export type StockEffect = 'reduced' | 'none' | 'returned_in';
export type ReturnStatus = 'not_returnable' | 'pending' | 'returned' | 'returned_credited' | 'written_off';

/**
 * What a damage record does to stock (A-30, 2.5.1).
 *
 * Goods attributed to a customer order left stock when they were sold, so recording them as
 * damaged must not remove them twice; everything else was in the yard and is now not.
 */
export function stockEffectOf(attribution: DamageAttribution): 'reduced' | 'none' {
  return attribution === 'customer_order' ? 'none' : 'reduced';
}

/** The status a new record starts in: goods that cannot go back are never "pending" (FR-803). */
export function initialReturnStatus(isReturnable: boolean): ReturnStatus {
  return isReturnable ? 'pending' : 'not_returnable';
}

export type ReturnAction = 'returned' | 'written_off' | 'credited';

export class ReturnNotAllowedError extends Error {
  constructor(
    public readonly from: ReturnStatus,
    public readonly action: ReturnAction,
  ) {
    super(`a damage record that is "${from}" cannot be marked "${action}"`);
    this.name = 'ReturnNotAllowedError';
  }
}

/**
 * The return status machine of FR-803: Pending → Returned (→ Credited when a company credit
 * was recorded), or Written off.
 *
 * Goods that were never returnable have no path at all — marking them returned would claim a
 * supplier took back something the record says cannot go back — and both ends are terminal, so
 * a second credit on the same record is refused rather than silently ignored.
 */
export function nextReturnStatus(current: ReturnStatus, action: ReturnAction): ReturnStatus {
  if (current === 'not_returnable') throw new ReturnNotAllowedError(current, action);

  if (action === 'written_off') {
    if (current !== 'pending') throw new ReturnNotAllowedError(current, action);
    return 'written_off';
  }

  if (action === 'returned') {
    if (current !== 'pending') throw new ReturnNotAllowedError(current, action);
    return 'returned';
  }

  // A credit may arrive with the return ("Mark returned and record credit") or later, from a
  // record already marked returned.
  if (current !== 'pending' && current !== 'returned') throw new ReturnNotAllowedError(current, action);
  return 'returned_credited';
}

export interface DamageQuantity extends Quantity {
  /** The material's pricing unit: the measure the value is computed from (FR-302). */
  priced_measure: Measure;
}

export interface DamageValue {
  est_value_iqd: number | null;
  est_value_usd_cents: number | null;
  est_value_source: PriceSource;
  /** The month the price came from, for the "from July" marker on the list (FR-306). */
  from_month: string | null;
}

/**
 * What a damage record was worth (FR-807).
 *
 * It is a **snapshot**, and it copies the month's bought-price *pair as stored* — both sides
 * multiplied by the quantity — rather than converting one side at today's rate, for the same
 * reason an order line's cost snapshot does (A-42): the value of what a period lost must be
 * reproducible from what was true in that month, and editing a past month's price later must
 * not move it. When no month has a bought price the value is unknown, not zero.
 */
export function damageValue(quantity: DamageQuantity, selection: MonthPriceSelection): DamageValue {
  if (!selection.row || !selection.value) {
    return { est_value_iqd: null, est_value_usd_cents: null, est_value_source: 'none', from_month: null };
  }
  const priced = pricedAmount(quantity);
  return {
    est_value_iqd: roundHalfAwayFromZero(new Decimal(selection.value.amount_iqd).times(priced)),
    est_value_usd_cents: roundHalfAwayFromZero(new Decimal(selection.value.amount_usd_cents).times(priced)),
    est_value_source: selection.source,
    from_month: selection.from_month,
  };
}

export interface DamageCreditPrice {
  unit_price_iqd: number;
  unit_price_usd_cents: number;
  /** The side that was typed; the other is filled at the company's rate (2.3.4). */
  price_entered_currency: Currency;
  /** Where the price came from, for the sheet to say so. */
  source: 'purchase_line' | 'month' | 'fallback';
  from_month: string | null;
}

/**
 * The price a supplier credit is pre-filled from (A-39, FR-805): the bought price on the
 * purchase line the goods arrived on, else the month's bought price. Null when neither exists,
 * which leaves the accountant to type the amount — the sheet lets them, because a supplier who
 * takes goods back agrees a figure whatever our price list says.
 */
export function damageCreditPrice(input: {
  purchase_line?: {
    unit_price_iqd: number;
    unit_price_usd_cents: number;
    price_entered_currency: Currency;
  } | null;
  month_price?: MonthPriceSelection | null;
}): DamageCreditPrice | null {
  if (input.purchase_line) {
    return {
      unit_price_iqd: input.purchase_line.unit_price_iqd,
      unit_price_usd_cents: input.purchase_line.unit_price_usd_cents,
      price_entered_currency: input.purchase_line.price_entered_currency,
      source: 'purchase_line',
      from_month: null,
    };
  }
  const selection = input.month_price;
  if (!selection?.row || !selection.value) return null;
  return {
    unit_price_iqd: selection.value.amount_iqd,
    unit_price_usd_cents: selection.value.amount_usd_cents,
    price_entered_currency: selection.value.entered_currency,
    source: selection.source === 'fallback' ? 'fallback' : 'month',
    from_month: selection.from_month,
  };
}

/**
 * The credit a return is worth: quantity × that price, by the entered-currency rule at **the
 * company's** rate (2.3.4, 2.3.3). The typed side is multiplied and the other side follows from
 * the total, so 4 kg at 5,900 د.ع is 23,600 د.ع ≈ $18.02 at 1,310 — not four times a rounded
 * dollar unit price.
 */
export function damageCreditValue(
  quantity: DamageQuantity,
  price: DamageCreditPrice,
  rate: Rate,
  rateSource: RateSource,
): LineTotals {
  return computeLineTotals({
    priced_measure: quantity.priced_measure,
    qty_count: quantity.qty_count ?? null,
    qty_kg: quantity.qty_kg ?? null,
    unit_price_iqd: price.unit_price_iqd,
    unit_price_usd_cents: price.unit_price_usd_cents,
    price_entered_currency: price.price_entered_currency,
    document_rate: rate,
    document_rate_source: rateSource,
  });
}

/** The quantity that drives the value, exactly as the price list measures it. */
function pricedAmount(quantity: DamageQuantity): Decimal {
  if (quantity.priced_measure === 'count') {
    if (quantity.qty_count === null || quantity.qty_count === undefined) {
      throw new RangeError('a material priced per piece needs a count to be valued');
    }
    return new Decimal(quantity.qty_count);
  }
  if (quantity.qty_kg === null || quantity.qty_kg === undefined) {
    throw new RangeError('a material priced per kg needs a weight to be valued');
  }
  return new Decimal(quantity.qty_kg);
}

/** Re-exported so a caller needs one import to value a damage from price rows. */
export type { MonthPriceRow };
export { priceSideOf };

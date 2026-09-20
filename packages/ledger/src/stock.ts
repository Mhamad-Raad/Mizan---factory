import { Decimal } from '@mizan/money';
import type { Measure } from '@mizan/money';

/**
 * The stock model (spec 2.5, FR-303, FR-608). Stock is the sum of an item's movements in its
 * priced measure — never an edited column — and the *other* measure is summed only while
 * every movement carried it, because a partial sum would be a wrong number on a screen.
 */

export type StockMovementType =
  | 'purchase_in'
  | 'sale_out'
  | 'damage_out'
  | 'return_in'
  | 'opening'
  | 'adjustment'
  | 'reversal';

/** A row of `stock_ledger`. `null` means "this movement did not carry that measure". */
export interface StockMovement {
  id: string;
  item_id: string;
  movement_type: StockMovementType;
  qty_count: number | null;
  /** Kilograms with three decimals, carried as a string so it never becomes a float. */
  qty_kg: string | null;
  posting_seq: number;
  entry_date: string;
  ref_type?: 'purchase_line' | 'order_line' | 'damage' | 'manual' | null;
  ref_id?: string | null;
  reverses_entry_id: string | null;
}

export interface NewStockMovement {
  item_id: string;
  movement_type: StockMovementType;
  qty_count: number | null;
  qty_kg: string | null;
  entry_date: string;
  created_by: string;
  ref_type?: 'purchase_line' | 'order_line' | 'damage' | 'manual' | null;
  ref_id?: string | null;
  reverses_entry_id?: string | null;
  unit_cost_iqd?: number | null;
  unit_cost_usd_cents?: number | null;
  note?: string | null;
}

export interface ItemStock {
  stock_count: number;
  /** Kilograms as a string with three decimals, like every kg value that crosses a boundary. */
  stock_kg: string;
  /** False when at least one movement did not carry that measure, so it shows "—". */
  count_complete: boolean;
  kg_complete: boolean;
}

/** Movement types that require a note (spec 2.2.3 `stock_ledger`). */
export const STOCK_NOTE_REQUIRED_TYPES: readonly StockMovementType[] = ['opening', 'adjustment', 'reversal'];

/**
 * The item's stock, exactly as the `item_stock` view computes it (spec 2.2.6), so the kernel
 * tests and the database cannot drift apart.
 */
export function stockOf(movements: readonly StockMovement[]): ItemStock {
  let count = 0;
  let kg = new Decimal(0);
  let countComplete = true;
  let kgComplete = true;

  for (const movement of movements) {
    if (movement.qty_count === null) countComplete = false;
    else count += movement.qty_count;
    if (movement.qty_kg === null) kgComplete = false;
    else kg = kg.plus(new Decimal(movement.qty_kg));
  }

  return {
    stock_count: count,
    stock_kg: kg.toFixed(3),
    count_complete: countComplete,
    kg_complete: kgComplete,
  };
}

/** The figure the material card leads with: the sum of the *priced* measure (FR-303). */
export function pricedStock(
  stock: ItemStock,
  pricingUnit: 'per_piece' | 'per_kg',
): { measure: Measure; quantity: string; complete: boolean } {
  return pricingUnit === 'per_piece'
    ? { measure: 'count', quantity: String(stock.stock_count), complete: stock.count_complete }
    : { measure: 'kg', quantity: stock.stock_kg, complete: stock.kg_complete };
}

/** The same one-pass shape as the ledger's, for the same reason (I2 review). */
export function reversedMovementIds(all: readonly StockMovement[]): ReadonlySet<string> {
  const reversed = new Set<string>();
  for (const movement of all) {
    if (movement.reverses_entry_id) reversed.add(movement.reverses_entry_id);
  }
  return reversed;
}

/** A movement is live while nothing reverses it; only live movements are reversed (2.5.3). */
export function isLiveMovement(
  movement: StockMovement,
  all: readonly StockMovement[] | ReadonlySet<string>,
): boolean {
  if (movement.movement_type === 'reversal') return false;
  const reversed = all instanceof Set ? all : reversedMovementIds(all as readonly StockMovement[]);
  return !reversed.has(movement.id);
}

export function liveMovements(all: readonly StockMovement[]): StockMovement[] {
  const reversed = reversedMovementIds(all);
  return all.filter((movement) => movement.movement_type !== 'reversal' && !reversed.has(movement.id));
}

/**
 * The reversal of a movement: the exact negation, so movement + reversal = 0 in both measures
 * and the item's stock returns to what it was (2.5.1, 2.5.3 step 2). A measure the original
 * did not carry stays `null` — negating it as 0 would silently make the item's other measure
 * "complete" and produce a wrong figure on the card.
 */
export function reversalOfMovement(
  movement: StockMovement,
  options: { created_by: string; note: string; entry_date?: string },
): NewStockMovement {
  if (movement.movement_type === 'reversal') {
    throw new Error('a reversal movement cannot itself be reversed');
  }
  if (!options.note?.trim()) throw new Error('a stock reversal requires a note');

  return {
    item_id: movement.item_id,
    movement_type: 'reversal',
    qty_count: movement.qty_count === null ? null : -movement.qty_count,
    qty_kg: movement.qty_kg === null ? null : new Decimal(movement.qty_kg).negated().toFixed(3),
    entry_date: options.entry_date ?? movement.entry_date,
    created_by: options.created_by,
    ref_type: movement.ref_type ?? null,
    ref_id: movement.ref_id ?? null,
    reverses_entry_id: movement.id,
    note: options.note,
  };
}

export type StockCheck =
  | { kind: 'ok' }
  /** Selling below stock is allowed with a warning on the line (A-34, FR-303). */
  | { kind: 'warn'; available: string; requested: string; measure: Measure }
  /** `allow_negative_stock = false`: the save is refused naming the item and what is left. */
  | { kind: 'refuse'; available: string; requested: string; measure: Measure };

/**
 * "Stock is 12, you are selling 15" (FR-303). Warn and allow by default; refuse when the
 * admin turned `allow_negative_stock` off (A-34). The check is on the *priced* measure,
 * because that is the one that is complete by construction.
 */
export function checkStockForSale(input: {
  available: string | number;
  requested: string | number;
  measure: Measure;
  allow_negative: boolean;
  /** False when the measure is not summable for this item, so no check is possible (FR-303). */
  complete?: boolean;
}): StockCheck {
  if (input.complete === false) return { kind: 'ok' };
  const available = new Decimal(input.available);
  const requested = new Decimal(input.requested);
  if (requested.lessThanOrEqualTo(available)) return { kind: 'ok' };

  const decimals = input.measure === 'kg' ? 3 : 0;
  const detail = {
    available: available.toFixed(decimals),
    requested: requested.toFixed(decimals),
    measure: input.measure,
  };
  return input.allow_negative ? { kind: 'warn', ...detail } : { kind: 'refuse', ...detail };
}

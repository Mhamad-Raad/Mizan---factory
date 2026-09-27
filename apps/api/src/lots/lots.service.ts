import { Injectable } from '@nestjs/common';
import { Decimal, roundHalfAwayFromZero } from '@mizan/money';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';

/**
 * What a sale or a damage took from the buys (D-062).
 *
 * Every buy — a purchase line: a material, how much came in, and what each unit cost in both
 * currencies — is a lot. Stock leaves the oldest lot first, so bottles bought at $1.00 go out
 * before the ones bought at $1.50, and the line that sold them costs exactly what they cost us.
 * The allocations are append-only: giving stock back (an order edited or voided, a damage paid
 * back in materials) is a row with the opposite quantity, so what is left of a buy is always the
 * sum of what came in less what the allocations still hold.
 */

export type LotRefType = 'order_line' | 'damage';

export interface Lot {
  purchase_line_id: string;
  purchase_id: string;
  purchase_number: number;
  bought_on: string;
  /** In the material's priced measure (pieces, or kilograms with three decimals). */
  quantity: string;
  /** What sales and damages have taken from it so far, net of what was given back. */
  taken: string;
  remaining: string;
  unit_cost_iqd: number;
  unit_cost_usd_cents: number;
  /** What the whole buy cost, as stored — a take is costed as its share of these (rule 1). */
  line_total_iqd: number;
  line_total_usd_cents: number;
  entered_currency: 'IQD' | 'USD';
  rate_iqd_per_usd: string;
}

export interface Take {
  purchase_line_id: string;
  qty: string;
  cost_iqd: number;
  cost_usd_cents: number;
}

export interface Plan {
  takes: Take[];
  /** What the taken stock cost, summed per take — never an average times the quantity. */
  cost_total_iqd: number;
  cost_total_usd_cents: number;
  /** False when no buy of this material exists at all: the line then has no cost. */
  costed: boolean;
}

const QTY_SCALE = 3;

@Injectable()
export class LotsService {
  constructor(private readonly database: Database) {}

  /**
   * The lots of a material, oldest first, with what is left of each. Read under the material's
   * row lock when `tx` is a writing transaction (see `plan`), so two sales cannot take the same
   * stock.
   */
  async lotsOf(itemId: string, tx?: Db): Promise<Lot[]> {
    // `item_lots` (migration 0030) trims what the buys hold to the stock on hand, oldest first,
    // so stock that left without a buy (a sale past every buy, a correction) is not sold twice.
    const { rows } = await (tx ?? this.database).query<{
      purchase_line_id: string;
      purchase_id: string;
      purchase_number: string;
      bought_on: string;
      quantity: string;
      taken: string;
      remaining: string;
      unit_cost_iqd: string;
      unit_cost_usd_cents: string;
      line_total_iqd: string;
      line_total_usd_cents: string;
      entered_currency: 'IQD' | 'USD';
      rate_iqd_per_usd: string;
    }>(
      `SELECT purchase_line_id, purchase_id, purchase_number::text AS purchase_number,
              to_char(purchase_date, 'YYYY-MM-DD') AS bought_on,
              quantity::text AS quantity, taken::text AS taken, remaining::text AS remaining,
              unit_price_iqd::text AS unit_cost_iqd, unit_price_usd_cents::text AS unit_cost_usd_cents,
              line_total_iqd::text AS line_total_iqd, line_total_usd_cents::text AS line_total_usd_cents,
              price_entered_currency::text AS entered_currency, rate_iqd_per_usd::text AS rate_iqd_per_usd
         FROM item_lots
        WHERE item_id = $1
        ORDER BY purchase_date, purchase_number, line_no`,
      [itemId],
    );
    return rows.map((row) => ({
      purchase_line_id: row.purchase_line_id,
      purchase_id: row.purchase_id,
      purchase_number: Number(row.purchase_number),
      bought_on: row.bought_on,
      quantity: new Decimal(row.quantity).toFixed(QTY_SCALE),
      taken: new Decimal(row.taken).toFixed(QTY_SCALE),
      remaining: new Decimal(row.remaining).toFixed(QTY_SCALE),
      unit_cost_iqd: Number(row.unit_cost_iqd),
      unit_cost_usd_cents: Number(row.unit_cost_usd_cents),
      line_total_iqd: Number(row.line_total_iqd),
      line_total_usd_cents: Number(row.line_total_usd_cents),
      entered_currency: row.entered_currency,
      rate_iqd_per_usd: row.rate_iqd_per_usd,
    }));
  }

  /**
   * Locks the rows of the given materials, always in the same order. A document that sells or
   * breaks several materials takes every lock up front, sorted, so two documents naming the
   * same materials in a different order wait for each other instead of deadlocking (review).
   */
  async lockItems(tx: Db, itemIds: readonly string[]): Promise<void> {
    const ids = [...new Set(itemIds)].sort();
    if (ids.length === 0) return;
    await tx.query('SELECT id FROM items WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
  }

  /**
   * Which lots a quantity would come from, oldest first, and what it costs.
   *
   * `pending` is what earlier lines of the same document already planned to take, so two lines
   * of one order selling the same bottles do not both take the oldest ones. The material's row is
   * locked first: the plan and the record that follows it are one decision.
   *
   * Selling past every buy (negative stock is a warning, not a refusal — A-34) costs the rest at
   * the latest buy's price, the nearest honest figure for stock that was never recorded as bought.
   */
  async plan(tx: Db, itemId: string, quantity: string, pending: Map<string, Decimal> = new Map()): Promise<Plan> {
    await tx.query('SELECT id FROM items WHERE id = $1 FOR UPDATE', [itemId]);
    const lots = await this.lotsOf(itemId, tx);
    if (lots.length === 0) return { takes: [], cost_total_iqd: 0, cost_total_usd_cents: 0, costed: false };

    let wanted = new Decimal(quantity);
    const takes: Take[] = [];
    for (const lot of lots) {
      if (wanted.lte(0)) break;
      const left = new Decimal(lot.remaining).minus(pending.get(lot.purchase_line_id) ?? 0);
      if (left.lte(0)) continue;
      const qty = Decimal.min(left, wanted);
      const before = new Decimal(lot.taken).plus(pending.get(lot.purchase_line_id) ?? 0);
      takes.push(this.take(lot, qty, before));
      wanted = wanted.minus(qty);
    }
    if (wanted.gt(0)) {
      // Nothing left in any buy: the latest buy's price stands in, with no allocation row.
      const latest = lots[lots.length - 1] as Lot;
      const extra = this.take(latest, wanted, null);
      takes.push({ ...extra, purchase_line_id: '' });
    }

    for (const take of takes) {
      if (!take.purchase_line_id) continue;
      pending.set(take.purchase_line_id, (pending.get(take.purchase_line_id) ?? new Decimal(0)).plus(take.qty));
    }
    return {
      takes,
      cost_total_iqd: takes.reduce((sum, take) => sum + take.cost_iqd, 0),
      cost_total_usd_cents: takes.reduce((sum, take) => sum + take.cost_usd_cents, 0),
      costed: true,
    };
  }

  /** Writes a plan's takes against the line or damage that made them. */
  async record(tx: Db, plan: Plan, ref: { type: LotRefType; id: string; itemId: string; createdBy: string }): Promise<void> {
    for (const take of plan.takes) {
      if (!take.purchase_line_id) continue;
      await tx.query(
        `INSERT INTO lot_allocations (purchase_line_id, item_id, qty, ref_type, ref_id, created_by)
         VALUES ($1, $2, $3::numeric, $4, $5, $6)`,
        [take.purchase_line_id, ref.itemId, take.qty, ref.type, ref.id, ref.createdBy],
      );
    }
  }

  /**
   * Gives back everything the given lines or damages still hold: one negative row per lot, so the
   * stock returns to the very buys it came from, at their prices.
   */
  async release(tx: Db, ref: { type: LotRefType; ids: readonly string[]; createdBy: string }): Promise<void> {
    if (ref.ids.length === 0) return;
    await tx.query(
      `INSERT INTO lot_allocations (purchase_line_id, item_id, qty, ref_type, ref_id, created_by)
       SELECT purchase_line_id, item_id, -sum(qty), ref_type, ref_id, $3
         FROM lot_allocations
        WHERE ref_type = $1 AND ref_id = ANY($2::uuid[])
        GROUP BY purchase_line_id, item_id, ref_type, ref_id
       HAVING sum(qty) <> 0`,
      [ref.type, ref.ids, ref.createdBy],
    );
  }

  /** True when any of these buys has stock out in a sale or a damage — it can no longer be undone. */
  async anyTaken(tx: Db, purchaseLineIds: readonly string[]): Promise<boolean> {
    if (purchaseLineIds.length === 0) return false;
    const { rows } = await tx.query<{ taken: boolean }>(
      `SELECT coalesce(sum(qty), 0) <> 0 AS taken FROM lot_allocations WHERE purchase_line_id = ANY($1::uuid[])`,
      [purchaseLineIds],
    );
    return Boolean(rows[0]?.taken);
  }

  /**
   * A quantity of one lot, costed as its share of what the whole buy cost, in both currencies
   * (rule 1) — not a rounded unit price times the quantity, which on 5,000 kg drifts by dollars.
   *
   * With `before` (what was taken from the lot already) the share is the difference of two
   * cumulative figures, each rounded once, so every take of a buy together costs exactly the
   * buy — three pieces of a 1,000 dinar buy cost 333, 334 and 333, never 999 (review). Stock
   * sold past every buy has no place in the lot and is costed as a plain share.
   */
  private take(lot: Lot, qty: Decimal, before: Decimal | null): Take {
    const costOf = (quantity: Decimal, total: number): number =>
      roundHalfAwayFromZero(quantity.dividedBy(lot.quantity).times(total));
    const cost = (total: number): number =>
      before === null ? costOf(qty, total) : costOf(before.plus(qty), total) - costOf(before, total);
    return {
      purchase_line_id: lot.purchase_line_id,
      qty: qty.toFixed(QTY_SCALE),
      cost_iqd: cost(lot.line_total_iqd),
      cost_usd_cents: cost(lot.line_total_usd_cents),
    };
  }
}

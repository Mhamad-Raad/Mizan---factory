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
  remaining: string;
  unit_cost_iqd: number;
  unit_cost_usd_cents: number;
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
    const { rows } = await (tx ?? this.database).query<{
      purchase_line_id: string;
      purchase_id: string;
      purchase_number: string;
      bought_on: string;
      quantity: string;
      taken: string;
      unit_cost_iqd: string;
      unit_cost_usd_cents: string;
      entered_currency: 'IQD' | 'USD';
      rate_iqd_per_usd: string;
    }>(
      `SELECT l.id AS purchase_line_id, p.id AS purchase_id, p.number::text AS purchase_number,
              to_char(p.purchase_date, 'YYYY-MM-DD') AS bought_on,
              (CASE WHEN l.priced_measure = 'count' THEN l.qty_count::numeric ELSE l.qty_kg END)::text AS quantity,
              coalesce(a.taken, 0)::text AS taken,
              l.unit_price_iqd::text AS unit_cost_iqd, l.unit_price_usd_cents::text AS unit_cost_usd_cents,
              l.price_entered_currency::text AS entered_currency, l.rate_iqd_per_usd::text AS rate_iqd_per_usd
         FROM purchase_lines l
         JOIN purchases p ON p.id = l.purchase_id
         LEFT JOIN LATERAL (
           SELECT sum(qty) AS taken FROM lot_allocations WHERE purchase_line_id = l.id
         ) a ON true
        WHERE l.item_id = $1 AND l.deleted_at IS NULL AND p.status = 'active' AND p.deleted_at IS NULL
        ORDER BY p.purchase_date, p.number, l.line_no`,
      [itemId],
    );
    return rows.map((row) => ({
      purchase_line_id: row.purchase_line_id,
      purchase_id: row.purchase_id,
      purchase_number: Number(row.purchase_number),
      bought_on: row.bought_on,
      quantity: new Decimal(row.quantity).toFixed(QTY_SCALE),
      remaining: new Decimal(row.quantity).minus(row.taken).toFixed(QTY_SCALE),
      unit_cost_iqd: Number(row.unit_cost_iqd),
      unit_cost_usd_cents: Number(row.unit_cost_usd_cents),
      entered_currency: row.entered_currency,
      rate_iqd_per_usd: row.rate_iqd_per_usd,
    }));
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
      takes.push(this.take(lot, qty));
      wanted = wanted.minus(qty);
    }
    if (wanted.gt(0)) {
      // Nothing left in any buy: the latest buy's price stands in, with no allocation row.
      const latest = lots[lots.length - 1] as Lot;
      const extra = this.take(latest, wanted);
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

  /** A quantity of one lot, costed in both currencies from the lot's own stored pair (rule 1). */
  private take(lot: Lot, qty: Decimal): Take {
    return {
      purchase_line_id: lot.purchase_line_id,
      qty: qty.toFixed(QTY_SCALE),
      cost_iqd: roundHalfAwayFromZero(new Decimal(lot.unit_cost_iqd).times(qty)),
      cost_usd_cents: roundHalfAwayFromZero(new Decimal(lot.unit_cost_usd_cents).times(qty)),
    };
  }
}

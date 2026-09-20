import { Injectable } from '@nestjs/common';
import { checkStockForSale, liveMovements, pricedStock, reversalOfMovement, stockOf } from '@mizan/ledger';
import type { ItemStock, NewStockMovement, StockMovement } from '@mizan/ledger';
import type { Measure } from '@mizan/money';
import { ApiError } from '../common/errors.js';
import type { Db } from '../database/pool.js';
import { SettingsService } from '../settings/settings.service.js';

interface StockRow {
  id: string;
  item_id: string;
  movement_type: string;
  qty_count: number | null;
  qty_kg: string | null;
  posting_seq: string;
  entry_date: string;
  ref_type: string | null;
  ref_id: string | null;
  reverses_entry_id: string | null;
  unit_cost_iqd: string | null;
  unit_cost_usd_cents: string | null;
  note: string | null;
  created_by: string;
  created_at: Date;
  created_by_name?: string | null;
  item_name?: string;
}

/** Alias-aware so the same list serves a plain read and the join that adds the employee. */
function movementColumns(alias = 'stock_ledger'): string {
  return [
    `${alias}.id`,
    `${alias}.item_id`,
    `${alias}.movement_type::text AS movement_type`,
    `${alias}.qty_count`,
    `${alias}.qty_kg::text AS qty_kg`,
    `${alias}.posting_seq::text AS posting_seq`,
    `to_char(${alias}.entry_date, 'YYYY-MM-DD') AS entry_date`,
    `${alias}.ref_type::text AS ref_type`,
    `${alias}.ref_id`,
    `${alias}.reverses_entry_id`,
    `${alias}.unit_cost_iqd::text AS unit_cost_iqd`,
    `${alias}.unit_cost_usd_cents::text AS unit_cost_usd_cents`,
    `${alias}.note`,
    `${alias}.created_by`,
    `${alias}.created_at`,
  ].join(', ');
}

function toMovement(row: StockRow): StockMovement {
  return {
    id: row.id,
    item_id: row.item_id,
    movement_type: row.movement_type as StockMovement['movement_type'],
    qty_count: row.qty_count,
    qty_kg: row.qty_kg,
    posting_seq: Number(row.posting_seq),
    entry_date: row.entry_date,
    ref_type: row.ref_type as StockMovement['ref_type'],
    ref_id: row.ref_id,
    reverses_entry_id: row.reverses_entry_id,
  };
}

export interface MovementDto {
  id: string;
  movement_type: string;
  qty_count: number | null;
  qty_kg: string | null;
  entry_date: string;
  ref_type: string | null;
  ref_id: string | null;
  reverses_entry_id: string | null;
  note: string | null;
  unit_cost_iqd: number | null;
  unit_cost_usd_cents: number | null;
  performed_by: string | null;
  created_at: string;
  is_live: boolean;
}

/**
 * The stock ledger (spec 2.5). Every movement is appended inside the caller's transaction,
 * together with the document that caused it; the application role cannot update or delete a
 * movement, so a correction is a `reversal` row and stock is always the sum of what happened.
 */
@Injectable()
export class StockService {
  constructor(private readonly settings: SettingsService) {}

  async append(tx: Db, movement: NewStockMovement): Promise<StockMovement> {
    const { rows } = await tx.query<StockRow>(
      `INSERT INTO stock_ledger
         (item_id, movement_type, qty_count, qty_kg, ref_type, ref_id, reverses_entry_id,
          entry_date, unit_cost_iqd, unit_cost_usd_cents, note, created_by)
       VALUES ($1, $2::stock_movement_type, $3, $4::numeric, $5::stock_ref_type, $6, $7, $8::date,
               $9, $10, $11, $12)
       RETURNING ${movementColumns()}`,
      [
        movement.item_id,
        movement.movement_type,
        movement.qty_count,
        movement.qty_kg,
        movement.ref_type ?? null,
        movement.ref_id ?? null,
        movement.reverses_entry_id ?? null,
        movement.entry_date,
        movement.unit_cost_iqd ?? null,
        movement.unit_cost_usd_cents ?? null,
        movement.note ?? null,
        movement.created_by,
      ],
    );
    return toMovement(rows[0] as StockRow);
  }

  async movementsFor(tx: Db, itemId: string): Promise<StockMovement[]> {
    const { rows } = await tx.query<StockRow>(
      `SELECT ${movementColumns()} FROM stock_ledger WHERE item_id = $1 ORDER BY posting_seq ASC`,
      [itemId],
    );
    return rows.map(toMovement);
  }

  /**
   * One item's movement list for the Movements tab, newest first, with who recorded each one.
   * Paginated: a material sold every day for five years has thousands of rows (NFR-13).
   */
  async movementPage(
    tx: Db,
    itemId: string,
    options: { page?: number; page_size?: number } = {},
  ): Promise<{ items: MovementDto[]; total: number }> {
    const pageSize = Math.min(options.page_size ?? 25, 100);
    const offset = Math.max((options.page ?? 1) - 1, 0) * pageSize;
    const [list, count, reversed] = await Promise.all([
      tx.query<StockRow>(
        `SELECT ${movementColumns('s')}, u.display_name AS created_by_name
           FROM stock_ledger s
           LEFT JOIN users u ON u.id = s.created_by
          WHERE s.item_id = $1
          ORDER BY s.posting_seq DESC
          LIMIT $2 OFFSET $3`,
        [itemId, pageSize, offset],
      ),
      tx.query<{ total: string }>('SELECT count(*)::text AS total FROM stock_ledger WHERE item_id = $1', [
        itemId,
      ]),
      tx.query<{ reverses_entry_id: string }>(
        'SELECT reverses_entry_id FROM stock_ledger WHERE item_id = $1 AND reverses_entry_id IS NOT NULL',
        [itemId],
      ),
    ]);

    const reversedIds = new Set(reversed.rows.map((row) => row.reverses_entry_id));
    return {
      items: list.rows.map((row) => ({
        id: row.id,
        movement_type: row.movement_type,
        qty_count: row.qty_count,
        qty_kg: row.qty_kg,
        entry_date: row.entry_date,
        ref_type: row.ref_type,
        ref_id: row.ref_id,
        reverses_entry_id: row.reverses_entry_id,
        note: row.note,
        unit_cost_iqd: row.unit_cost_iqd === null ? null : Number(row.unit_cost_iqd),
        unit_cost_usd_cents: row.unit_cost_usd_cents === null ? null : Number(row.unit_cost_usd_cents),
        performed_by: row.created_by_name ?? null,
        created_at: row.created_at.toISOString(),
        is_live: row.movement_type !== 'reversal' && !reversedIds.has(row.id),
      })),
      total: Number(count.rows[0]?.total ?? 0),
    };
  }

  /** The item's stock as the `item_stock` view computes it, read inside the transaction. */
  async stockFor(tx: Db, itemId: string): Promise<ItemStock> {
    const { rows } = await tx.query<{
      stock_count: string;
      stock_kg: string;
      count_complete: boolean;
      kg_complete: boolean;
    }>(
      `SELECT stock_count::text AS stock_count, stock_kg::text AS stock_kg, count_complete, kg_complete
         FROM item_stock WHERE item_id = $1`,
      [itemId],
    );
    const row = rows[0];
    if (!row) return { stock_count: 0, stock_kg: '0.000', count_complete: true, kg_complete: true };
    return {
      stock_count: Number(row.stock_count),
      stock_kg: row.stock_kg,
      count_complete: row.count_complete,
      kg_complete: row.kg_complete,
    };
  }

  /**
   * "Stock is 12, you are selling 15" (FR-303). Selling below stock warns by default and is
   * refused when the admin set `allow_negative_stock = false`, naming the item and what is
   * left so the employee can correct the line rather than guess (A-34, spec 2.5.1).
   */
  async assertSellable(
    tx: Db,
    lines: readonly { item_id: string; item_name: string; priced_measure: Measure; quantity: string }[],
  ): Promise<{ item_id: string; item_name: string; available: string; requested: string; measure: Measure }[]> {
    const allowNegative = await this.settings.get('allow_negative_stock');
    const warnings: {
      item_id: string;
      item_name: string;
      available: string;
      requested: string;
      measure: Measure;
    }[] = [];

    // Several lines can name the same material; the check is on the total leaving stock.
    const requested = new Map<string, { quantity: number; line: (typeof lines)[number] }>();
    for (const line of lines) {
      const existing = requested.get(line.item_id);
      requested.set(line.item_id, {
        quantity: (existing?.quantity ?? 0) + Number(line.quantity),
        line,
      });
    }

    for (const [itemId, { quantity, line }] of requested) {
      const stock = await this.stockFor(tx, itemId);
      const priced = pricedStock(stock, line.priced_measure === 'count' ? 'per_piece' : 'per_kg');
      const check = checkStockForSale({
        available: priced.quantity,
        requested: String(quantity),
        measure: line.priced_measure,
        allow_negative: allowNegative,
        complete: priced.complete,
      });

      if (check.kind === 'refuse') {
        throw ApiError.validation([
          {
            path: `lines.${lines.indexOf(line)}.quantity`,
            code: 'STOCK_INSUFFICIENT',
            message_key: 'errors:stock_insufficient',
            params: {
              item: line.item_name,
              available: check.available,
              requested: check.requested,
              measure: check.measure,
            },
          },
        ]);
      }
      if (check.kind === 'warn') {
        warnings.push({
          item_id: itemId,
          item_name: line.item_name,
          available: check.available,
          requested: check.requested,
          measure: check.measure,
        });
      }
    }

    return warnings;
  }

  /**
   * Reverses every live movement of one document (spec 2.5.3 step 2), which is what an edit
   * and a void both start with. A measure the original did not carry stays null.
   */
  async reverseLiveForRef(
    tx: Db,
    ref: { ref_type: 'order_line' | 'purchase_line' | 'damage'; ref_ids: readonly string[] },
    options: { created_by: string; note: string; entry_date?: string },
  ): Promise<StockMovement[]> {
    if (ref.ref_ids.length === 0) return [];
    const { rows } = await tx.query<StockRow>(
      `SELECT ${movementColumns()} FROM stock_ledger
        WHERE ref_type = $1::stock_ref_type AND ref_id = ANY($2::uuid[])
        ORDER BY posting_seq ASC`,
      [ref.ref_type, [...ref.ref_ids]],
    );
    const movements = rows.map(toMovement);

    // A movement of the same item may have been reversed already by an earlier edit, so only
    // the live ones are negated — reversing a reversed row would double the correction.
    const written: StockMovement[] = [];
    for (const movement of liveMovements(movements)) {
      written.push(await this.append(tx, reversalOfMovement(movement, options)));
    }
    return written;
  }

  /** The same sum the view computes, for the kernel-level assertions in the tests. */
  stockOfMovements(movements: readonly StockMovement[]): ItemStock {
    return stockOf(movements);
  }
}

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  checkStockForSale,
  isLiveMovement,
  liveMovements,
  pricedStock,
  reversalOfMovement,
  stockOf,
} from './index.js';
import type { StockMovement } from './index.js';

let sequence = 0;

function movement(overrides: Partial<StockMovement> = {}): StockMovement {
  sequence += 1;
  return {
    id: `m${sequence}`,
    item_id: 'copper',
    movement_type: 'purchase_in',
    qty_count: null,
    qty_kg: '100.000',
    posting_seq: sequence,
    entry_date: '2026-09-18',
    reverses_entry_id: null,
    ...overrides,
  };
}

describe('stock is the sum of the movements (FR-303, spec 2.5)', () => {
  it('sums the priced measure and keeps kilograms exact', () => {
    const stock = stockOf([
      movement({ qty_kg: '240.500' }),
      movement({ movement_type: 'sale_out', qty_kg: '-12.500' }),
      movement({ movement_type: 'sale_out', qty_kg: '-0.125' }),
    ]);
    expect(stock.stock_kg).toBe('227.875');
    expect(stock.kg_complete).toBe(true);
  });

  it('marks the other measure incomplete as soon as one movement did not carry it', () => {
    const stock = stockOf([
      movement({ qty_count: 40, qty_kg: '96.000' }),
      movement({ movement_type: 'sale_out', qty_count: -5, qty_kg: null }),
    ]);
    expect(stock.stock_count).toBe(35);
    expect(stock.count_complete).toBe(true);
    expect(stock.kg_complete).toBe(false);
    // 96 kg is a *partial* sum, so the screen shows "—" rather than this number (FR-303).
    expect(stock.stock_kg).toBe('96.000');
  });

  it('reads as zero and complete for a material that has never moved', () => {
    expect(stockOf([])).toEqual({
      stock_count: 0,
      stock_kg: '0.000',
      count_complete: true,
      kg_complete: true,
    });
  });

  it('leads with the priced measure of the material', () => {
    const stock = stockOf([movement({ qty_count: 40, qty_kg: '96.000' })]);
    expect(pricedStock(stock, 'per_piece')).toEqual({ measure: 'count', quantity: '40', complete: true });
    expect(pricedStock(stock, 'per_kg')).toEqual({ measure: 'kg', quantity: '96.000', complete: true });
  });

  it('property: a movement and its reversal leave the stock unchanged', () => {
    fc.assert(
      fc.property(fc.integer({ min: -100_000, max: 100_000 }), (count) => {
        const original = movement({ qty_count: count, qty_kg: null });
        const reversal = reversalOfMovement(original, { created_by: 'sara', note: 'void' });
        const after = stockOf([original, { ...movement(), ...reversal, id: 'r', reverses_entry_id: original.id }]);
        expect(after.stock_count).toBe(0);
      }),
    );
  });
});

describe('reversing a movement (spec 2.5.3 step 2)', () => {
  it('negates exactly and keeps the document it came from', () => {
    const sale = movement({
      movement_type: 'sale_out',
      qty_count: -40,
      qty_kg: '-96.000',
      ref_type: 'order_line',
      ref_id: 'line-1',
    });
    expect(reversalOfMovement(sale, { created_by: 'sara', note: 'order edited' })).toEqual({
      item_id: 'copper',
      movement_type: 'reversal',
      qty_count: 40,
      qty_kg: '96.000',
      entry_date: '2026-09-18',
      created_by: 'sara',
      ref_type: 'order_line',
      ref_id: 'line-1',
      reverses_entry_id: sale.id,
      note: 'order edited',
    });
  });

  it('leaves a measure the original did not carry as null, never as a zero', () => {
    const reversal = reversalOfMovement(movement({ qty_count: null, qty_kg: '-12.500' }), {
      created_by: 'sara',
      note: 'void',
    });
    // A zero here would make the item's count "complete" and put a wrong number on the card.
    expect(reversal.qty_count).toBeNull();
    expect(reversal.qty_kg).toBe('12.500');
  });

  it('refuses to reverse a reversal, and refuses a reversal without a note', () => {
    const reversal = movement({ movement_type: 'reversal', reverses_entry_id: 'm1' });
    expect(() => reversalOfMovement(reversal, { created_by: 'sara', note: 'x' })).toThrow();
    expect(() => reversalOfMovement(movement(), { created_by: 'sara', note: '  ' })).toThrow();
  });

  it('knows which movements are still live, so an edit reverses each of them once', () => {
    const original = movement();
    const reversal = movement({ movement_type: 'reversal', reverses_entry_id: original.id });
    const replacement = movement();
    const all = [original, reversal, replacement];

    expect(isLiveMovement(original, all)).toBe(false);
    expect(isLiveMovement(reversal, all)).toBe(false);
    expect(isLiveMovement(replacement, all)).toBe(true);
    expect(liveMovements(all)).toEqual([replacement]);
  });
});

describe('selling more than the stock (FR-303, A-34)', () => {
  it('warns and allows by default', () => {
    expect(
      checkStockForSale({ available: '12.000', requested: '15.000', measure: 'kg', allow_negative: true }),
    ).toEqual({ kind: 'warn', available: '12.000', requested: '15.000', measure: 'kg' });
  });

  it('refuses when the admin blocked negative stock', () => {
    expect(
      checkStockForSale({ available: 12, requested: 15, measure: 'count', allow_negative: false }),
    ).toEqual({ kind: 'refuse', available: '12', requested: '15', measure: 'count' });
  });

  it('is silent while there is enough, including exactly enough', () => {
    expect(checkStockForSale({ available: 15, requested: 15, measure: 'count', allow_negative: false }).kind).toBe('ok');
    expect(checkStockForSale({ available: '0.500', requested: '0.250', measure: 'kg', allow_negative: false }).kind).toBe('ok');
  });

  it('cannot check a measure that is not summable for the material, so it says nothing', () => {
    expect(
      checkStockForSale({
        available: '96.000',
        requested: '200.000',
        measure: 'kg',
        allow_negative: false,
        complete: false,
      }).kind,
    ).toBe('ok');
  });
});

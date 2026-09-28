import { normalizeDigitsToAscii } from '@mizan/i18n';
import type { Formatter } from '@mizan/i18n';
import type { Measure } from '@mizan/money';

/**
 * Pieces are whole. What a count field holds: nothing typed yet, a whole number, or text that is
 * not one — "2.5", ".", "3a". The last is shown back to the user as an error, never rounded:
 * `Math.round(Number("2.5"))` booked three pieces for two and a half, and "." showed NaN.
 */
export type CountText = { kind: 'empty' } | { kind: 'count'; value: number } | { kind: 'invalid' };

/** Read a count as typed; Eastern Arabic-Indic and Persian digits count as digits (2.10.4). */
export function parseCount(text: string): CountText {
  const plain = normalizeDigitsToAscii(text).replace(/,/g, '').trim();
  if (plain === '') return { kind: 'empty' };
  if (!/^\d+$/.test(plain)) return { kind: 'invalid' };
  const value = Number(plain);
  return Number.isSafeInteger(value) ? { kind: 'count', value } : { kind: 'invalid' };
}

/** A count that is a whole number greater than zero, or null. */
export function positiveCount(text: string): number | null {
  const parsed = parseCount(text);
  return parsed.kind === 'count' && parsed.value > 0 ? parsed.value : null;
}

/**
 * A recorded quantity as one line of text: the measure the material is priced by first, the
 * other after it when it was recorded too — "12 pcs · 3.5 kg".
 */
export function quantityText(
  quantity: { priced_measure?: Measure | null; qty_count: number | null; qty_kg: string | null },
  formatter: Pick<Formatter, 'number' | 'quantity'>,
  t: (key: string) => string,
): string {
  const kg = quantity.qty_kg !== null ? `${formatter.quantity(quantity.qty_kg)} ${t('common:kg_symbol')}` : null;
  const count =
    quantity.qty_count !== null ? `${formatter.number(quantity.qty_count)} ${t('common:count_symbol')}` : null;
  const ordered = quantity.priced_measure === 'kg' ? [kg, count] : [count, kg];
  const text = ordered.filter((part): part is string => part !== null).join(' · ');
  return text === '' ? '—' : text;
}

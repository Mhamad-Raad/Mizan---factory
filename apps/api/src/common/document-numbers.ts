import type { Db } from '../database/pool.js';

/**
 * The numbers of the documents a page of ledger rows names (D-086) — "Order #40", "Purchase #12"
 * — read in one query for the rows being sent, never per row and never for the whole ledger.
 */
export async function documentNumbers(
  db: Db,
  table: 'orders' | 'purchases',
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, number>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();
  const { rows } = await db.query<{ id: string; number: string }>(
    `SELECT id, number::text AS number FROM ${table} WHERE id = ANY($1::uuid[])`,
    [wanted],
  );
  return new Map(rows.map((row) => [row.id, Number(row.number)]));
}

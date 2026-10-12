import type { Db } from '../database/pool.js';

/**
 * What we still owe the companies (D-085) — the Purchases page's figure and Today's tile, one
 * query so the two can never disagree — from the maintained per-account sums of migration 0033:
 * one row per account, never a ledger sum.
 *
 * Over the active companies we owe (a positive balance in their own currency), which is what the
 * Companies list's "We owe them" filter shows. Each account is read in its own currency only: the
 * dinar accounts' dinars and the dollar accounts' dollars, as two figures. An account's other
 * column is a sum of conversions at many rates — a dollar account paid at a higher rate than it
 * bought at has a *negative* dinar column while we owe it dollars — so adding it in let one
 * account's drift lower what we owe another (review, lesson 4).
 */
export async function owedToCompanies(
  db: Db,
): Promise<{ companies: number; owed_iqd: number; owed_usd_cents: number }> {
  const { rows } = await db.query<{ companies: string; owed_iqd: string; owed_usd_cents: string }>(
    `SELECT count(*)::text AS companies,
            coalesce(sum(t.payable_iqd) FILTER (WHERE c.settlement_currency = 'IQD'), 0)::text AS owed_iqd,
            coalesce(sum(t.payable_usd_cents) FILTER (WHERE c.settlement_currency = 'USD'), 0)::text AS owed_usd_cents
       FROM account_totals t
       JOIN customers c ON c.id = t.account_id
      WHERE c.deleted_at IS NULL AND c.is_active AND NOT c.is_system
        AND CASE WHEN c.settlement_currency = 'IQD' THEN t.payable_iqd ELSE t.payable_usd_cents END > 0`,
  );
  const row = rows[0];
  return {
    companies: Number(row?.companies ?? 0),
    owed_iqd: Number(row?.owed_iqd ?? 0),
    owed_usd_cents: Number(row?.owed_usd_cents ?? 0),
  };
}

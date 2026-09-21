/**
 * Fills in `order_lines.margin_iqd` / `margin_usd_cents` for lines written before migration
 * 0014 (D-039, REVIEW-I6).
 *
 *     node scripts/backfill-margins.mjs                # the whole table, in batches
 *     node scripts/backfill-margins.mjs --batch 5000
 *
 * The figures are computed by **the kernel** — `lineMargin` from `@mizan/money`, the same
 * function the write path now calls — and not by a SQL expression. That matters more than the
 * speed: a formula written twice is two formulas, and the one nobody tests is the one that
 * drifts (D-019, D-029). So this script reads each line's stored snapshot, asks the kernel, and
 * writes the answer back.
 *
 * It is idempotent (`WHERE margin_iqd IS NULL AND cost_source <> 'none'`), so it can be run
 * again after an interruption, and it touches nothing else on the row.
 */
import { Client } from 'pg';
import { lineMargin } from '@mizan/money';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(args[index + 1]);
};
const BATCH = option('batch', 20_000);

const url =
  process.env.DATABASE_MIGRATE_URL ?? 'postgresql://mizan_migrate:mizan_migrate@localhost:5432/mizan';
const client = new Client({ connectionString: url });
await client.connect();

const started = Date.now();
const say = (text) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${text}`);

const { rows: pending } = await client.query(
  `SELECT count(*)::int AS n FROM order_lines WHERE margin_iqd IS NULL AND cost_source <> 'none'`,
);
say(`${pending[0].n} lines to value`);

let done = 0;
let cursor = '00000000-0000-0000-0000-000000000000';

for (;;) {
  const { rows } = await client.query(
    `SELECT id::text AS id, priced_measure::text AS priced_measure, qty_count,
            qty_kg::text AS qty_kg,
            unit_price_iqd::int AS unit_price_iqd,
            unit_price_usd_cents::int AS unit_price_usd_cents,
            price_entered_currency::text AS price_entered_currency,
            rate_iqd_per_usd::text AS rate_iqd_per_usd,
            cost_unit_iqd::int AS cost_unit_iqd,
            cost_unit_usd_cents::int AS cost_unit_usd_cents,
            cost_source::text AS cost_source
       FROM order_lines
      WHERE id > $1::uuid AND margin_iqd IS NULL AND cost_source <> 'none'
      ORDER BY id
      LIMIT $2`,
    [cursor, BATCH],
  );
  if (rows.length === 0) break;

  const ids = [];
  const iqd = [];
  const cents = [];
  for (const row of rows) {
    const margin = lineMargin(row);
    if (!margin) continue;
    ids.push(row.id);
    iqd.push(margin.margin_iqd);
    cents.push(margin.margin_usd_cents);
  }

  if (ids.length > 0) {
    // One statement per batch: the ids and the two figures travel as arrays and are joined
    // back by position, which is the cheapest way to write twenty thousand rows from node.
    await client.query(
      `UPDATE order_lines AS l
          SET margin_iqd = v.iqd, margin_usd_cents = v.cents
         FROM (
           SELECT unnest($1::uuid[]) AS id, unnest($2::bigint[]) AS iqd, unnest($3::bigint[]) AS cents
         ) v
        WHERE l.id = v.id`,
      [ids, iqd, cents],
    );
  }

  done += rows.length;
  cursor = rows[rows.length - 1].id;
  say(`${done} / ${pending[0].n}`);
}

const { rows: left } = await client.query(
  `SELECT count(*)::int AS n FROM order_lines WHERE margin_iqd IS NULL AND cost_source <> 'none'`,
);
say(`done — ${left[0].n} lines still without a margin (expected 0)`);
await client.end();
process.exit(left[0].n === 0 ? 0 : 1);

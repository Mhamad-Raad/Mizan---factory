/**
 * The integrity checks of NFR-08 and 2.14: what a restored database must satisfy before anybody
 * says the restore worked.
 *
 *     node scripts/check-integrity.mjs                                   # the dev database
 *     DATABASE_MIGRATE_URL=…/mizan_restored node scripts/check-integrity.mjs
 *
 * Row counts prove the dump was complete; the ledger identities prove it is *coherent*, which
 * is the part a restore can silently get wrong — a dump taken mid-transaction, or restored with
 * a trigger disabled, can leave a balance that no longer equals the sum of its entries. Every
 * balance in this system is a sum over an append-only ledger (2.2.6), so every one of them can
 * be recomputed and compared against the view the application reads.
 *
 * It exits non-zero on the first broken invariant, so the restore drill of the runbook cannot be
 * logged as passed when it was not.
 */
import { Client } from 'pg';

const url =
  process.env.DATABASE_MIGRATE_URL ?? 'postgresql://mizan_migrate:mizan_migrate@localhost:5432/mizan';
const client = new Client({ connectionString: url });
await client.connect();

let failures = 0;
const ok = (text) => console.log(`  ✓ ${text}`);
const bad = (text) => {
  failures += 1;
  console.log(`  ✗ ${text}`);
};
const check = (condition, text) => (condition ? ok(text) : bad(text));
const section = (text) => console.log(`\n${text}`);

console.log(`Mizan integrity checks — ${url.replace(/:[^:@]*@/, ':***@')}`);

// ── 1 · the schema arrived whole ─────────────────────────────────────────────────────

section('The schema');
const { rows: tables } = await client.query(
  `SELECT count(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
);
check(tables[0].n >= 20, `${tables[0].n} tables present`);

const { rows: migrations } = await client.query(
  'SELECT count(*)::int AS n, max(name) AS last FROM mizan_migrations',
);
check(migrations[0].n > 0, `${migrations[0].n} migrations recorded, last: ${migrations[0].last}`);

const { rows: admins } = await client.query(
  "SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND is_active = true",
);
check(admins[0].n >= 1, `${admins[0].n} active admin(s) — somebody can sign in`);

// ── 2 · the append-only guarantees are still in force ────────────────────────────────

section('Append-only privileges (2.13)');
for (const table of ['audit_log', 'customer_ledger', 'company_ledger', 'stock_ledger']) {
  const { rows } = await client.query(
    `SELECT privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'mizan_app' AND table_name = $1`,
    [table],
  );
  const granted = new Set(rows.map((row) => row.privilege_type));
  check(
    granted.has('INSERT') && granted.has('SELECT') && !granted.has('UPDATE') && !granted.has('DELETE'),
    `${table}: INSERT + SELECT for the application, no UPDATE, no DELETE`,
  );
}

// ── 3 · every balance equals the sum of its ledger ───────────────────────────────────

section('Balances equal their ledgers (2.2.6)');
const { rows: customerDrift } = await client.query(
  `SELECT count(*)::int AS n FROM (
     SELECT c.id, c.settlement_currency,
            coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd
                              ELSE l.amount_usd_cents END), 0) AS computed,
            max(b.balance) AS from_view
       FROM customers c
       LEFT JOIN customer_ledger l ON l.customer_id = c.id
       LEFT JOIN customer_balances b ON b.customer_id = c.id
      GROUP BY c.id, c.settlement_currency
   ) sums
   WHERE coalesce(from_view, 0) <> computed`,
);
check(customerDrift[0].n === 0, `every customer balance equals its ledger (${customerDrift[0].n} disagree)`);

const { rows: companyDrift } = await client.query(
  `SELECT count(*)::int AS n FROM (
     SELECT co.id, co.settlement_currency,
            coalesce(sum(CASE WHEN co.settlement_currency = 'IQD' THEN l.amount_iqd
                              ELSE l.amount_usd_cents END), 0) AS computed,
            max(b.balance) AS from_view
       FROM customers co
       LEFT JOIN company_ledger l ON l.company_id = co.id
       LEFT JOIN company_balances b ON b.company_id = co.id
      WHERE co.is_supplier
      GROUP BY co.id, co.settlement_currency
   ) sums
   WHERE coalesce(from_view, 0) <> computed`,
);
check(companyDrift[0].n === 0, `every company balance equals its ledger (${companyDrift[0].n} disagree)`);

// One record per business (D-054): its net is its two ledgers' difference, and the buying
// side's money only ever belongs to a business that is a company.
const { rows: netDrift } = await client.query(
  `SELECT count(*)::int AS n
     FROM party_balances p
     LEFT JOIN customer_balances cb ON cb.customer_id = p.customer_id
     LEFT JOIN company_balances kb ON kb.company_id = p.customer_id
    WHERE p.net <> coalesce(cb.balance, 0) - coalesce(kb.balance, 0)`,
);
check(netDrift[0].n === 0, `every net balance is what they owe less what we owe (${netDrift[0].n} disagree)`);

const { rows: strayBuying } = await client.query(
  `SELECT count(*)::int AS n FROM company_ledger l
     JOIN customers c ON c.id = l.company_id
    WHERE NOT c.is_supplier`,
);
check(strayBuying[0].n === 0, `no buying-side entry belongs to a business that is not a company (${strayBuying[0].n})`);

const { rows: stockDrift } = await client.query(
  `SELECT count(*)::int AS n FROM (
     SELECT i.id, i.pricing_unit,
            coalesce(sum(CASE WHEN i.pricing_unit = 'per_piece' THEN s.qty_count ELSE s.qty_kg END), 0)
              AS computed,
            max(CASE WHEN i.pricing_unit = 'per_piece' THEN st.stock_count ELSE st.stock_kg END)
              AS from_view
       FROM items i
       LEFT JOIN stock_ledger s ON s.item_id = i.id
       LEFT JOIN item_stock st ON st.item_id = i.id
      GROUP BY i.id, i.pricing_unit
   ) sums
   WHERE coalesce(from_view, 0) <> computed`,
);
check(stockDrift[0].n === 0, `every material's stock equals its movements (${stockDrift[0].n} disagree)`);

/**
 * The two maintained figures in the system (migrations 0015 and 0017). A cached number nobody
 * checks is a number that lies, so the restore drill checks both: every row must equal the
 * ledger it sums.
 */
const { rows: remainingDrift } = await client.query(
  `SELECT count(*)::int AS n FROM (
     SELECT l.order_id,
            sum(l.amount_iqd) AS iqd,
            sum(l.amount_usd_cents) AS cents,
            max(r.remaining_iqd) AS kept_iqd,
            max(r.remaining_usd_cents) AS kept_cents
       FROM customer_ledger l
       LEFT JOIN order_remaining r ON r.order_id = l.order_id
      WHERE l.order_id IS NOT NULL
      GROUP BY l.order_id
   ) sums
   WHERE coalesce(kept_iqd, 0) <> iqd OR coalesce(kept_cents, 0) <> cents`,
);
check(
  remainingDrift[0].n === 0,
  `the maintained per-order remaining equals the ledger (${remainingDrift[0].n} disagree)`,
);

/**
 * The second maintained sum (0017): each material's stock against its own movements. Same
 * reasoning as the one above — a cached number nobody checks is a number that lies — and the
 * same remedy: compare it with the ledger on every drill, and fail the drill if it drifts.
 */
const { rows: maintainedStock } = await client.query(
  `SELECT count(*)::int AS n
     FROM (
       SELECT s.item_id,
              coalesce(sum(s.qty_count), 0) AS counted,
              coalesce(sum(s.qty_kg), 0) AS weighed,
              count(*) AS movements,
              max(t.stock_count) AS kept_count,
              max(t.stock_kg) AS kept_kg,
              max(t.movements) AS kept_movements
         FROM stock_ledger s
         LEFT JOIN item_stock_totals t ON t.item_id = s.item_id
        GROUP BY s.item_id
     ) sums
    WHERE coalesce(kept_count, 0) <> counted
       OR coalesce(kept_kg, 0) <> weighed
       OR coalesce(kept_movements, 0) <> movements`,
);
check(
  maintainedStock[0].n === 0,
  `the maintained stock per material equals the stock ledger (${maintainedStock[0].n} disagree)`,
);

// ── 4 · money is coherent, per row ───────────────────────────────────────────────────

section('Money (rule 1)');
const { rows: rates } = await client.query(
  `SELECT count(*)::int AS n FROM customer_ledger WHERE rate_iqd_per_usd IS NULL OR rate_iqd_per_usd <= 0
    UNION ALL
   SELECT count(*)::int FROM company_ledger WHERE rate_iqd_per_usd IS NULL OR rate_iqd_per_usd <= 0`,
);
check(
  rates.every((row) => row.n === 0),
  'every ledger row carries the rate that made it',
);

const { rows: pairs } = await client.query(
  `SELECT count(*)::int AS n FROM customer_ledger
    WHERE (amount_iqd = 0) <> (amount_usd_cents = 0)`,
);
check(pairs[0].n === 0, `no half-empty currency pair in the customer ledger (${pairs[0].n} rows)`);

const { rows: documents } = await client.query(
  `SELECT count(*)::int AS n FROM orders o
    WHERE o.status = 'active' AND o.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM order_lines l WHERE l.order_id = o.id AND l.deleted_at IS NULL)`,
);
check(documents[0].n === 0, `no active order without a line (${documents[0].n})`);

// ── 5 · sequences are past the data they number ──────────────────────────────────────

section('Sequences (a restore that resets one issues duplicate numbers)');
for (const [sequence, table, column] of [
  ['order_number_seq', 'orders', 'number'],
  ['purchase_number_seq', 'purchases', 'number'],
]) {
  const { rows } = await client.query(
    `SELECT (SELECT last_value FROM ${sequence}) AS sequence_at,
            (SELECT coalesce(max(${column}), 0) FROM ${table}) AS data_at`,
  );
  const { sequence_at: at, data_at: data } = rows[0];
  check(Number(at) >= Number(data), `${sequence} at ${at}, highest ${table}.${column} is ${data}`);
}

// ── 6 · History is intact ────────────────────────────────────────────────────────────

section('History (rule 3)');
const { rows: audit } = await client.query(
  `SELECT count(*)::int AS rows, min(occurred_at)::date AS first, max(occurred_at)::date AS last
     FROM audit_log`,
);
check(audit[0].rows > 0, `${audit[0].rows} audit rows, ${audit[0].first} → ${audit[0].last}`);

const { rows: orphans } = await client.query(
  `SELECT count(*)::int AS n FROM audit_log a
    WHERE a.actor_user_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.actor_user_id)`,
);
check(orphans[0].n === 0, `every audit row's actor still exists (${orphans[0].n} orphaned)`);

console.log(
  failures === 0
    ? '\nAll integrity checks passed.\n'
    : `\n${failures} integrity check(s) failed — this database is not fit to run on.\n`,
);
await client.end();
process.exit(failures === 0 ? 0 : 1);

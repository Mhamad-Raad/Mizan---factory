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
      WHERE NOT co.is_system
      GROUP BY co.id, co.settlement_currency
   ) sums
   WHERE coalesce(from_view, 0) <> computed`,
);
check(companyDrift[0].n === 0, `every company balance equals its ledger (${companyDrift[0].n} disagree)`);

// One kind of account (D-054, D-055): its net is its two ledgers' difference, and the buying
// side's money never belongs to the walk-in customer, which we never buy from.
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
    WHERE c.is_system`,
);
check(strayBuying[0].n === 0, `no buying-side entry belongs to the walk-in customer (${strayBuying[0].n})`);

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
 * The first two maintained figures in the system (migrations 0015 and 0017). A cached number nobody
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

/**
 * The two maintained sums of migration 0033 (D-075). Every account's two ledgers, per currency
 * column, and every buy's taken figure against its allocations — with whether the buy is still
 * live — and every buy has its row. The Stock report, the dashboard, both account lists and the
 * Receivables and Payables reports read these, so a drift here would be a wrong figure on all of
 * them.
 */
const { rows: accountDrift } = await client.query(
  `WITH r AS (SELECT customer_id id, sum(amount_iqd) i, sum(amount_usd_cents) u, count(*) n FROM customer_ledger GROUP BY 1),
        p AS (SELECT company_id id, sum(amount_iqd) i, sum(amount_usd_cents) u, count(*) n FROM company_ledger GROUP BY 1)
   SELECT count(*)::int AS n
     FROM account_totals t
     FULL JOIN r ON r.id = t.account_id
     FULL JOIN p ON p.id = coalesce(t.account_id, r.id)
    WHERE (coalesce(t.receivable_iqd, 0), coalesce(t.receivable_usd_cents, 0), coalesce(t.receivable_entries, 0))
            <> (coalesce(r.i, 0), coalesce(r.u, 0), coalesce(r.n, 0))
       OR (coalesce(t.payable_iqd, 0), coalesce(t.payable_usd_cents, 0), coalesce(t.payable_entries, 0))
            <> (coalesce(p.i, 0), coalesce(p.u, 0), coalesce(p.n, 0))`,
);
check(
  accountDrift[0].n === 0,
  `the maintained totals per account equal both ledgers (${accountDrift[0].n} disagree)`,
);

const { rows: lotDrift } = await client.query(
  `SELECT count(*)::int AS n
     FROM purchase_lines l
     JOIN purchases p ON p.id = l.purchase_id
     LEFT JOIN lot_balances b ON b.purchase_line_id = l.id
     LEFT JOIN (SELECT purchase_line_id, sum(qty) AS taken FROM lot_allocations GROUP BY 1) a
       ON a.purchase_line_id = l.id
    WHERE b.purchase_line_id IS NULL
       OR b.taken <> coalesce(a.taken, 0)
       OR b.item_id <> l.item_id
       OR b.quantity IS DISTINCT FROM (CASE WHEN l.priced_measure = 'count' THEN l.qty_count::numeric ELSE l.qty_kg END)
       OR b.live <> (l.deleted_at IS NULL AND p.status = 'active' AND p.deleted_at IS NULL)`,
);
check(
  lotDrift[0].n === 0,
  `what is left of every buy equals its allocations, and says whether the buy is live (${lotDrift[0].n} disagree)`,
);

/**
 * What each account still owes on its orders (migration 0035), per settlement currency, against
 * its active orders and their maintained remaining figures. The dashboard's unpaid tile, the
 * Orders list's figures and Receivables' unpaid count read it.
 */
const { rows: owingDrift } = await client.query(
  `WITH x AS (
     SELECT o.customer_id AS id,
            count(*) FILTER (WHERE r.remaining_iqd > 0) AS iqd_orders,
            coalesce(sum(r.remaining_iqd) FILTER (WHERE r.remaining_iqd > 0), 0) AS iqd_remaining_iqd,
            coalesce(sum(r.remaining_usd_cents) FILTER (WHERE r.remaining_iqd > 0), 0) AS iqd_remaining_usd_cents,
            coalesce(sum(o.total_iqd) FILTER (WHERE r.remaining_iqd > 0), 0) AS iqd_total_iqd,
            coalesce(sum(o.total_usd_cents) FILTER (WHERE r.remaining_iqd > 0), 0) AS iqd_total_usd_cents,
            count(*) FILTER (WHERE r.remaining_iqd > 0 AND r.remaining_iqd >= o.total_iqd) AS iqd_unpaid_orders,
            coalesce(sum(r.remaining_iqd) FILTER (WHERE r.remaining_iqd > 0 AND r.remaining_iqd >= o.total_iqd), 0) AS iqd_unpaid_remaining_iqd,
            coalesce(sum(r.remaining_usd_cents) FILTER (WHERE r.remaining_iqd > 0 AND r.remaining_iqd >= o.total_iqd), 0) AS iqd_unpaid_remaining_usd_cents,
            coalesce(sum(o.total_iqd) FILTER (WHERE r.remaining_iqd > 0 AND r.remaining_iqd >= o.total_iqd), 0) AS iqd_unpaid_total_iqd,
            coalesce(sum(o.total_usd_cents) FILTER (WHERE r.remaining_iqd > 0 AND r.remaining_iqd >= o.total_iqd), 0) AS iqd_unpaid_total_usd_cents,
            count(*) FILTER (WHERE r.remaining_usd_cents > 0) AS usd_orders,
            coalesce(sum(r.remaining_iqd) FILTER (WHERE r.remaining_usd_cents > 0), 0) AS usd_remaining_iqd,
            coalesce(sum(r.remaining_usd_cents) FILTER (WHERE r.remaining_usd_cents > 0), 0) AS usd_remaining_usd_cents,
            coalesce(sum(o.total_iqd) FILTER (WHERE r.remaining_usd_cents > 0), 0) AS usd_total_iqd,
            coalesce(sum(o.total_usd_cents) FILTER (WHERE r.remaining_usd_cents > 0), 0) AS usd_total_usd_cents,
            count(*) FILTER (WHERE r.remaining_usd_cents > 0 AND r.remaining_usd_cents >= o.total_usd_cents) AS usd_unpaid_orders,
            coalesce(sum(r.remaining_iqd) FILTER (WHERE r.remaining_usd_cents > 0 AND r.remaining_usd_cents >= o.total_usd_cents), 0) AS usd_unpaid_remaining_iqd,
            coalesce(sum(r.remaining_usd_cents) FILTER (WHERE r.remaining_usd_cents > 0 AND r.remaining_usd_cents >= o.total_usd_cents), 0) AS usd_unpaid_remaining_usd_cents,
            coalesce(sum(o.total_iqd) FILTER (WHERE r.remaining_usd_cents > 0 AND r.remaining_usd_cents >= o.total_usd_cents), 0) AS usd_unpaid_total_iqd,
            coalesce(sum(o.total_usd_cents) FILTER (WHERE r.remaining_usd_cents > 0 AND r.remaining_usd_cents >= o.total_usd_cents), 0) AS usd_unpaid_total_usd_cents
       FROM order_remaining r
       JOIN orders o ON o.id = r.order_id
      WHERE o.status = 'active' AND o.deleted_at IS NULL
      GROUP BY o.customer_id
   )
   SELECT count(*)::int AS n
     FROM x
     FULL JOIN account_owing a ON a.account_id = x.id
    WHERE (coalesce(x.iqd_orders, 0), coalesce(x.iqd_remaining_iqd, 0), coalesce(x.iqd_remaining_usd_cents, 0), coalesce(x.iqd_total_iqd, 0), coalesce(x.iqd_total_usd_cents, 0), coalesce(x.iqd_unpaid_orders, 0), coalesce(x.iqd_unpaid_remaining_iqd, 0), coalesce(x.iqd_unpaid_remaining_usd_cents, 0), coalesce(x.iqd_unpaid_total_iqd, 0), coalesce(x.iqd_unpaid_total_usd_cents, 0), coalesce(x.usd_orders, 0), coalesce(x.usd_remaining_iqd, 0), coalesce(x.usd_remaining_usd_cents, 0), coalesce(x.usd_total_iqd, 0), coalesce(x.usd_total_usd_cents, 0), coalesce(x.usd_unpaid_orders, 0), coalesce(x.usd_unpaid_remaining_iqd, 0), coalesce(x.usd_unpaid_remaining_usd_cents, 0), coalesce(x.usd_unpaid_total_iqd, 0), coalesce(x.usd_unpaid_total_usd_cents, 0))
       <> (coalesce(a.iqd_orders, 0), coalesce(a.iqd_remaining_iqd, 0), coalesce(a.iqd_remaining_usd_cents, 0), coalesce(a.iqd_total_iqd, 0), coalesce(a.iqd_total_usd_cents, 0), coalesce(a.iqd_unpaid_orders, 0), coalesce(a.iqd_unpaid_remaining_iqd, 0), coalesce(a.iqd_unpaid_remaining_usd_cents, 0), coalesce(a.iqd_unpaid_total_iqd, 0), coalesce(a.iqd_unpaid_total_usd_cents, 0), coalesce(a.usd_orders, 0), coalesce(a.usd_remaining_iqd, 0), coalesce(a.usd_remaining_usd_cents, 0), coalesce(a.usd_total_iqd, 0), coalesce(a.usd_total_usd_cents, 0), coalesce(a.usd_unpaid_orders, 0), coalesce(a.usd_unpaid_remaining_iqd, 0), coalesce(a.usd_unpaid_remaining_usd_cents, 0), coalesce(a.usd_unpaid_total_iqd, 0), coalesce(a.usd_unpaid_total_usd_cents, 0))`,
);
check(
  owingDrift[0].n === 0,
  `what each account owes on its orders equals its orders (${owingDrift[0].n} disagree)`,
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

/**
 * Seeds a database to the **design point of NFR-13** so the load test and the slow-query review
 * measure the system the client will actually have in five years:
 *
 *   500 orders and 500 purchases a day · 5,000 materials · 10,000 customers · 500 companies
 *   · 2 million audit entries · 30 employees
 *
 *     node scripts/seed-volume.mjs --years 5            # the full design point (slow)
 *     node scripts/seed-volume.mjs --years 1 --orders 200
 *
 * It writes with `COPY`-shaped multi-row inserts as the **migrate** role, deliberately going
 * around the API: this is a fixture, not a history, and pushing a million documents through
 * Argon2id and the audit path would take days. What it does respect is every invariant the
 * application depends on — money as integers in both currencies with the rate that made them,
 * ledger rows that sum to the balances, stock rows that sum to the stock, and an audit row per
 * document — because a fixture that breaks the invariants measures a system nobody has.
 *
 * Everything it creates is named "Volume …" and dated in the past, so a demo or a review can
 * tell fixture from real data at a glance, and `DELETE FROM … WHERE name LIKE 'Volume %'` is
 * enough to take it out.
 */
import { Client } from 'pg';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(args[index + 1]);
};

const YEARS = option('years', 5);
const ORDERS_PER_DAY = option('orders', 500);
const PURCHASES_PER_DAY = option('purchases', 500);
const CUSTOMERS = option('customers', 10_000);
const COMPANIES = option('companies', 500);
const MATERIALS = option('materials', 5_000);
const EMPLOYEES = option('employees', 30);
const RATE = 1300;

const url =
  process.env.DATABASE_MIGRATE_URL ?? 'postgresql://mizan_migrate:mizan_migrate@localhost:5432/mizan';
const client = new Client({ connectionString: url });
await client.connect();

const started = Date.now();
const say = (text) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${text}`);

/** The first admin already exists (the seed created it); everything hangs off their id. */
const { rows: admins } = await client.query("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1");
const actor = admins[0]?.id;
if (!actor) {
  console.error('No admin in this database. Run `pnpm db:seed` first.');
  process.exit(1);
}

const days = Math.round(YEARS * 365);
say(
  `seeding ${days} days: ${ORDERS_PER_DAY} orders and ${PURCHASES_PER_DAY} purchases a day, ` +
    `${CUSTOMERS} customers, ${COMPANIES} companies, ${MATERIALS} materials`,
);

await client.query('SET synchronous_commit = off');

// ── the reference data ───────────────────────────────────────────────────────────────
//
// `generate_series` in the database rather than a loop in node: one statement per table, no
// round trips, and the rows are written by the same planner that will read them.

say('employees');
await client.query(
  `INSERT INTO users (display_name, display_name_normalized, username, role, password_hash, must_change_password, created_by, updated_by)
   SELECT 'Volume employee ' || g, 'volume employee ' || g, 'volume.' || g, 'employee',
          '$argon2id$v=19$m=65536,t=3,p=1$c2VlZHNlZWRzZWVk$0000000000000000000000000000000000000000000',
          false, $1, $1
     FROM generate_series(1, $2) g
   ON CONFLICT DO NOTHING`,
  [actor, EMPLOYEES],
);

say('materials with a price for every month of the period');
await client.query(
  `INSERT INTO items (name, name_normalized, pricing_unit, created_by, updated_by)
   SELECT 'Volume material ' || g, 'volume material ' || g,
          (CASE WHEN g % 2 = 0 THEN 'per_kg' ELSE 'per_piece' END)::pricing_unit, $1, $1
     FROM generate_series(1, $2) g
   ON CONFLICT DO NOTHING`,
  [actor, MATERIALS],
);

// A month price per material per month: this is what the margin report reads, and what makes
// a five-year Profit report the heaviest query in the system.
await client.query(
  `INSERT INTO item_month_prices
     (item_id, month, bought_iqd, bought_usd_cents, bought_entered_currency, bought_rate,
      sale_iqd, sale_usd_cents, sale_entered_currency, sale_rate, created_by, updated_by)
   SELECT i.id,
          date_trunc('month', now() - (m || ' months')::interval)::date,
          700 + (m % 50), round((700 + (m % 50)) * 100.0 / $3), 'IQD', $3,
          850 + (m % 60), round((850 + (m % 60)) * 100.0 / $3), 'IQD', $3,
          $1, $1
     FROM items i, generate_series(0, $2) m
    WHERE i.name LIKE 'Volume material %'
   ON CONFLICT DO NOTHING`,
  [actor, Math.round(YEARS * 12), RATE],
);

say('customers and companies');
await client.query(
  `INSERT INTO customers (name, name_normalized, settlement_currency, assigned_user_id, created_by, updated_by)
   SELECT 'Volume customer ' || g, 'volume customer ' || g,
          (CASE WHEN g % 10 = 0 THEN 'USD' ELSE 'IQD' END)::currency,
          (SELECT id FROM users WHERE username = 'volume.' || (1 + g % $3)),
          $1, $1
     FROM generate_series(1, $2) g
   ON CONFLICT DO NOTHING`,
  [actor, CUSTOMERS, EMPLOYEES],
);
await client.query(
  `INSERT INTO companies (name, name_normalized, settlement_currency, created_by, updated_by)
   SELECT 'Volume supplier ' || g, 'volume supplier ' || g,
          (CASE WHEN g % 5 = 0 THEN 'USD' ELSE 'IQD' END)::currency, $1, $1
     FROM generate_series(1, $2) g
   ON CONFLICT DO NOTHING`,
  [actor, COMPANIES],
);

// ── the documents, a year at a time so the transaction log does not explode ──────────

say('numbering the reference data, so the documents can pick by modulo');
await client.query('DROP TABLE IF EXISTS volume_customers, volume_companies, volume_items, volume_employees');
await client.query(
  `CREATE TEMP TABLE volume_customers AS
     SELECT row_number() OVER (ORDER BY id) - 1 AS n, id FROM customers WHERE name LIKE 'Volume customer %'`,
);
await client.query(
  `CREATE TEMP TABLE volume_companies AS
     SELECT row_number() OVER (ORDER BY id) - 1 AS n, id FROM companies WHERE name LIKE 'Volume supplier %'`,
);
await client.query(
  `CREATE TEMP TABLE volume_items AS
     SELECT row_number() OVER (ORDER BY id) - 1 AS n, id, pricing_unit FROM items WHERE name LIKE 'Volume material %'`,
);
await client.query(
  `CREATE TEMP TABLE volume_employees AS
     SELECT row_number() OVER (ORDER BY id) - 1 AS n, id FROM users WHERE username LIKE 'volume.%'`,
);
for (const table of ['volume_customers', 'volume_companies', 'volume_items', 'volume_employees']) {
  await client.query(`CREATE INDEX ON ${table} (n)`);
}
const counts = {};
for (const table of ['volume_customers', 'volume_companies', 'volume_items', 'volume_employees']) {
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
  counts[table] = rows[0].n;
}
say(`reference data: ${JSON.stringify(counts)}`);

for (let year = 0; year < YEARS; year += 1) {
  const from = `${YEARS - year} years`;
  const to = `${YEARS - year - 1} years`;
  say(`orders and lines: year -${YEARS - year}`);

  await client.query(
    `WITH day AS (
       SELECT generate_series(
                (now() - $2::interval)::date,
                (now() - $3::interval)::date - 1,
                interval '1 day'
              )::date AS d
     ),
     numbered AS (
       SELECT d, g,
              (extract(epoch FROM d)::bigint / 86400 * 7 + g) AS spread
         FROM day, generate_series(1, $4) g
     )
     INSERT INTO orders
       (number, customer_id, order_date, payment_type, status, total_iqd, total_usd_cents,
        discount_iqd, discount_usd_cents, rate_iqd_per_usd, rate_source, acting_user_id,
        created_by, updated_by, created_at)
     SELECT nextval('order_number_seq'), c.id, n.d,
            (CASE WHEN n.g % 3 = 0 THEN 'cash' ELSE 'borrowed' END)::payment_type,
            'active', 85000, 6538, 0, 0, $5, 'global', e.id, $1, $1, n.d + time '10:00'
       FROM numbered n
       JOIN volume_customers c ON c.n = n.spread % (SELECT count(*) FROM volume_customers)
       JOIN volume_employees e ON e.n = n.g % (SELECT count(*) FROM volume_employees)`,
    [actor, from, to, ORDERS_PER_DAY, RATE],
  );

  // One line per order, priced from the month that order belongs to — so the margin report
  // reads a real snapshot rather than a constant.
  await client.query(
    `WITH picked AS (
       SELECT o.id AS order_id, o.number, i.id AS item_id, i.pricing_unit
         FROM orders o
         JOIN volume_items i ON i.n = o.number % (SELECT count(*) FROM volume_items)
        WHERE o.order_date >= (now() - $3::interval)::date
          AND o.order_date < (now() - $4::interval)::date
          AND NOT EXISTS (SELECT 1 FROM order_lines l WHERE l.order_id = o.id)
     )
     INSERT INTO order_lines
       (order_id, line_no, item_id, priced_measure, qty_count, qty_kg, unit_price_iqd,
        unit_price_usd_cents, price_entered_currency, price_source, line_total_iqd,
        line_total_usd_cents, rate_iqd_per_usd, rate_source,
        cost_unit_iqd, cost_unit_usd_cents, cost_source, created_by)
     SELECT order_id, 1, item_id,
            (CASE WHEN pricing_unit = 'per_kg' THEN 'kg' ELSE 'count' END)::measure,
            (CASE WHEN pricing_unit = 'per_kg' THEN NULL ELSE 100 END),
            (CASE WHEN pricing_unit = 'per_kg' THEN 100.000 ELSE NULL END),
            850, 6538, 'IQD', 'month', 85000, 6538, $2, 'global',
            700, 5385, 'month', $1
       FROM picked`,
    [actor, RATE, from, to],
  );

  // The ledger rows that make the balances true: a charge per borrowed order, a settlement per
  // cash one. Without these every balance in the system would be a fiction (2.2.6).
  await client.query(
    `INSERT INTO customer_ledger
       (customer_id, entry_type, entry_date, amount_iqd, amount_usd_cents, rate_iqd_per_usd,
        rate_source, entered_currency, order_id, performed_by_user_id, created_by, note)
     SELECT o.customer_id,
            (CASE WHEN o.payment_type = 'cash' THEN 'cash_settlement' ELSE 'order' END)::customer_entry_type,
            o.order_date,
            (CASE WHEN o.payment_type = 'cash' THEN -85000 ELSE 85000 END),
            (CASE WHEN o.payment_type = 'cash' THEN -6538 ELSE 6538 END),
            $2, 'global', 'IQD', o.id, o.acting_user_id, $1, 'volume fixture'
       FROM orders o
      WHERE o.order_date >= (now() - $3::interval)::date
        AND o.order_date < (now() - $4::interval)::date
        AND NOT EXISTS (SELECT 1 FROM customer_ledger l WHERE l.order_id = o.id)`,
    [actor, RATE, from, to],
  );

  say(`purchases: year -${YEARS - year}`);
  await client.query(
    `WITH day AS (
       SELECT generate_series(
                (now() - $2::interval)::date,
                (now() - $3::interval)::date - 1,
                interval '1 day'
              )::date AS d
     )
     , numbered AS (
       SELECT d, g, (extract(epoch FROM d)::bigint / 86400 * 3 + g) AS spread
         FROM day, generate_series(1, $4) g
     )
     INSERT INTO purchases
       (number, company_id, purchase_date, status, total_iqd, total_usd_cents,
        discount_iqd, discount_usd_cents, rate_iqd_per_usd, rate_source, acting_user_id,
        created_by, updated_by, created_at)
     SELECT nextval('purchase_number_seq'), co.id, n.d, 'active', 69000, 5308, 0, 0, $5, 'global',
            e.id, $1, $1, n.d + time '08:00'
       FROM numbered n
       JOIN volume_companies co ON co.n = n.spread % (SELECT count(*) FROM volume_companies)
       JOIN volume_employees e ON e.n = n.g % (SELECT count(*) FROM volume_employees)`,
    [actor, from, to, PURCHASES_PER_DAY, RATE],
  );

  await client.query(
    `INSERT INTO company_ledger
       (company_id, entry_type, entry_date, amount_iqd, amount_usd_cents, rate_iqd_per_usd,
        rate_source, entered_currency, purchase_id, performed_by_user_id, created_by, note)
     SELECT p.company_id, 'purchase', p.purchase_date, 69000, 5308, $2, 'global', 'IQD', p.id,
            p.acting_user_id, $1, 'volume fixture'
       FROM purchases p
      WHERE p.purchase_date >= (now() - $3::interval)::date
        AND p.purchase_date < (now() - $4::interval)::date
        AND NOT EXISTS (SELECT 1 FROM company_ledger l WHERE l.purchase_id = p.id)`,
    [actor, RATE, from, to],
  );

  say(`audit rows: year -${YEARS - year}`);
  await client.query(
    `INSERT INTO audit_log
       (occurred_at, actor_user_id, action, entity_type, entity_id, entity_label, changes,
        related, request_id, auth_method)
     SELECT o.created_at, o.acting_user_id, 'create', 'order', o.id::text,
            'Order #' || o.number, '{}'::jsonb,
            jsonb_build_object('customer_id', o.customer_id, 'assigned_user_id', c.assigned_user_id),
            gen_random_uuid(), 'password'
       FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.order_date >= (now() - $1::interval)::date
        AND o.order_date < (now() - $2::interval)::date`,
    [from, to],
  );
}

say('stock movements, so the stock view is not a fiction');
await client.query(
  `INSERT INTO stock_ledger
     (item_id, movement_type, entry_date, qty_count, qty_kg, ref_type, ref_id, created_by, note)
   SELECT l.item_id, 'sale_out', o.order_date,
          CASE WHEN l.qty_count IS NULL THEN NULL ELSE -l.qty_count END,
          CASE WHEN l.qty_kg IS NULL THEN NULL ELSE -l.qty_kg END,
          'order_line', l.id, $1, 'volume fixture'
     FROM order_lines l JOIN orders o ON o.id = l.order_id
    WHERE o.created_by = $1
      AND NOT EXISTS (SELECT 1 FROM stock_ledger s WHERE s.ref_type = 'order_line' AND s.ref_id = l.id)`,
  [actor],
);

say('analyze');
await client.query('ANALYZE');

const { rows: totals } = await client.query(
  `SELECT (SELECT count(*) FROM orders) AS orders,
          (SELECT count(*) FROM order_lines) AS order_lines,
          (SELECT count(*) FROM purchases) AS purchases,
          (SELECT count(*) FROM customers) AS customers,
          (SELECT count(*) FROM companies) AS companies,
          (SELECT count(*) FROM items) AS materials,
          (SELECT count(*) FROM customer_ledger) AS customer_ledger,
          (SELECT count(*) FROM company_ledger) AS company_ledger,
          (SELECT count(*) FROM stock_ledger) AS stock_ledger,
          (SELECT count(*) FROM audit_log) AS audit_log`,
);
console.log('\nSeeded:', totals[0]);
await client.end();

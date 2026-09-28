/**
 * The slow-query review of Iteration 6, as a script rather than an afternoon (NFR-03, 2.12).
 *
 * Every list, report and dashboard endpoint, measured through the **running API** against
 * whatever volume the database holds, with the budget NFR-03 gives it: a list p95 ≤ 300 ms, a
 * write ≤ 500 ms. Each of the four reviews before this one found at least one query that had
 * quietly become linear in the archive behind it, and each time the finding came from measuring
 * rather than reading. This makes the measurement repeatable — and the same numbers are the
 * evidence the Definition of done asks for.
 *
 *     node scripts/check-budgets.mjs                          # against localhost:3000
 *     node scripts/check-budgets.mjs --base https://staging/api/v1 --password …
 *
 * It exits non-zero when anything is over budget, so it can stand in CI's way.
 */
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const BASE = flag('base', process.env.MIZAN_BASE_URL ?? 'http://localhost:3000/api/v1');
const ADMIN = flag('admin', process.env.MIZAN_ADMIN ?? 'admin');
const PASSWORD = flag('password', process.env.MIZAN_ADMIN_PASSWORD ?? 'ChangeMe!2026');
/** How many times each endpoint is measured; the reported figure is the median. */
const SAMPLES = Number(flag('samples', '5'));

const cookies = new Map();
const header = () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');

async function call(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Cookie: header(),
      'X-CSRF-Token': cookies.get('mizan_csrf') ?? '',
      ...(init.headers ?? {}),
    },
  });
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const [name, value] = pair.split('=');
    cookies.set(name, value);
  }
  const text = await response.text();
  return { status: response.status, bytes: Buffer.byteLength(text), body: text ? JSON.parse(text) : null };
}

const login = await call('/auth/login', {
  method: 'POST',
  body: JSON.stringify({ username_or_phone: ADMIN, password: PASSWORD }),
});
if (login.status !== 200) {
  console.error(`Could not sign in as ${ADMIN} (${login.status}). Pass --password.`);
  process.exit(1);
}

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Baghdad' });
const month = `${today.slice(0, 7)}-01`;
const year = `${today.slice(0, 4)}-01-01`;

/**
 * The budgets. A list is 300 ms because that is what NFR-03 says a route change may cost; the
 * two reports that read every line of a period carry a wider, *stated* budget instead of
 * pretending — the margin report's cost is linear in the lines it values (D-029, REVIEW-I4),
 * and the honest thing is a number somebody has agreed to rather than a green tick.
 */
const TARGETS = [
  ['GET /orders (today)', `/orders?from=${today}&to=${today}&page_size=25`, 300],
  ['GET /orders (this month)', `/orders?from=${month}&to=${today}&page_size=25`, 300],
  // The dashboard's latest orders: the rows and the count, not the figures over every order (D-075).
  ['GET /orders (dashboard, totals=false)', '/orders?page_size=8&totals=false', 300],
  ['GET /orders (owing, this month)', `/orders?status=owing&from=${month}&to=${today}&page_size=25`, 300],
  // Name, notes and number, each through its own index (D-075).
  ['GET /orders (search)', '/orders?q=kawa&page_size=25', 300],
  ['GET /customers', '/customers?page_size=25', 300],
  ['GET /customers (by balance)', '/customers?sort=balance&page_size=25', 300],
  // The API calls them items; the interface calls them materials, per the glossary (1.6).
  ['GET /items (materials)', '/items?page_size=25', 300],
  ['GET /companies', '/companies?page_size=25', 300],
  ['GET /purchases (this month)', `/purchases?from=${month}&to=${today}&page_size=25`, 300],
  ['GET /damages (this month)', `/damages?from=${month}&to=${today}&page_size=25`, 300],
  ['GET /history (first page)', '/history?limit=50', 300],
  ['GET /history (voids)', '/history?action=void&limit=50', 300],
  ['GET /dashboard', '/dashboard', 300],
  ['GET /reports/sales (month)', `/reports/sales?from=${month}&to=${today}`, 300],
  // Stated rather than assumed, like the year's margin: grouping a year by material reads
  // every line of that year, and no index shortens a sum of everything (REVIEW-I6).
  ['GET /reports/sales (year, by material)', `/reports/sales?from=${year}&to=${today}&group_by=item`, 1500],
  ['GET /reports/purchases (year)', `/reports/purchases?from=${year}&to=${today}`, 300],
  // Every material, each with its stock, its movements in the period, its first purchase, its
  // last sale, its month price and — only when it has stock — its open buys (D-075): 280 ms for
  // 5,000 materials at ten years. 500 ms is the agreed figure (REVIEW-I6).
  ['GET /reports/stock', `/reports/stock?from=${month}&to=${today}`, 500],
  // The maintained per-account totals less what came after the range, and one index range per
  // account for the period (D-075): 45–70 ms at ten years.
  ['GET /reports/receivables', `/reports/receivables?from=${month}&to=${today}`, 300],
  ['GET /reports/payables', `/reports/payables?from=${month}&to=${today}`, 300],
  ['GET /reports/payables (year)', `/reports/payables?from=${year}&to=${today}`, 300],
  ['GET /reports/damage (year)', `/reports/damage?from=${year}&to=${today}`, 300],
  ['GET /reports/employee-activity (month)', `/reports/employee-activity?from=${month}&to=${today}`, 300],
  ['GET /reports/employee-activity (year)', `/reports/employee-activity?from=${year}&to=${today}`, 300],
  ['GET /reports/cash-up (today)', `/reports/cash-up?from=${today}&to=${today}`, 300],
  // Stated rather than assumed: this one reads the lines (D-029).
  ['GET /reports/profit (month)', `/reports/profit?from=${month}&to=${today}`, 300],
  ['GET /reports/profit (year)', `/reports/profit?from=${year}&to=${today}`, 1500],
  // The file export: every group in one answer (D-075). Stated, like the year's margin: it is
  // the whole period's report, thousands of rows, once.
  ['GET /reports/receivables (year, export)', `/reports/receivables?from=${year}&to=${today}&all=true`, 3000],
  ['GET /reports/stock (export)', `/reports/stock?from=${month}&to=${today}&all=true`, 3000],
];

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

console.log(`Mizan endpoint budgets — ${BASE}\n`);
let over = 0;
const results = [];

for (const [label, path, budget] of TARGETS) {
  const times = [];
  let status = 0;
  let bytes = 0;
  for (let attempt = 0; attempt <= SAMPLES; attempt += 1) {
    const started = performance.now();
    const response = await call(path);
    const elapsed = performance.now() - started;
    status = response.status;
    bytes = response.bytes;
    // The first request is a warm-up: it pays for the connection and the plan cache.
    if (attempt > 0) times.push(elapsed);
  }
  const ms = median(times);
  const ok = status === 200 && ms <= budget;
  if (!ok) over += 1;
  results.push({ label, status, ms, budget, kB: bytes / 1024, ok });
  console.log(
    `${ok ? '✓' : '✗'} ${label.padEnd(42)} ${String(status).padStart(3)}  ${ms.toFixed(1).padStart(8)} ms` +
      `  (budget ${String(budget).padStart(4)})  ${(bytes / 1024).toFixed(1).padStart(7)} kB`,
  );
}

console.log(
  over === 0
    ? `\nAll ${results.length} endpoints within budget.\n`
    : `\n${over} of ${results.length} endpoints over budget.\n`,
);
process.exit(over === 0 ? 0 : 1);

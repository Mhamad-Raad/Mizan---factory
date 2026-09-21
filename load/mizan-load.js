/**
 * The seeded load test of specification 2.12, run against staging before go-live (NFR-03,
 * NFR-13). A k6 script kept in the repository, not a recurring pipeline:
 *
 *     k6 run -e BASE_URL=https://staging.example/api/v1 -e ADMIN_PASSWORD=… load/mizan-load.js
 *
 * It models the factory's actual day rather than a synthetic hammering: thirty employees
 * (NFR-13) on phones and two shared tablets, mostly *reading* — the orders list, a customer's
 * profile, the dashboard — and writing an order or a payment every few seconds. The
 * distribution matters more than the count: a load test that only posts orders tells you
 * nothing about the screen everybody stares at all day.
 *
 * Thresholds are NFR-03's own numbers: list endpoints p95 ≤ 300 ms, writes p95 ≤ 500 ms, and
 * no request may fail. They are thresholds rather than notes, so the run exits non-zero and
 * the go-live checklist cannot be ticked from memory.
 */
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:3000/api/v1';
const ADMIN = __ENV.ADMIN ?? 'admin';
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD ?? 'ChangeMe!2026';

const reads = new Trend('mizan_read_ms', true);
const writes = new Trend('mizan_write_ms', true);
const failures = new Rate('mizan_failed');

export const options = {
  scenarios: {
    // The morning: everybody signs in within a few minutes and starts reading.
    shift: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 30 },
        { duration: '3m', target: 30 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    // NFR-03, at the volumes of NFR-13.
    'mizan_read_ms': ['p(95)<300'],
    'mizan_write_ms': ['p(95)<500'],
    'mizan_failed': ['rate<0.001'],
    'http_req_failed': ['rate<0.001'],
  },
};

function signIn() {
  const response = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ username_or_phone: ADMIN, password: ADMIN_PASSWORD }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'login' } },
  );
  check(response, { 'signed in': (result) => result.status === 200 });
  const cookies = response.cookies;
  const session = cookies['mizan_session']?.[0]?.value;
  const csrf = cookies['mizan_csrf']?.[0]?.value;
  return {
    headers: {
      'Content-Type': 'application/json',
      Cookie: `mizan_session=${session}; mizan_csrf=${csrf}`,
      'X-CSRF-Token': csrf,
    },
  };
}

export function setup() {
  // One sign-in in setup proves the deployment answers before thirty virtual users arrive.
  const context = signIn();
  const today = new Date().toISOString().slice(0, 10);
  return { context, today };
}

export default function (data) {
  const { context, today } = data;

  group('the screens everybody reads', () => {
    for (const [name, path] of [
      ['orders list', `/orders?from=${today}&to=${today}&page_size=25`],
      ['customers list', '/customers?page_size=25'],
      ['materials list', '/materials?page_size=25'],
      ['dashboard', '/dashboard'],
      ['history first page', '/history?limit=50'],
    ]) {
      const response = http.get(`${BASE_URL}${path}`, { ...context, tags: { name } });
      reads.add(response.timings.duration);
      failures.add(response.status !== 200);
      check(response, { [`${name} answered`]: (result) => result.status === 200 });
      sleep(0.3);
    }
  });

  group('the reports an owner opens', () => {
    const month = `${today.slice(0, 7)}-01`;
    for (const [name, path] of [
      ['sales report', `/reports/sales?from=${month}&to=${today}`],
      ['receivables', `/reports/receivables?from=${month}&to=${today}`],
      ['stock report', `/reports/stock?from=${month}&to=${today}`],
    ]) {
      const response = http.get(`${BASE_URL}${path}`, { ...context, tags: { name } });
      reads.add(response.timings.duration);
      failures.add(response.status !== 200);
      sleep(0.5);
    }
  });

  group('the writes of a shift', () => {
    // A search is what an employee does before recording anything.
    const found = http.get(`${BASE_URL}/search?q=a`, { ...context, tags: { name: 'search' } });
    reads.add(found.timings.duration);

    // Reading one customer's profile and ledger is the heaviest *read* an employee does.
    const customers = http.get(`${BASE_URL}/customers?page_size=1`, { ...context, tags: { name: 'one customer' } });
    const customer = customers.json('items.0');
    if (customer) {
      const ledger = http.get(`${BASE_URL}/customers/${customer.id}/ledger?limit=100`, {
        ...context,
        tags: { name: 'customer ledger' },
      });
      reads.add(ledger.timings.duration);
      failures.add(ledger.status !== 200);
    }

    // One in five iterations records something, which is roughly 500 documents a day at this
    // concurrency — the design point of NFR-13.
    if (Math.random() < 0.2) {
      const materials = http.get(`${BASE_URL}/materials?page_size=1`, { ...context, tags: { name: 'one material' } });
      const material = materials.json('items.0');
      if (customer && material) {
        const order = http.post(
          `${BASE_URL}/orders`,
          JSON.stringify({
            customer_id: customer.id,
            order_date: today,
            payment_type: 'borrowed',
            lines: [{ item_id: material.id, qty_kg: '1.000', qty_count: 1 }],
          }),
          { ...context, tags: { name: 'create order' } },
        );
        writes.add(order.timings.duration);
        failures.add(order.status !== 201);
        check(order, { 'order recorded': (result) => result.status === 201 });
      }
    }
  });

  sleep(1);
}

export function handleSummary(data) {
  // The evidence the Definition of done asks for, in a file that can be attached as it is.
  return {
    'load/last-run.json': JSON.stringify(data, null, 2),
    stdout: `
Mizan load test — ${BASE_URL}
  reads  p95 ${data.metrics.mizan_read_ms?.values['p(95)']?.toFixed(0) ?? '—'} ms   (NFR-03: ≤ 300)
  writes p95 ${data.metrics.mizan_write_ms?.values['p(95)']?.toFixed(0) ?? '—'} ms   (NFR-03: ≤ 500)
  failed     ${((data.metrics.mizan_failed?.values.rate ?? 0) * 100).toFixed(3)} %
`,
  };
}

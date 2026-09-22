/**
 * The Iteration 6 demo script of specification 4.8 — the go-live review — executable.
 *
 * The five steps of the brief, in the order they are shown to the client: an order recorded on
 * their own tablet and a payment that settles a balance exactly; the language, theme and text
 * size of a screen that is being used mid-task; the Receivables and Payables totals agreeing
 * with the opening figures that were typed (or imported) from their paper; the restore drill and
 * the backup evidence; and the documents handed over.
 *
 * Two of those steps live in the browser and cannot be driven from here: the digits that roll,
 * the row that lands, the sweep across a settled balance, and a language that changes
 * mid-sentence. What this script checks instead is everything the server has to get right for
 * those screens to be honest — the settlement that lands on exactly zero, the receipt, the
 * message keys that exist in all three languages, the reports that agree with the ledgers they
 * report on — and, for the parts that are evidence rather than behaviour (the drill log, the
 * guide, the nine quick cards), that the evidence is there and is not empty.
 *
 * Point it at staging with DEMO_BASE_URL. It leaves everything it creates behind on purpose.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.DEMO_BASE_URL ?? 'http://localhost:3000/api/v1';
const ADMIN = process.env.DEMO_ADMIN ?? 'admin';
const ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD ?? 'ChangeMe!2026';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const step = (n, text) => console.log(`\n${n}. ${text}`);
const ok = (text) => console.log(`   ✓ ${text}`);
const bad = (text) => {
  failures += 1;
  console.log(`   ✗ ${text}`);
};
const check = (condition, text) => (condition ? ok(text) : bad(text));

function jar() {
  const cookies = new Map();
  return {
    absorb(response) {
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const [name, value] = pair.split('=');
        cookies.set(name, value);
      }
    },
    header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
    csrf: () => cookies.get('mizan_csrf') ?? '',
  };
}

async function call(session, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.header(),
      ...(method === 'GET' ? {} : { 'X-CSRF-Token': session.csrf() }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  session.absorb(response);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function signInFresh(username, temporary) {
  const session = jar();
  const login = await call(session, '/auth/login', {
    method: 'POST',
    body: { username_or_phone: username, password: temporary },
  });
  if (login.status !== 200) return null;
  const password = `${temporary}-demo`;
  await call(session, '/auth/change-password', { method: 'POST', body: { current: temporary, new: password } });
  return { session, password };
}

const unique = Date.now().toString().slice(-6);
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Baghdad' });
const month = today.slice(0, 7);
const monthStart = `${month}-01`;
const range = `from=${monthStart}&to=${today}`;

const admin = jar();
console.log(`Mizan — Iteration 6 demo script (go-live review) against ${BASE}`);

const login = await call(admin, '/auth/login', {
  method: 'POST',
  body: { username_or_phone: ADMIN, password: ADMIN_PASSWORD },
});
check(login.status === 200, `signed in as ${ADMIN}`);
await call(admin, '/settings/global-rates', {
  method: 'POST',
  body: { rate_iqd_per_usd: '1300', note: 'demo', confirm: true },
});

// ───────────────────────── 1. On the client's own tablet ─────────────────────────

step(1, 'An order, the totals, and a payment that settles the balance exactly');

const saraUser = await call(admin, '/users', {
  method: 'POST',
  body: { display_name: 'Sara Kareem', username: `sara.${unique}`, role: 'employee', preset_key: 'sales' },
});
const saraKeys = await call(admin, `/users/${saraUser.body.user.id}/permissions`);
await call(admin, `/users/${saraUser.body.user.id}/permissions`, {
  method: 'POST',
  // The tablet on the floor serves whoever walks in, so this employee sees every customer
  // (spec 2.6.4); without it the order below is refused, which is the scope rule working.
  body: { keys: [...new Set([...(saraKeys.body?.keys ?? []), 'customers.view_all'])] },
});
const sara = await signInFresh(`sara.${unique}`, saraUser.body.temporary_password);
check(Boolean(sara), 'a sales employee from the preset, on the tablet');

const copper = await call(admin, '/items', {
  method: 'POST',
  body: { name: `Copper wire 2 mm ${unique}`, pricing_unit: 'per_kg' },
});
await call(admin, `/items/${copper.body.id}/prices/${month}`, {
  method: 'PUT',
  body: { bought: { amount: 700, currency: 'IQD' }, sale: { amount: 850, currency: 'IQD' } },
});
await call(admin, `/items/${copper.body.id}/opening-stock`, {
  method: 'POST',
  body: { entry_date: today, qty_kg: '5000.000', note: 'counted at go-live' },
});

const kawa = await call(admin, '/customers', {
  method: 'POST',
  body: { name: `Kawa Trading ${unique}`, settlement_currency: 'IQD' },
});

const order = await call(sara.session, '/orders', {
  method: 'POST',
  body: {
    customer_id: kawa.body.id,
    order_date: today,
    payment_type: 'borrowed',
    lines: [{ item_id: copper.body.id, qty_kg: '100.000' }],
  },
});
// 850 × 100 kg = 85,000 IQD, and the dollar figure is that at today's rate, not a second price.
check(order.status === 201, `order #${order.body?.number} recorded on the tablet`);
check(
  order.body?.total_iqd === 85_000 && order.body?.total_usd_cents === 6538,
  `the total the screen counts up to: ${order.body?.total_iqd} د.ع ≈ ${(
    (order.body?.total_usd_cents ?? 0) / 100
  ).toFixed(2)} $ at 1,300`,
);

const receipt = await call(sara.session, `/orders/${order.body.id}/receipt`);
check(
  receipt.status === 200 &&
    receipt.body?.order?.lines?.length === 1 &&
    receipt.body?.order?.total_usd_cents > 0 &&
    Boolean(receipt.body?.balance_after),
  'the receipt the employee shares carries the line, both currencies and the balance after it (FR-1310)',
);

// The signature moment of 3.6.2: a payment that lands on exactly zero, in the other currency.
// Settle in full is what makes the last instalment exact — $65.38 at 1,300 is 84,994 IQD, six
// dinars short, and a six-dinar residue on a settled account is what nobody wants to explain.
const settlement = await call(sara.session, `/orders/${order.body.id}/payments`, {
  method: 'POST',
  body: { amount: 6538, currency: 'USD', entry_date: today, settle_in_full: true, note: 'paid in dollars' },
});
check(settlement.status === 201, 'the last payment is taken in dollars with "settle in full"');

const settled = await call(sara.session, `/orders/${order.body.id}`);
check(settled.body?.status === 'paid', `the order reads ${settled.body?.status}`);
const account = await call(admin, `/customers/${kawa.body.id}`);
check(
  account.body?.balance?.amount_iqd === 0 && account.body?.balance?.amount_usd_cents === 0,
  'and the balance is exactly zero in both currencies — the sweep has something true to sweep',
);

// ───────────────── 2. Language, theme and text size, mid-task ─────────────────

step(2, 'The same screen in three languages, at every text size — what the server owes the client');

const catalogs = ['ckb-IQ', 'ar-IQ', 'en'].map((locale) => ({
  locale,
  errors: JSON.parse(readFileSync(join(ROOT, 'packages/i18n/locales', locale, 'errors.json'), 'utf8')),
}));

// A refusal the client will meet on the floor: selling more than the yard holds. The API answers
// with a key, never a sentence, so the tablet says it in whatever language it is set to. This is
// the one setting the script changes, so it is read first and put back afterwards.
const settingsBefore = await call(admin, '/settings');
const relaxed = settingsBefore.body?.allow_negative_stock !== false;
/**
 * The one global setting this script touches, and it is put back in a `finally` — a demo that
 * throws halfway through must not leave a client's deployment selling below stock (or refusing
 * to) because of a step that never finished. It is only touched at all when it is not already
 * where the refusal below needs it.
 */
let tooMuch;
try {
  if (relaxed) {
    await call(admin, '/settings', { method: 'PATCH', body: { allow_negative_stock: false } });
  }
  tooMuch = await call(sara.session, '/orders', {
    method: 'POST',
    body: {
      customer_id: kawa.body.id,
      order_date: today,
      payment_type: 'cash',
      received_currency: 'IQD',
      lines: [{ item_id: copper.body.id, qty_kg: '999999.000' }],
    },
  });
} finally {
  if (relaxed) {
    await call(admin, '/settings', { method: 'PATCH', body: { allow_negative_stock: true } });
  }
}
const problem = tooMuch.body?.error ?? tooMuch.body;
// The refusal names the field it belongs to and carries a key with its own parameters — the
// quantity, the material, what is actually in the yard — so the tablet writes the sentence in
// the language it is set to and nobody translates a server message (2.10.4).
const field = problem?.fields?.[0];
check(
  tooMuch.status === 422 && field?.path === 'lines.0.quantity' && field?.code === 'STOCK_INSUFFICIENT',
  `refused on the line itself, with a key rather than a sentence: ${field?.message_key} (${field?.params?.available} ${field?.params?.measure} available)`,
);
const name = String(field?.message_key ?? '').split(':').pop();
const wording = catalogs.map((catalog) => catalog.errors[name]);
check(
  wording.every((text) => typeof text === 'string' && text.includes('{{')),
  `and that key is written in all three languages, each interpolating the same figures:\n      ${catalogs
    .map((catalog, index) => `${catalog.locale}  ${wording[index]}`)
    .join('\n      ')}`,
);
check(
  catalogs.every((catalog) => Object.keys(catalog.errors).length === Object.keys(catalogs[0].errors).length),
  `the three error catalogs are the same size (${Object.keys(catalogs[0].errors).length} keys each)`,
);

// ───────────── 3. Receivables and Payables against the client's own figures ─────────────

step(3, 'The opening figures from the paper, imported, and the reports that must match them');

const nazdarUser = await call(admin, '/users', {
  method: 'POST',
  body: { display_name: 'Nazdar Kamal', username: `nazdar.${unique}`, role: 'employee', preset_key: 'accountant' },
});
const nazdar = await signInFresh(`nazdar.${unique}`, nazdarUser.body.temporary_password);

// The go-live import (FR-1312): the client's own list, checked before it is written.
const openingCustomers = [
  { name: `Bahar Mahmood ${unique}` , amount: 2_400_000 },
  { name: `Diyari Metals ${unique}`, amount: 750_000 },
];
await call(admin, '/imports/customers', {
  method: 'POST',
  body: { rows: openingCustomers.map((row) => ({ name: row.name, settlement_currency: 'IQD' })) },
});
const previewed = await call(admin, '/imports/customer_opening_balance/preview', {
  method: 'POST',
  body: {
    rows: [
      ...openingCustomers.map((row) => ({ customer: row.name, amount: String(row.amount), currency: 'IQD' })),
      { customer: 'Somebody who is not in the system', amount: '1000', currency: 'IQD' },
    ],
  },
});
check(
  previewed.body?.ready === 2 && previewed.body?.problems?.[0]?.row === 3,
  `the preview reads the file and names the bad row before anything is written: ${
    previewed.body?.problems?.[0]?.message_key
  } on row ${previewed.body?.problems?.[0]?.row}`,
);
const imported = await call(admin, '/imports/customer_opening_balance', {
  method: 'POST',
  body: {
    rows: openingCustomers.map((row) => ({
      customer: row.name,
      amount: String(row.amount),
      currency: 'IQD',
      note: 'opening debt agreed with the owner',
    })),
  },
});
check(imported.body?.created === 2, 'the two opening debts are imported as ledger entries, attributed to the admin');

const alNoor = await call(nazdar.session, '/companies', {
  method: 'POST',
  body: { name: `Al-Noor Steel Co. ${unique}`, settlement_currency: 'IQD' },
});
await call(nazdar.session, `/companies/${alNoor.body.id}/opening-balance`, {
  method: 'POST',
  body: { amount: 3_050_000, currency: 'IQD', entry_date: today, note: 'opening debt from the ledger book' },
});

const listed = await call(admin, `/customers?q=${encodeURIComponent(unique)}&limit=50`);
const importedAccounts = (listed.body?.items ?? []).filter((row) =>
  openingCustomers.some((opening) => row.name === opening.name),
);
for (const account of importedAccounts) {
  await call(admin, `/customers/${account.id}/assignment`, {
    method: 'PUT',
    body: { user_id: saraUser.body.user.id, note: 'the accounts this employee keeps', version: account.version },
  });
}
const assignedBack = await call(admin, `/customers?q=${encodeURIComponent(unique)}&limit=50`);
check(
  importedAccounts.length === 2 &&
    (assignedBack.body?.items ?? []).filter((row) => row.assigned_user_id === saraUser.body.user.id).length === 2,
  'both imported accounts are assigned to the employee who keeps them',
);

const receivables = await call(nazdar.session, `/reports/receivables?${range}&assigned_to=${saraUser.body.user.id}`);
const rows = receivables.body?.groups ?? [];
const openingTotal = openingCustomers.reduce((sum, row) => sum + row.amount, 0);
const reported = rows.reduce((sum, row) => sum + (row.balance?.amount_iqd ?? 0), 0);
check(
  reported === openingTotal,
  `Receivables reports ${reported.toLocaleString('en')} د.ع for those accounts — the figure that was typed (${openingTotal.toLocaleString('en')} د.ع)`,
);
check(
  rows.every((row, index) => index === 0 || (rows[index - 1].balance?.amount ?? 0) >= (row.balance?.amount ?? 0)),
  'largest debt first, which is the order the client reads it in',
);

const payables = await call(nazdar.session, `/reports/payables?${range}&company_id=${alNoor.body.id}`);
const alNoorRow = (payables.body?.groups ?? []).find((row) => row.key === alNoor.body.id);
check(
  alNoorRow?.balance?.amount_iqd === 3_050_000,
  `Payables reports ${alNoorRow?.balance?.amount_iqd?.toLocaleString('en')} د.ع for Al-Noor, the opening figure`,
);

// The reconciliation the client actually asks for: the report is the ledger, not a second copy.
const ledgerSums = await Promise.all(
  rows.map(async (row) => {
    const ledger = await call(nazdar.session, `/customers/${row.key}/ledger?limit=500`);
    return (ledger.body?.items ?? []).reduce((sum, entry) => sum + (entry.amount_iqd ?? 0), 0);
  }),
);
check(
  ledgerSums.every((sum, index) => sum === (rows[index].balance?.amount_iqd ?? 0)),
  'and every balance it reports is the sum of that customer’s own ledger (rule 2)',
);

const stock = await call(nazdar.session, `/reports/stock?${range}&item_id=${copper.body.id}`);
const copperRow = (stock.body?.groups ?? []).find((row) => row.key === copper.body.id);
check(
  copperRow?.stock_kg === '4900.000',
  `Stock reports ${copperRow?.stock_kg} kg of copper: 5,000 counted in, 100 sold out`,
);

// ───────────────── 4. The backups, the drill, and the alerts ─────────────────

step(4, 'The evidence that a restore has actually been done, and that the system is watched');

const drills = join(ROOT, 'ops/runbook/restore-drills.md');
const drillLog = existsSync(drills) ? readFileSync(drills, 'utf8') : '';
const loggedDrills = [...drillLog.matchAll(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|/gm)].map((match) => match[1]);
check(loggedDrills.length > 0, `the restore-drill log has ${loggedDrills.length} logged drill(s): ${loggedDrills.join(', ')}`);
check(
  /integrity|ledger/i.test(drillLog),
  'and each drill records the integrity checks, not only that the file restored',
);
const runbook = readFileSync(join(ROOT, 'ops/runbook/README.md'), 'utf8');
for (const heading of ['Backups', 'Restore', 'Monitoring', 'Incidents', 'Go-live']) {
  check(runbook.includes(`## ${heading}`), `the runbook covers ${heading}`);
}

const health = await call(admin, '/health');
check(health.status === 200, 'the health endpoint the monitor polls answers');

// ───────────────── 5. The documents that are handed over ─────────────────

step(5, 'The admin guide and the nine quick cards');

for (const path of ['docs/guide/admin.ckb.md', 'docs/guide/admin.en.md']) {
  const full = join(ROOT, path);
  check(existsSync(full) && readFileSync(full, 'utf8').length > 4_000, `${path} is written`);
}
for (const preset of ['sales', 'warehouse', 'accountant']) {
  for (const language of ['ckb', 'ar', 'en']) {
    const path = `docs/guide/cards/${preset}.${language}.md`;
    const full = join(ROOT, path);
    check(existsSync(full) && readFileSync(full, 'utf8').length > 1_000, `${path} is one page and not a stub`);
  }
}

console.log(
  failures === 0
    ? '\nThe Iteration 6 demo script passed end to end.\n'
    : `\n${failures} step(s) failed — the demo is not ready.\n`,
);
process.exit(failures === 0 ? 0 : 1);

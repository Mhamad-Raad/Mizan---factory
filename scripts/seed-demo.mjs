/**
 * Demo data for the one-record-per-business structure (D-054), written through the API so every
 * row passes the same rules, lands in History and moves the ledgers exactly as real use would.
 *
 * Run it against an empty database that has only its first admin (`pnpm db:migrate && pnpm
 * db:seed`), with the API up:
 *
 *   DEMO_ADMIN_NEW_PASSWORD='…' node scripts/seed-demo.mjs
 *
 * (the new admin password is needed only on a fresh database, whose admin must change it first).
 *
 * It stops at the first refused request and says which, rather than leaving half a story.
 * What it makes:
 *   · three employees (sales, warehouse, accountant) with passwords printed at the end;
 *   · eight materials, each bought when it was created and some bought again at a new price;
 *   · seven companies that buy from us, some with their own rate;
 *   · six weeks of cash and borrowed orders, payments received and an opening balance;
 *   · damage of our own, one a company still owes for, and two a company paid back;
 *   · five of the accountant's own expenses (D-062).
 */
const BASE = process.env.DEMO_BASE_URL ?? 'http://localhost:3000/api/v1';
const ADMIN = process.env.DEMO_ADMIN ?? 'admin';
const ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD ?? 'ChangeMe!2026';
const EMPLOYEE_PASSWORD = process.env.DEMO_EMPLOYEE_PASSWORD ?? 'Mizan-demo-2026';
/**
 * A fresh database's first admin must change the password before anything else (FR-101). The
 * new one is never invented here — an admin password nobody chose is a password nobody knows.
 */
const ADMIN_NEW_PASSWORD = process.env.DEMO_ADMIN_NEW_PASSWORD;

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
  const parsed = text ? JSON.parse(text) : null;
  if (response.status >= 300) {
    console.error(`\n✗ ${method} ${path} → ${response.status}`);
    console.error(JSON.stringify(parsed, null, 2));
    process.exit(1);
  }
  return parsed;
}

const post = (session, path, body) => call(session, path, { method: 'POST', body });
const put = (session, path, body) => call(session, path, { method: 'PUT', body });

/** A Baghdad business day `n` days ago, as the API reads dates (2.9.4). */
function daysAgo(n) {
  const date = new Date(Date.now() - n * 86_400_000);
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Baghdad' });
}
const monthOf = (isoDate) => isoDate.slice(0, 7);

const admin = jar();
console.log(`Mizan — demo data against ${BASE}`);
const signedIn = await post(admin, '/auth/login', { username_or_phone: ADMIN, password: ADMIN_PASSWORD });
if (signedIn.user?.must_change_password) {
  if (!ADMIN_NEW_PASSWORD) {
    console.error('✗ the admin must change the first password: set DEMO_ADMIN_NEW_PASSWORD and run again');
    process.exit(1);
  }
  await post(admin, '/auth/change-password', { current: ADMIN_PASSWORD, new: ADMIN_NEW_PASSWORD });
  console.log('· the admin password was changed to DEMO_ADMIN_NEW_PASSWORD');
}
const existing = await call(admin, '/customers?page_size=5');
// The walk-in customer is always there; anything more means this is not an empty database.
if (existing.total > 1) {
  console.error('✗ this database already has businesses in it — seed an empty one');
  process.exit(1);
}

// ── the rate and the people ──────────────────────────────────────────────────────────────

await post(admin, '/settings/global-rates', { rate_iqd_per_usd: '1310', note: 'demo: the market rate' });

async function employee(displayName, username, preset) {
  const created = await post(admin, '/users', {
    display_name: displayName,
    username,
    role: 'employee',
    preset_key: preset,
  });
  // Their first sign-in exchanges the temporary password for the one printed at the end.
  const session = jar();
  await post(session, '/auth/login', { username_or_phone: username, password: created.temporary_password });
  await post(session, '/auth/change-password', { current: created.temporary_password, new: EMPLOYEE_PASSWORD });
  return created.user.id;
}
const rebaz = await employee('Rebaz Omar', 'rebaz', 'sales');
const hemin = await employee('Hemin Aziz', 'hemin', 'warehouse');
await employee('Nazdar Karim', 'nazdar', 'accountant');
console.log('✓ three employees');

// ── the warehouse: materials, bought at more than one price ──────────────────────────────
//
// Creating a material *is* buying it (D-062): each one arrives with its first buy, and some get
// a second shipment later at a different price — the same material on the same row, the two
// buys kept apart so a sale is costed at what the stock it sold actually cost.

const MATERIALS = [
  // name, unit, sale price, first buy [qty, unit cost, days ago], later buy or null
  ['Steel sheet 1.2 mm', 'per_kg', 1_150, [8000, 950, 44], [4000, 990, 18]],
  ['Copper wire 2 mm', 'per_kg', 9_800, [600, 8_600, 44], [400, 9_100, 12]],
  ['Rebar 12 mm', 'per_kg', 890, [9000, 760, 44], [6000, 745, 7]],
  ['Stainless sheet 1 mm', 'per_kg', 3_900, [1200, 3_300, 40], null],
  ['Welding rod 3.2 mm', 'per_kg', 4_200, [400, 3_500, 40], [250, 3_650, 7]],
  ['Aluminium profile 6 m', 'per_piece', 24_000, [150, 19_500, 35], [150, 21_000, 10]],
  ['Galvanised pipe 2"', 'per_piece', 31_000, [180, 26_000, 26], null],
  ['Primer paint 20 L', 'per_piece', 42_000, [60, 35_000, 14], null],
];
const months = [...new Set([daysAgo(0), daysAgo(31), daysAgo(62)].map(monthOf))];
const item = {};
const quantity = (unit, qty) => (unit === 'per_kg' ? { qty_kg: qty.toFixed(3) } : { qty_count: qty });
for (const [name, unit, sale, first] of MATERIALS) {
  const [qty, cost, back] = first;
  const created = await post(admin, '/items', {
    name,
    pricing_unit: unit,
    buy: { ...quantity(unit, qty), unit_price: { amount: cost, currency: 'IQD' }, purchase_date: daysAgo(back) },
  });
  item[name] = { id: created.id, unit };
  for (const month of months) {
    // The month's bought price is only the suggestion the next buy opens with.
    await put(admin, `/items/${created.id}/prices/${month}`, {
      sale: { amount: sale, currency: 'IQD' },
      bought: { amount: cost, currency: 'IQD' },
    });
  }
}
let laterBuys = 0;
for (const [name, unit, , , later] of MATERIALS) {
  if (!later) continue;
  const [qty, cost, back] = later;
  await post(admin, '/purchases', {
    company_id: null,
    purchase_date: daysAgo(back),
    acting_user_id: hemin,
    notes: 'new shipment',
    lines: [{ item_id: item[name].id, ...quantity(unit, qty), unit_price: { amount: cost, currency: 'IQD' } }],
  });
  laterBuys += 1;
}
console.log(`✓ ${MATERIALS.length} materials bought, ${laterBuys} of them bought again at a new price`);

// ── the companies that buy from us ─────────────────────────────────────────────────────────

async function company(body, rate) {
  // Its own conversion rate is typed on the same form (D-055); without one the system rate applies.
  const created = await post(admin, '/customers', rate ? { ...body, rate_iqd_per_usd: rate } : body);
  return created.id;
}
const kawa = await company({ name: 'Kawa Trading', phone: '0750 123 4567', address: 'Erbil, Industrial Area' }, '1315');
const hawler = await company({ name: 'Hawler Construction', phone: '0751 987 6543', settlement_currency: 'USD' });
const slemani = await company({ name: 'Slemani Build Co.', phone: '0770 222 1100' });
const duhok = await company({ name: 'Duhok Fabrication', phone: '0750 444 7788' });
const azadi = await company({ name: 'Azadi Workshop', phone: '0771 300 2020' });
const erbilMetal = await company({ name: 'Erbil Metal House', contact_name: 'Dilshad', phone: '0750 909 8080' }, '1312');
const baghdadPipe = await company(
  { name: 'Baghdad Pipe Trading', contact_name: 'Haider', settlement_currency: 'USD' },
  '1310',
);
console.log('✓ seven companies, three with their own rate');

// ── six weeks of selling ────────────────────────────────────────────────────────────────

const sold = (name, qty) => ({ item_id: item[name].id, ...quantity(item[name].unit, qty) });
async function order(customerId, daysBack, lines, payment = 'borrowed', received = 'IQD', notes = null) {
  return post(admin, '/orders', {
    customer_id: customerId,
    order_date: daysAgo(daysBack),
    payment_type: payment,
    received_currency: payment === 'cash' ? received : null,
    acting_user_id: rebaz,
    notes,
    lines,
  });
}
const o1 = await order(kawa, 42, [sold('Steel sheet 1.2 mm', 1500), sold('Rebar 12 mm', 2000)]);
const o2 = await order(hawler, 25, [sold('Aluminium profile 6 m', 80), sold('Galvanised pipe 2"', 40)]);
await order(slemani, 36, [sold('Rebar 12 mm', 2500)], 'cash', 'IQD', 'paid at the gate');
const o4 = await order(erbilMetal, 33, [sold('Steel sheet 1.2 mm', 2200), sold('Welding rod 3.2 mm', 60)]);
const o5 = await order(duhok, 29, [sold('Stainless sheet 1 mm', 300), sold('Welding rod 3.2 mm', 80)]);
const o6 = await order(baghdadPipe, 9, [sold('Primer paint 20 L', 20), sold('Aluminium profile 6 m', 90)]);
await order(azadi, 21, [sold('Copper wire 2 mm', 120)], 'cash', 'USD');
const o8 = await order(kawa, 17, [sold('Galvanised pipe 2"', 30)]);
const o9 = await order(hawler, 12, [sold('Steel sheet 1.2 mm', 1800), sold('Primer paint 20 L', 10)]);
const o10 = await order(erbilMetal, 6, [sold('Rebar 12 mm', 3000)]);
await order(duhok, 5, [sold('Copper wire 2 mm', 550)], 'cash', 'IQD');
const o12 = await order(slemani, 2, [sold('Stainless sheet 1 mm', 180), sold('Welding rod 3.2 mm', 40)]);
await order(kawa, 0, [sold('Rebar 12 mm', 1200)]);
console.log('✓ thirteen orders, four of them cash — some reaching into a second, dearer buy');

// ── money coming in ─────────────────────────────────────────────────────────────────────

const received = (orderId, amount, currency, daysBack, note) =>
  post(admin, `/orders/${orderId}/payments`, { amount, currency, entry_date: daysAgo(daysBack), note });
await received(o1.id, 1_500_000, 'IQD', 35, 'first instalment');
await received(o1.id, 1_000_000, 'IQD', 20, 'second instalment');
await received(o2.id, 200_000, 'USD', 20, 'bank transfer');
await received(o4.id, 1_800_000, 'IQD', 25, null);
await received(o5.id, o5.remaining, 'IQD', 22, 'paid in full');
await received(o6.id, 30_000, 'USD', 5, null);
await received(o8.id, 400_000, 'IQD', 10, null);
await received(o9.id, 100_000, 'USD', 6, null);
await received(o10.id, 1_000_000, 'IQD', 3, null);
await received(o12.id, 300_000, 'IQD', 1, 'deposit');
console.log('✓ ten payments received');

// A balance carried over from paper at go-live.
await post(admin, `/customers/${azadi}/opening-balance`, {
  amount: 750_000,
  currency: 'IQD',
  entry_date: daysAgo(45),
  note: 'owed from the old notebook',
});
console.log('✓ an opening balance');

// ── damage: ours, and companies' — one still owed, two paid back ────────────────────────

await post(admin, '/damages', {
  item_id: item['Primer paint 20 L'].id,
  qty_count: 2,
  damage_date: daysAgo(8),
  attribution: 'us',
  reason: 'dropped from the rack',
  acting_user_id: hemin,
});
await post(admin, '/damages', {
  item_id: item['Aluminium profile 6 m'].id,
  qty_count: 5,
  damage_date: daysAgo(4),
  attribution: 'company',
  company_id: hawler,
  reason: 'their forklift bent five profiles while loading',
  acting_user_id: hemin,
});
const rebarDamage = await post(admin, '/damages', {
  item_id: item['Rebar 12 mm'].id,
  qty_kg: '150.000',
  damage_date: daysAgo(15),
  attribution: 'company',
  company_id: kawa,
  reason: 'dropped from their truck at our gate',
  acting_user_id: hemin,
});
await post(admin, `/damages/${rebarDamage.id}/paid-back`, { method: 'money', entry_date: daysAgo(11) });
const copperDamage = await post(admin, '/damages', {
  item_id: item['Copper wire 2 mm'].id,
  qty_kg: '20.000',
  damage_date: daysAgo(9),
  attribution: 'company',
  company_id: duhok,
  reason: 'a coil cut while they were loading',
  acting_user_id: hemin,
});
await post(admin, `/damages/${copperDamage.id}/paid-back`, { method: 'materials', entry_date: daysAgo(3) });
console.log('✓ four damage records: ours, one owed by a company, one paid back in money, one in materials');

// ── the accountant's own expenses ───────────────────────────────────────────────────────

const expense = (daysBack, title, amount, currency, note = null) =>
  post(admin, '/expenses', { expense_date: daysAgo(daysBack), title, amount: { amount, currency }, note });
await expense(40, 'Warehouse rent', 50_000, 'USD', 'last month');
await expense(10, 'Warehouse rent', 50_000, 'USD', 'this month');
await expense(12, 'Electricity', 380_000, 'IQD');
await expense(6, 'Salaries — loaders', 2_400_000, 'IQD');
await expense(2, 'Forklift repair', 175_000, 'IQD', 'hydraulic hose');
console.log('✓ five expenses');

console.log(`\nDone. Employees sign in as rebaz, hemin and nazdar with "${EMPLOYEE_PASSWORD}".`);

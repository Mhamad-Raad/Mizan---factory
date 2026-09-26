/**
 * Demo data for the one-record-per-business structure (D-054), written through the API so every
 * row passes the same rules, lands in History and moves the ledgers exactly as real use would.
 *
 * Run it against an empty database that has only its first admin (`pnpm db:migrate && pnpm
 * db:seed`), with the API up:
 *
 *   node scripts/seed-demo.mjs
 *
 * It stops at the first refused request and says which, rather than leaving half a story.
 * What it makes:
 *   · three employees (sales, warehouse, accountant) with passwords printed at the end;
 *   · eight materials with prices for this month and the two before it;
 *   · ten businesses — five customers, three companies we buy from, and two that are both, so
 *     the net balance has something to net — some with their own rate;
 *   · six weeks of purchases, cash and borrowed orders, payments both ways, a supplier credit,
 *     opening balances on both sides, and two damage records.
 */
const BASE = process.env.DEMO_BASE_URL ?? 'http://localhost:3000/api/v1';
const ADMIN = process.env.DEMO_ADMIN ?? 'admin';
const ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD ?? 'ChangeMe!2026';
const EMPLOYEE_PASSWORD = process.env.DEMO_EMPLOYEE_PASSWORD ?? 'Mizan-demo-2026';

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
await post(admin, '/auth/login', { username_or_phone: ADMIN, password: ADMIN_PASSWORD });
const existing = await call(admin, '/customers?page_size=5&side=supplier');
if (existing.total > 0) {
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

// ── materials and their prices ───────────────────────────────────────────────────────────

const MATERIALS = [
  ['Steel sheet 1.2 mm', 'per_kg', 1_150, 950],
  ['Copper wire 2 mm', 'per_kg', 9_800, 8_600],
  ['Rebar 12 mm', 'per_kg', 890, 760],
  ['Stainless sheet 1 mm', 'per_kg', 3_900, 3_300],
  ['Welding rod 3.2 mm', 'per_kg', 4_200, 3_500],
  ['Aluminium profile 6 m', 'per_piece', 24_000, 19_500],
  ['Galvanised pipe 2"', 'per_piece', 31_000, 26_000],
  ['Primer paint 20 L', 'per_piece', 42_000, 35_000],
];
const months = [...new Set([daysAgo(0), daysAgo(31), daysAgo(62)].map(monthOf))];
const item = {};
for (const [name, unit, sale, bought] of MATERIALS) {
  const created = await post(admin, '/items', { name, pricing_unit: unit });
  item[name] = { id: created.id, unit };
  for (const month of months) {
    await put(admin, `/items/${created.id}/prices/${month}`, {
      sale: { amount: sale, currency: 'IQD' },
      bought: { amount: bought, currency: 'IQD' },
    });
  }
}
console.log(`✓ ${MATERIALS.length} materials, priced for ${months.join(', ')}`);

// ── the businesses: customers, companies, and both ──────────────────────────────────────

async function business(body, rate) {
  const created = await post(admin, '/customers', body);
  if (rate) await post(admin, `/customers/${created.id}/rates`, { rate_iqd_per_usd: rate, note: 'agreed rate' });
  return created.id;
}
const kawa = await business(
  { name: 'Kawa Trading', phone: '0750 123 4567', address: 'Erbil, Industrial Area', assigned_user_id: rebaz },
  '1315',
);
const hawler = await business({
  name: 'Hawler Construction',
  phone: '0751 987 6543',
  settlement_currency: 'USD',
  assigned_user_id: rebaz,
});
const slemani = await business({ name: 'Slemani Build Co.', phone: '0770 222 1100', assigned_user_id: rebaz });
const duhok = await business({ name: 'Duhok Fabrication', phone: '0750 444 7788' });
const azadi = await business({ name: 'Azadi Workshop', phone: '0771 300 2020' });

const alNoor = await business(
  {
    name: 'Al-Noor Steel Co.',
    is_customer: false,
    is_supplier: true,
    contact_name: 'Abu Ahmad',
    phone: '0751 222 3344',
  },
  '1305',
);
const gulf = await business(
  { name: 'Gulf Steel FZE', is_customer: false, is_supplier: true, contact_name: 'Samir', settlement_currency: 'USD' },
  '1300',
);
const zagros = await business({
  name: 'Zagros Metals Supply',
  is_customer: false,
  is_supplier: true,
  contact_name: 'Karwan',
  phone: '0770 555 1212',
});

// Both sides: we buy copper from Erbil Metal House and sell it steel; Baghdad Pipe Trading
// sells us pipe and buys paint and profile back.
const erbilMetal = await business(
  {
    name: 'Erbil Metal House',
    is_customer: true,
    is_supplier: true,
    contact_name: 'Dilshad',
    phone: '0750 909 8080',
    assigned_user_id: rebaz,
  },
  '1312',
);
const baghdadPipe = await business(
  {
    name: 'Baghdad Pipe Trading',
    is_customer: true,
    is_supplier: true,
    contact_name: 'Haider',
    settlement_currency: 'USD',
  },
  '1310',
);
console.log('✓ ten businesses: five customers, three companies, two both');

// ── six weeks of buying ─────────────────────────────────────────────────────────────────

const line = (name, quantity, total, currency = 'IQD') => {
  const material = item[name];
  return {
    item_id: material.id,
    ...(material.unit === 'per_kg' ? { qty_kg: quantity.toFixed(3) } : { qty_count: quantity }),
    total: { amount: total, currency },
  };
};
async function purchase(companyId, daysBack, lines, notes = null) {
  return post(admin, '/purchases', {
    company_id: companyId,
    purchase_date: daysAgo(daysBack),
    acting_user_id: hemin,
    notes,
    lines,
  });
}
const p1 = await purchase(alNoor, 44, [line('Steel sheet 1.2 mm', 6000, 5_700_000), line('Rebar 12 mm', 8000, 6_080_000)]);
const p2 = await purchase(zagros, 40, [line('Stainless sheet 1 mm', 1200, 3_960_000), line('Welding rod 3.2 mm', 400, 1_400_000)]);
const p3 = await purchase(gulf, 35, [line('Aluminium profile 6 m', 300, 446_000, 'USD')], 'shipped via Umm Qasr');
const p4 = await purchase(erbilMetal, 30, [line('Copper wire 2 mm', 900, 7_740_000)]);
const p5 = await purchase(baghdadPipe, 26, [line('Galvanised pipe 2"', 180, 357_000, 'USD')]);
const p6 = await purchase(alNoor, 18, [line('Steel sheet 1.2 mm', 4000, 3_800_000)]);
await purchase(null, 14, [line('Primer paint 20 L', 60, 2_100_000)], 'bought at the market, cash');
const p8 = await purchase(zagros, 7, [line('Rebar 12 mm', 5000, 3_800_000), line('Welding rod 3.2 mm', 250, 875_000)]);
console.log('✓ eight purchases, one with no company');

// ── six weeks of selling ────────────────────────────────────────────────────────────────

const sold = (name, quantity) => {
  const material = item[name];
  return { item_id: material.id, ...(material.unit === 'per_kg' ? { qty_kg: quantity.toFixed(3) } : { qty_count: quantity }) };
};
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
const o2 = await order(hawler, 38, [sold('Aluminium profile 6 m', 80), sold('Galvanised pipe 2"', 40)]);
await order(slemani, 36, [sold('Rebar 12 mm', 2500)], 'cash', 'IQD', 'paid at the gate');
const o4 = await order(erbilMetal, 33, [sold('Steel sheet 1.2 mm', 2200), sold('Welding rod 3.2 mm', 60)]);
const o5 = await order(duhok, 29, [sold('Stainless sheet 1 mm', 300), sold('Welding rod 3.2 mm', 80)]);
const o6 = await order(baghdadPipe, 24, [sold('Primer paint 20 L', 20), sold('Aluminium profile 6 m', 40)]);
await order(azadi, 21, [sold('Copper wire 2 mm', 120)], 'cash', 'USD');
const o8 = await order(kawa, 17, [sold('Galvanised pipe 2"', 30)]);
const o9 = await order(hawler, 12, [sold('Steel sheet 1.2 mm', 1800), sold('Primer paint 20 L', 10)]);
const o10 = await order(erbilMetal, 9, [sold('Rebar 12 mm', 3000)]);
await order(duhok, 5, [sold('Copper wire 2 mm', 150)], 'cash', 'IQD');
const o12 = await order(slemani, 2, [sold('Stainless sheet 1 mm', 180), sold('Welding rod 3.2 mm', 40)]);
await order(kawa, 0, [sold('Rebar 12 mm', 1200)]);
console.log('✓ thirteen orders, four of them cash');

// ── money both ways ─────────────────────────────────────────────────────────────────────

const received = (orderId, amount, currency, daysBack, note) =>
  post(admin, `/orders/${orderId}/payments`, { amount, currency, entry_date: daysAgo(daysBack), note });
await received(o1.id, 1_500_000, 'IQD', 35, 'first instalment');
await received(o1.id, 1_000_000, 'IQD', 20, 'second instalment');
await received(o2.id, 200_000, 'USD', 30, 'bank transfer');
await received(o4.id, 1_800_000, 'IQD', 25, null);
await received(o5.id, o5.remaining, 'IQD', 22, 'paid in full');
await received(o6.id, 30_000, 'USD', 15, null);
await received(o8.id, 400_000, 'IQD', 10, null);
await received(o9.id, 100_000, 'USD', 6, null);
await received(o10.id, 1_000_000, 'IQD', 3, null);
await received(o12.id, 300_000, 'IQD', 1, 'deposit');

const paid = (companyId, amount, currency, daysBack, purchaseId, note) =>
  post(admin, `/companies/${companyId}/payments`, {
    amount,
    currency,
    entry_date: daysAgo(daysBack),
    purchase_id: purchaseId,
    note,
  });
await paid(alNoor, 6_000_000, 'IQD', 38, p1.id, 'half of the first delivery');
await paid(alNoor, 3_000_000, 'IQD', 12, null, 'on account');
await paid(zagros, 5_360_000, 'IQD', 33, p2.id, 'settled');
await paid(gulf, 200_000, 'USD', 28, p3.id, 'wire transfer');
await paid(erbilMetal, 4_000_000, 'IQD', 20, p4.id, null);
await paid(baghdadPipe, 150_000, 'USD', 18, p5.id, null);
await paid(zagros, 2_000_000, 'IQD', 4, p8.id, null);
await post(admin, `/companies/${alNoor}/credits`, {
  amount: 250_000,
  currency: 'IQD',
  entry_date: daysAgo(15),
  purchase_id: p6.id,
  note: '20 sheets came bent — credited by Al-Noor',
});
console.log('✓ ten payments received, seven made, one credit from a company');

// Balances carried over from paper at go-live, one on each side.
await post(admin, `/customers/${azadi}/opening-balance`, {
  amount: 750_000,
  currency: 'IQD',
  entry_date: daysAgo(45),
  note: 'owed from the old notebook',
});
await post(admin, `/companies/${zagros}/opening-balance`, {
  amount: 1_200_000,
  currency: 'IQD',
  entry_date: daysAgo(45),
  note: 'owed from the old notebook',
});
console.log('✓ opening balances on both sides');

// ── damage ──────────────────────────────────────────────────────────────────────────────

await post(admin, '/damages', {
  item_id: item['Steel sheet 1.2 mm'].id,
  qty_kg: '120.000',
  damage_date: daysAgo(16),
  attribution: 'company',
  company_id: alNoor,
  purchase_id: p6.id,
  is_returnable: true,
  reason: 'bent in transport',
  acting_user_id: hemin,
});
await post(admin, '/damages', {
  item_id: item['Primer paint 20 L'].id,
  qty_count: 2,
  damage_date: daysAgo(8),
  attribution: 'us',
  reason: 'dropped from the rack',
  acting_user_id: hemin,
});
console.log('✓ two damage records');

console.log(`\nDone. Employees sign in as rebaz, hemin and nazdar with "${EMPLOYEE_PASSWORD}".`);

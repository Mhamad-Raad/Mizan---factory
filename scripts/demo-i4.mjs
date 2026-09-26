/**
 * The Iteration 4 demo script of specification 4.6, executable.
 *
 * The four steps of the brief, in order, against a live deployment: History filtered by who did
 * it and by whose customer it is, with an expandable diff and an edit storm as one entry; the
 * whole story of one order on its own History tab; the reports — Sales by month with its dual
 * totals, the margin against the month price with a flagged fallback line and matching signs,
 * Receivables with the sales employee seeing only their own, Payables per company, Damage,
 * Employee activity, the daily cash-up per employee and currency; and the Proposed screens —
 * the dashboard for an owner against a sales employee, and search finding a name typed in the
 * other script.
 *
 * Point it at staging with DEMO_BASE_URL. It leaves everything it creates behind on purpose.
 */
const BASE = process.env.DEMO_BASE_URL ?? 'http://localhost:3000/api/v1';
const ADMIN = process.env.DEMO_ADMIN ?? 'admin';
const ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD ?? 'ChangeMe!2026';

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
  await call(session, '/auth/change-password', {
    method: 'POST',
    body: { current: temporary, new: password },
  });
  return { session, password };
}

const unique = Date.now().toString().slice(-6);
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Baghdad' });
const month = today.slice(0, 7);
const monthStart = `${month}-01`;

const admin = jar();
console.log(`Mizan — Iteration 4 demo script (reports & history) against ${BASE}`);

// ─────────────────────── the day this demo reports on ───────────────────────

const login = await call(admin, '/auth/login', {
  method: 'POST',
  body: { username_or_phone: ADMIN, password: ADMIN_PASSWORD },
});
check(login.status === 200, `signed in as ${ADMIN}`);
await call(admin, '/settings/global-rates', {
  method: 'POST',
  body: { rate_iqd_per_usd: '1300', note: 'demo', confirm: true },
});

const rebazUser = await call(admin, '/users', {
  method: 'POST',
  body: {
    display_name: 'Rebaz Ahmed',
    username: `rebaz.${unique}`,
    role: 'employee',
    preset_key: 'sales',
  },
});
const saraUser = await call(admin, '/users', {
  method: 'POST',
  body: {
    display_name: 'Sara Kareem',
    username: `sara.${unique}`,
    role: 'employee',
    preset_key: 'sales',
  },
});
const nazdarUser = await call(admin, '/users', {
  method: 'POST',
  body: {
    display_name: 'Nazdar Kamal',
    username: `nazdar.${unique}`,
    role: 'employee',
    preset_key: 'accountant',
  },
});
// Sara serves a customer who is assigned to Rebaz, which is the whole point of step 1 — and a
// sales employee only reaches their own customers unless somebody says otherwise (spec 2.6.4).
const saraKeys = await call(admin, `/users/${saraUser.body.user.id}/permissions`);
await call(admin, `/users/${saraUser.body.user.id}/permissions`, {
  method: 'POST',
  body: { keys: [...new Set([...(saraKeys.body?.keys ?? []), 'customers.view_all'])] },
});

const rebaz = await signInFresh(`rebaz.${unique}`, rebazUser.body.temporary_password);
const sara = await signInFresh(`sara.${unique}`, saraUser.body.temporary_password);
const nazdar = await signInFresh(`nazdar.${unique}`, nazdarUser.body.temporary_password);
check(Boolean(rebaz && sara && nazdar), 'two sales employees and an accountant, from the presets');

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

// A material priced only last month, so the margin report has a flagged fallback line.
const brass = await call(admin, '/items', {
  method: 'POST',
  body: { name: `Brass fitting ${unique}`, pricing_unit: 'per_piece' },
});
// The month before this one, counted from the **Baghdad** day, never from the process clock.
const lastMonth = new Date(`${month}-01T00:00:00Z`);
lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
await call(admin, `/items/${brass.body.id}/prices/${lastMonth.toISOString().slice(0, 7)}`, {
  method: 'PUT',
  body: { bought: { amount: 2_500, currency: 'IQD' }, sale: { amount: 3_000, currency: 'IQD' } },
});
await call(admin, `/items/${brass.body.id}/opening-stock`, {
  method: 'POST',
  body: { entry_date: today, qty_count: 100, note: 'counted at go-live' },
});

const kawa = await call(admin, '/customers', {
  method: 'POST',
  body: { name: `Kawa Trading ${unique}`, assigned_user_id: rebazUser.body.user.id },
});
const zagros = await call(admin, '/customers', {
  method: 'POST',
  body: { name: `Zagros Metals ${unique}`, assigned_user_id: saraUser.body.user.id },
});

// Sara serves Rebaz's customer: the case that makes "done by" and "assigned to" differ.
const order = await call(sara.session, '/orders', {
  method: 'POST',
  body: {
    customer_id: kawa.body.id,
    order_date: today,
    payment_type: 'borrowed',
    notes: 'delivered to the yard gate',
    lines: [
      { item_id: copper.body.id, qty_kg: '100.000' },
      { item_id: brass.body.id, qty_count: 4 },
    ],
  },
});
check(order.status === 201, `order #${order.body?.number} recorded by Sara for Rebaz's customer`);

// Two edits in a row, which History shows as one entry — and before any money is recorded
// against the order, because a paid order is frozen (FR-607).
let version = order.body.version;
for (const quantity of ['110.000', '120.000']) {
  const edited = await call(sara.session, `/orders/${order.body.id}`, {
    method: 'PUT',
    body: {
      customer_id: kawa.body.id,
      order_date: today,
      payment_type: 'borrowed',
      version,
      lines: [
        { item_id: copper.body.id, qty_kg: quantity },
        { item_id: brass.body.id, qty_count: 4 },
      ],
    },
  });
  version = edited.body.version;
}

await call(sara.session, `/orders/${order.body.id}/payments`, {
  method: 'POST',
  body: { amount: 30_000, currency: 'IQD', entry_date: today, note: 'part payment at the gate' },
});

const cashOrder = await call(rebaz.session, '/orders', {
  method: 'POST',
  body: {
    customer_id: kawa.body.id,
    order_date: today,
    payment_type: 'cash',
    received_currency: 'IQD',
    lines: [{ item_id: copper.body.id, qty_kg: '20.000' }],
  },
});

const alNoor = await call(nazdar.session, '/customers', {
  method: 'POST',
  body: {
    is_customer: false,
    is_supplier: true, name: `Al-Noor Steel Co. ${unique}`, settlement_currency: 'IQD' },
});
const purchase = await call(admin, '/purchases', {
  method: 'POST',
  body: {
    company_id: alNoor.body.id,
    purchase_date: today,
    lines: [
      { item_id: copper.body.id, qty_kg: '300.000', unit_price: { amount: 690, currency: 'IQD' } },
    ],
  },
});
await call(nazdar.session, `/companies/${alNoor.body.id}/payments`, {
  method: 'POST',
  body: { amount: 100_000, currency: 'IQD', entry_date: today, note: 'on account' },
});
const damage = await call(admin, '/damages', {
  method: 'POST',
  body: {
    item_id: copper.body.id,
    qty_kg: '3.000',
    damage_date: today,
    attribution: 'company',
    company_id: alNoor.body.id,
    purchase_id: purchase.body.id,
    is_returnable: true,
  },
});

// ─────────────────────── 1. History, both filters, the diff and the edit storm ───────────────────────

step(
  1,
  'History: "Done by Sara" and "Assigned to Rebaz" over the same order, and the edits as one entry',
);
const byDoer = await call(admin, `/history?done_by=${saraUser.body.user.id}&entity_type=order`);
check(
  byDoer.body?.items?.some((row) => row.entity_id === order.body.id),
  'filtering by who did it finds the order Sara recorded',
);

const byAssignee = await call(
  admin,
  `/history?assigned_to=${rebazUser.body.user.id}&entity_type=order`,
);
check(
  byAssignee.body?.items?.some((row) => row.entity_id === order.body.id),
  "filtering by whose customer it is finds the same order under Rebaz's name",
);

const rebazDid = await call(admin, `/history?done_by=${rebazUser.body.user.id}&entity_type=order`);
check(
  !rebazDid.body?.items?.some((row) => row.entity_id === order.body.id),
  'and the two are different questions: Rebaz did not record it',
);

const grouped = await call(admin, `/history?entity_type=order&action=update`);
const storm = grouped.body?.items?.find((entry) => entry.entity_id === order.body.id);
check(
  storm?.group_size === 2,
  `the two edits read as one entry standing for ${storm?.group_size} of them`,
);
check(storm?.rows?.length === 2, 'which expands into each edit, newest first');
check(
  storm?.changes?.lines?.new?.[0]?.qty_kg === '120.000',
  'the entry shows where the order ended up (120.000 kg)',
);
check(storm?.note !== undefined, 'and every entry carries its note and its old → new diff');

// ─────────────────────── 2. one order's whole story ───────────────────────

step(2, "Open the order's History tab: created, paid, edited — in order, ungrouped");
const tab = await call(admin, `/orders/${order.body.id}/history`);
const actions = (tab.body?.items ?? []).map((row) => row.action);
check(actions.includes('create'), 'the creation is there');
check(
  actions.filter((action) => action === 'update').length === 2,
  'both edits are there, separately',
);
check(
  (tab.body?.ledger_entries ?? []).some((entry) => entry.entry_type === 'payment'),
  'and the ledger entries that name the order, including the part payment',
);

// ─────────────────────── 3. the reports ───────────────────────

step(
  3,
  'The reports: Sales, the margin against the month price, Receivables, Payables, Damage, activity, cash-up',
);
const range = `from=${monthStart}&to=${today}`;

const sales = await call(nazdar.session, `/reports/sales?${range}`);
check(sales.status === 200, `Sales: ${sales.body?.totals?.count_orders} orders in ${month}`);
check(
  sales.body?.totals?.total_iqd > 0 && sales.body?.totals?.total_usd_cents > 0,
  `${sales.body?.totals?.total_iqd} د.ع and ${sales.body?.totals?.total_usd_cents}¢ — two sums, never a conversion`,
);
check(
  sales.body?.totals?.cash_iqd + sales.body?.totals?.borrowed_iqd === sales.body?.totals?.total_iqd,
  'cash and borrowed add up to the total',
);
check(
  sales.body?.groups?.[0]?.key === monthStart,
  'grouped by the Baghdad month by default (FR-1011)',
);

const byMaterial = await call(nazdar.session, `/reports/sales?${range}&group_by=item`);
check(
  byMaterial.body?.groups?.some((group) => group.qty_kg && Number(group.qty_kg) > 0),
  'and by material, where the quantities live',
);

const profit = await call(nazdar.session, `/reports/profit?${range}&group_by=item`);
check(profit.body?.basis === 'month_price', 'Margin: the report says what it is measured against');
const copperMargin = profit.body?.groups?.find((group) => group.key === copper.body.id);
// 140 kg of copper altogether — 120 on the edited order, 20 on the cash one — at (850 − 700) a
// kilo is 21,000 د.ع, and the dollar side is that figure converted at each line's own rate, so
// the two can never disagree in sign.
check(
  copperMargin?.cost?.margin_iqd === 21_000,
  `${copperMargin?.cost?.margin_iqd} د.ع of margin on the copper`,
);
check(
  Math.sign(copperMargin?.cost?.margin_iqd) === Math.sign(copperMargin?.cost?.margin_usd_cents),
  `and ${copperMargin?.cost?.margin_usd_cents}¢ — the same sign, because it is one computation`,
);
const brassMargin = profit.body?.groups?.find((group) => group.key === brass.body.id);
check(
  brassMargin?.price_fallback === true,
  'the brass line is flagged: its cost came from an earlier month',
);

const receivables = await call(nazdar.session, `/reports/receivables?${range}`);
check(receivables.status === 200, `Receivables: ${receivables.body?.groups?.length} customers`);
check(
  receivables.body?.groups?.[0]?.balance?.amount >=
    receivables.body?.groups?.[1]?.balance?.amount || receivables.body?.groups?.length < 2,
  'sorted by what they owe, highest first',
);
const ownOnly = await call(rebaz.session, `/reports/receivables?${range}`);
check(
  ownOnly.body?.pinned?.filter === 'assigned_to',
  'and a sales employee sees only their own customers, which the response says out loud',
);
check(
  ownOnly.body?.groups?.every((group) => group.label.startsWith('Kawa')),
  `${ownOnly.body?.groups?.length} of them: ${ownOnly.body?.groups?.map((group) => group.label).join(', ')}`,
);
/**
 * The claim worth making is about **scope**, not about presence.
 *
 * Receivables reports who owes something, so a customer who owes nothing is absent from
 * everybody's copy — including the accountant's — and asserting that Sara's customer *appears*
 * there makes the check depend on whether the demo's own earlier steps happened to leave that
 * account in debt. What must always hold is the other half: whatever Rebaz can see, none of it
 * is Sara's.
 */
const sarasCustomers = (receivables.body?.groups ?? []).filter(
  (group) => group.assigned_user_name === 'Sara Kareem',
);
check(
  !ownOnly.body?.groups?.some((group) => group.key === zagros.body.id),
  "Sara's customer is absent from Rebaz's report — the same query, pinned to him",
);
check(
  sarasCustomers.every((group) => !(ownOnly.body?.groups ?? []).some((own) => own.key === group.key)),
  `and so is every other account of hers (${sarasCustomers.length} in the accountant's copy)`,
);

const payables = await call(nazdar.session, `/reports/payables?${range}`);
const alNoorRow = payables.body?.groups?.find((group) => group.key === alNoor.body.id);
check(
  alNoorRow?.balance?.purchased_iqd === 207_000 && alNoorRow?.balance?.paid_iqd === 100_000,
  `Payables: ${alNoorRow?.balance?.purchased_iqd} purchased, ${alNoorRow?.balance?.paid_iqd} paid, ${alNoorRow?.balance?.amount} owed`,
);

// Narrowed to this run's material, so the figures are this run's however often the script has
// been run against the deployment before.
const damageReport = await call(
  nazdar.session,
  `/reports/damage?${range}&group_by=item&item_id=${copper.body.id}`,
);
check(
  damageReport.body?.totals?.records === 1 && damageReport.body?.totals?.qty_kg === '3.000',
  `Damage: ${damageReport.body?.totals?.records} record, ${damageReport.body?.totals?.qty_kg} kg`,
);
check(
  damageReport.body?.groups?.some((group) => group.key === copper.body.id),
  `grouped by material, where the record we just wrote (${damage.body?.id?.slice(0, 8)}) sits`,
);

const activity = await call(nazdar.session, `/reports/employee-activity?${range}`);
const saraRow = activity.body?.groups?.find((group) => group.key === saraUser.body.user.id);
check(
  saraRow?.orders === 1 && saraRow?.payments_in === 1,
  `Employee activity: Sara ${saraRow?.orders} order, ${saraRow?.payments_in} payment`,
);
check(saraRow?.sign_ins >= 1, `and ${saraRow?.sign_ins} sign-in, from the audit log`);

const cashUp = await call(nazdar.session, `/reports/cash-up?from=${today}&to=${today}`);
const rebazCash = cashUp.body?.groups?.find((group) => group.key === rebazUser.body.user.id);
check(
  rebazCash?.received_iqd === 17_000,
  `Cash-up: Rebaz should hand over ${rebazCash?.received_iqd} د.ع — order #${cashOrder.body?.number}, settled at the till`,
);
const nazdarCash = cashUp.body?.groups?.find((group) => group.key === nazdarUser.body.user.id);
check(
  nazdarCash?.paid_out_iqd === 100_000 && nazdarCash?.net_iqd === -100_000,
  `and Nazdar paid out ${nazdarCash?.paid_out_iqd} د.ع, a net of ${nazdarCash?.net_iqd}`,
);

// ─────────────────────── 4. the dashboard and search ───────────────────────

step(4, 'The dashboard for an owner against a sales employee, and search across the scripts');
const ownerTiles = await call(nazdar.session, '/dashboard');
const ownerKeys = (ownerTiles.body?.tiles ?? []).map((tile) => tile.key);
check(
  ownerKeys.includes('we_owe_companies'),
  `the accountant sees ${ownerKeys.length} tiles, including what we owe`,
);

const salesTiles = await call(rebaz.session, '/dashboard');
const salesKeys = (salesTiles.body?.tiles ?? []).map((tile) => tile.key);
check(
  salesKeys.includes('sales_today') && !salesKeys.includes('we_owe_companies'),
  `the sales employee sees ${salesKeys.length}: today's sales and their own work, not the supplier money`,
);
check(ownerTiles.body?.rate !== null, `and both carry today's rate, with its stale marker`);

const byName = await call(nazdar.session, `/search?q=kawa`);
check(
  byName.body?.hits?.some((hit) => hit.kind === 'customer'),
  'search finds "Kawa" typed in Latin letters',
);
const byNumber = await call(nazdar.session, `/search?q=${order.body.number}`);
check(
  byNumber.body?.hits?.some((hit) => hit.kind === 'order'),
  `and order #${order.body.number} by its number alone`,
);

// ─────────────────────── the invariant ───────────────────────

step(5, 'The invariant: every report agrees with the records it reads');
const receivablesTotal = receivables.body?.totals?.balance?.amount_iqd;
const customerSum = await Promise.all(
  (receivables.body?.groups ?? []).map(async (group) => {
    const ledger = await call(nazdar.session, `/customers/${group.key}/ledger?raw=true&limit=500`);
    return (ledger.body?.items ?? []).reduce((total, row) => total + row.amount_iqd, 0);
  }),
).then((sums) => sums.reduce((total, value) => total + value, 0));
check(
  receivablesTotal === customerSum,
  `Σ receivables (${receivablesTotal} د.ع) = Σ the customer ledgers it reports on`,
);

const salesFromList = await call(
  nazdar.session,
  `/orders?from=${monthStart}&to=${today}&page_size=100`,
);
/**
 * Like for like: a **voided** order stays in the list, marked void, because the paper copy is
 * already in somebody's drawer (FR-610) — and it is not a sale, so the report leaves it out.
 * Summing every row of the list therefore only equals the report on a database where nothing
 * has ever been voided, which is no real database. Reading the screen, a person adds up the
 * rows that are not struck through; so does this check.
 */
const listRows = (salesFromList.body?.items ?? []).filter((row) => row.doc_status !== 'void');
const listTotal = listRows.reduce((total, row) => total + row.total_iqd, 0);
const voided = (salesFromList.body?.items ?? []).length - listRows.length;
check(
  listTotal === sales.body?.totals?.total_iqd,
  `and the Sales report (${sales.body?.totals?.total_iqd} د.ع) equals the ${listRows.length} live rows of the Orders list` +
    (voided > 0 ? `, with ${voided} voided row(s) in neither` : ''),
);

console.log(
  failures === 0
    ? '\nThe Iteration 4 demo script passed end to end.\n'
    : `\n${failures} step(s) failed — the demo is not ready.\n`,
);
process.exit(failures === 0 ? 0 : 1);

/**
 * The Iteration 3 demo script of specification 4.5, executable.
 *
 * The five steps of the brief, in order, against a live deployment: a damage record from the
 * floor with its stock movement, one attributed to a customer order that leaves stock alone,
 * the return that credits the supplier from the purchase line's price, the customer credit and
 * the "return to stock" that puts usable goods back, and the list with its filters and its
 * totals seen with and without the bought-price permission.
 *
 * Point it at staging with DEMO_BASE_URL. It leaves everything it creates behind on purpose:
 * the client walks the same records on a tablet afterwards.
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

/** Signs an employee in and exchanges their one-time password for a usable one (FR-108). */
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

const admin = jar();
console.log(`Mizan — Iteration 3 demo script (damaged items & returns) against ${BASE}`);

// ─────────────────────── the yard this demo happens in ───────────────────────

const login = await call(admin, '/auth/login', {
  method: 'POST',
  body: { username_or_phone: ADMIN, password: ADMIN_PASSWORD },
});
check(login.status === 200, `signed in as ${ADMIN}`);
await call(admin, '/settings/global-rates', {
  method: 'POST',
  body: { rate_iqd_per_usd: '1300', note: 'demo', confirm: true },
});

const warehouseUser = await call(admin, '/users', {
  method: 'POST',
  body: { display_name: 'Hemin Salih', username: `hemin.${unique}`, role: 'employee', preset_key: 'warehouse' },
});
const accountantUser = await call(admin, '/users', {
  method: 'POST',
  body: { display_name: 'Nazdar Kamal', username: `nazdar.${unique}`, role: 'employee', preset_key: 'accountant' },
});
const salesUser = await call(admin, '/users', {
  method: 'POST',
  body: { display_name: 'Rebaz Ahmed', username: `rebaz.${unique}`, role: 'employee', preset_key: 'sales' },
});
const hemin = await signInFresh(`hemin.${unique}`, warehouseUser.body.temporary_password);
const nazdar = await signInFresh(`nazdar.${unique}`, accountantUser.body.temporary_password);
const rebaz = await signInFresh(`rebaz.${unique}`, salesUser.body.temporary_password);
check(Boolean(hemin && nazdar && rebaz), 'a warehouse employee, an accountant and a sales employee, from the presets');

const copper = await call(admin, '/items', {
  method: 'POST',
  body: { name: `Copper wire 2 mm ${unique}`, pricing_unit: 'per_kg' },
});
await call(admin, `/items/${copper.body.id}/prices/${month}`, {
  method: 'PUT',
  body: { bought: { amount: 700, currency: 'IQD' }, sale: { amount: 850, currency: 'IQD' } },
});

const alNoor = await call(nazdar.session, '/customers', {
  method: 'POST',
  body: {
    is_customer: false,
    is_supplier: true, name: `Al-Noor Steel Co. ${unique}`, settlement_currency: 'IQD' },
});
await call(nazdar.session, `/customers/${alNoor.body.id}/rates`, {
  method: 'POST',
  body: { rate_iqd_per_usd: '1310', note: 'agreed for September' },
});

// The delivery the damaged copper arrived in, priced for this deal at 5,900 د.ع/kg.
const purchase = await call(hemin.session, '/purchases', {
  method: 'POST',
  body: {
    company_id: alNoor.body.id,
    purchase_date: today,
    lines: [{ item_id: copper.body.id, qty_kg: '1000.000', unit_price: { amount: 5_900, currency: 'IQD' } }],
  },
});
check(purchase.status === 201, `purchase #${purchase.body?.number} brought 1,000 kg in at 5,900 د.ع/kg`);

const kawa = await call(admin, '/customers', {
  method: 'POST',
  body: { name: `Kawa Trading ${unique}`, assigned_user_id: salesUser.body.user.id },
});
const order = await call(rebaz.session, '/orders', {
  method: 'POST',
  body: {
    customer_id: kawa.body.id,
    order_date: today,
    payment_type: 'borrowed',
    lines: [{ item_id: copper.body.id, qty_kg: '100.000' }],
  },
});
check(order.status === 201, `order #${order.body?.number} sold 100 kg of it to Kawa Trading`);

// ─────────────────────── 1. damage from the floor ───────────────────────

step(1, 'As Hemin on a phone: 4 kg of copper damaged, from Al-Noor and that purchase, returnable');
const stockBefore = await call(admin, `/items/${copper.body.id}`);

const fromSupplier = await call(hemin.session, '/damages', {
  method: 'POST',
  body: {
    item_id: copper.body.id,
    qty_kg: '4.000',
    damage_date: today,
    reason: 'arrived with cracked insulation',
    attribution: 'company',
    company_id: alNoor.body.id,
    purchase_id: purchase.body.id,
    is_returnable: true,
  },
});
check(fromSupplier.status === 201, `damage #${fromSupplier.body?.number} recorded`);
check(fromSupplier.body?.stock_effect === 'reduced', 'the record says it reduced stock');
check(fromSupplier.body?.return_status === 'pending', 'and that the goods are expected back');
// 4 kg × 700 د.ع, the month's bought price — the value of what the yard lost (FR-807).
check(
  fromSupplier.body?.cost?.est_value_iqd === 2_800 && fromSupplier.body?.cost?.est_value_source === 'month',
  `valued at ${fromSupplier.body?.cost?.est_value_iqd} د.ع from this month's bought price`,
);

const stockAfter = await call(admin, `/items/${copper.body.id}`);
check(
  Number(stockAfter.body?.stock?.stock_kg) === Number(stockBefore.body?.stock?.stock_kg) - 4,
  `stock fell from ${stockBefore.body?.stock?.stock_kg} to ${stockAfter.body?.stock?.stock_kg} kg`,
);
const movements = await call(admin, `/items/${copper.body.id}/movements`);
const damageOut = (movements.body?.items ?? []).find((row) => row.movement_type === 'damage_out');
check(damageOut?.ref_type === 'damage', 'and the movement names the damage record it came from');

// ─────────────────────── 2. damage that came back from a customer ───────────────────────

step(2, 'Record 2.5 kg that came back damaged on the order → no stock change (A-30)');
const beforeCustomerDamage = await call(admin, `/items/${copper.body.id}`);
const fromCustomer = await call(hemin.session, '/damages', {
  method: 'POST',
  body: {
    item_id: copper.body.id,
    qty_kg: '2.500',
    damage_date: today,
    reason: 'came back bent',
    attribution: 'customer_order',
    order_id: order.body.id,
  },
});
check(fromCustomer.status === 201, `damage #${fromCustomer.body?.number} recorded`);
check(fromCustomer.body?.stock_effect === 'none', 'the goods had already been sold, so stock is untouched');
const afterCustomerDamage = await call(admin, `/items/${copper.body.id}`);
check(
  afterCustomerDamage.body?.stock?.stock_kg === beforeCustomerDamage.body?.stock?.stock_kg,
  `stock is still ${afterCustomerDamage.body?.stock?.stock_kg} kg`,
);
check(fromCustomer.body?.return_status === 'not_returnable', 'and it is not marked as expected back');

// ─────────────────────── 3. the return that credits the supplier ───────────────────────

step(3, 'As Nazdar: mark the first record returned and credit Al-Noor from the purchase line price');
const detail = await call(nazdar.session, `/damages/${fromSupplier.body.id}`);
check(
  detail.body?.credit_prefill?.amount_iqd === 23_600 && detail.body?.credit_prefill?.source === 'purchase_line',
  `the credit is pre-filled at ${detail.body?.credit_prefill?.amount_iqd} د.ع — 4 kg × 5,900 from the purchase line (A-39)`,
);
check(
  detail.body?.credit_prefill?.amount_usd_cents === Math.round((23_600 / 1310) * 100),
  `and ${detail.body?.credit_prefill?.amount_usd_cents}¢ at the company's own 1,310, not the global 1,300`,
);

const owedBefore = (await call(nazdar.session, `/companies/${alNoor.body.id}`)).body?.balance?.amount_iqd;
const returned = await call(nazdar.session, `/damages/${fromSupplier.body.id}/return`, {
  method: 'POST',
  body: {
    status: 'returned',
    note: 'the driver took them back',
    credit: { amount: 23_600, currency: 'IQD', note: 'returned 4 kg of cracked wire' },
  },
});
check(returned.status === 200, 'the return is recorded');
check(returned.body?.return_status === 'returned_credited', 'the chip reads "Returned & credited"');

const owedAfter = (await call(nazdar.session, `/companies/${alNoor.body.id}`)).body?.balance?.amount_iqd;
check(owedAfter === owedBefore - 23_600, `what we owe fell from ${owedBefore} to ${owedAfter} د.ع`);
check(
  returned.body?.credits?.[0]?.cost?.amount_iqd === -23_600,
  'and the record shows the credit that came from it, linked both ways',
);

const stockAfterReturn = await call(admin, `/items/${copper.body.id}`);
check(
  stockAfterReturn.body?.stock?.stock_kg === stockAfter.body?.stock?.stock_kg,
  'the return changed no stock: the damage record had already taken the goods out (A-31)',
);

// ─────────────────────── 4. the customer credit, and goods put back ───────────────────────

step(4, "As Nazdar: credit the customer for what came back, then put a usable lot into stock");
const customerOwedBefore = (await call(nazdar.session, `/customers/${kawa.body.id}`)).body?.balance?.amount_iqd;
const customerCredit = await call(nazdar.session, `/customers/${kawa.body.id}/credits`, {
  method: 'POST',
  body: {
    amount: 2_125,
    currency: 'IQD',
    entry_date: today,
    note: 'goods came back damaged',
    order_id: order.body.id,
    damage_id: fromCustomer.body.id,
  },
});
check(customerCredit.status === 201, 'the customer credit is recorded');
const customerOwedAfter = (await call(nazdar.session, `/customers/${kawa.body.id}`)).body?.balance?.amount_iqd;
check(
  customerOwedAfter === customerOwedBefore - 2_125,
  `Kawa's balance fell from ${customerOwedBefore} to ${customerOwedAfter} د.ع — and only because someone recorded it (FR-806)`,
);
const creditedRecord = await call(nazdar.session, `/damages/${fromCustomer.body.id}`);
check(creditedRecord.body?.credited === true, 'the damage record shows that a credit names it');
check(
  creditedRecord.body?.credits?.[0]?.side === 'customer',
  `and says whose: ${creditedRecord.body?.credits?.[0]?.owner_name}`,
);

const thirdRecord = await call(hemin.session, '/damages', {
  method: 'POST',
  body: {
    item_id: copper.body.id,
    qty_kg: '1.500',
    damage_date: today,
    reason: 'dented reel, looks usable',
    attribution: 'customer_order',
    order_id: order.body.id,
  },
});
const beforeReturnToStock = await call(admin, `/items/${copper.body.id}`);
const backInStock = await call(hemin.session, `/damages/${thirdRecord.body.id}/return-to-stock`, {
  method: 'POST',
  body: { note: 'cleaned up, back on the rack' },
});
check(backInStock.status === 200 && backInStock.body?.stock_effect === 'returned_in', 'the goods go back into stock');
const afterReturnToStock = await call(admin, `/items/${copper.body.id}`);
check(
  Number(afterReturnToStock.body?.stock?.stock_kg) === Number(beforeReturnToStock.body?.stock?.stock_kg) + 1.5,
  `stock rose from ${beforeReturnToStock.body?.stock?.stock_kg} to ${afterReturnToStock.body?.stock?.stock_kg} kg`,
);
const returnMovement = (await call(admin, `/items/${copper.body.id}/movements`)).body?.items?.[0];
check(returnMovement?.movement_type === 'return_in', 'through a `return_in` movement, which History carries');

const history = await call(nazdar.session, `/damages/${fromSupplier.body.id}/history`);
check(
  (history.body?.items ?? []).some((row) => row.action === 'status_change'),
  'and every status change is in the record\'s History',
);

// ─────────────────────── 5. the list, its filters and its totals ───────────────────────

step(5, 'The list: filter by what is still expected back and by employee; totals with and without prices');
const pending = await call(nazdar.session, '/damages?return_status=pending');
check(pending.body?.total === 0, 'nothing is pending any more — the one returnable record came back and was credited');

const byEmployee = await call(nazdar.session, `/damages?done_by=${warehouseUser.body.user.id}`);
check(byEmployee.body?.total === 3, `Hemin recorded ${byEmployee.body?.total} of them`);

const all = await call(nazdar.session, `/damages?from=${today}&to=${today}`);
check(all.body?.totals?.records === 3, `the period totals count ${all.body?.totals?.records} records`);
check(all.body?.totals?.qty_kg === '8.000', `${all.body?.totals?.qty_kg} kg of copper in all`);
check(
  all.body?.totals?.cost?.est_value_iqd === 5_600,
  `worth ${all.body?.totals?.cost?.est_value_iqd} د.ع at this month's bought price`,
);

// The same list through the eyes of somebody who may not see bought prices (FR-807).
const plainUser = await call(admin, '/users', {
  method: 'POST',
  body: { display_name: 'Shilan Omar', username: `shilan.${unique}`, role: 'employee', preset_key: 'sales' },
});
const shilan = await signInFresh(`shilan.${unique}`, plainUser.body.temporary_password);
await call(admin, `/users/${plainUser.body.user.id}/permissions`, {
  method: 'POST',
  body: { keys: ['damages.view', 'materials.view'] },
});
const withoutPrices = await call(shilan.session, `/damages?from=${today}&to=${today}`);
check(withoutPrices.status === 200, 'a user without the bought-price flag still sees the list');
check(withoutPrices.body?.totals?.qty_kg === '8.000', `with its quantities (${withoutPrices.body?.totals?.qty_kg} kg)`);
check(withoutPrices.body?.totals?.cost === undefined, 'and no value at all, rather than a zero');
check(
  withoutPrices.body?.items?.every((row) => row.cost === undefined),
  'the same on every row',
);

console.log(
  failures === 0
    ? '\nThe Iteration 3 demo script passed end to end.\n'
    : `\n${failures} step(s) failed — the demo is not ready.\n`,
);
process.exit(failures === 0 ? 0 : 1);

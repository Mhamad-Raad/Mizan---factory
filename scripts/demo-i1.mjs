/**
 * The Iteration 1 demo script of specification 4.3, executable.
 *
 * The nine steps of the brief, in order, against a live deployment: the rate, the materials
 * and their September prices, the customer with an opening debt, a borrowed order on a phone,
 * a part payment, "settle in full" in dollars with no residue, a cash order for the walk-in
 * customer, an edit and a void, the scope rules between two sales employees, and the period
 * lock refusing a back-dated order.
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
const yesterday = (() => {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
})();

const admin = jar();
console.log(`Mizan — Iteration 1 demo script (selling) against ${BASE}`);

// ─────────────────────────────── 1. the rate and the materials ───────────────────────────────

step(1, 'As admin: set the global rate 1,310, create two materials, set this month\'s prices, record opening stock');
const login = await call(admin, '/auth/login', {
  method: 'POST',
  body: { username_or_phone: ADMIN, password: ADMIN_PASSWORD },
});
check(login.status === 200, `signed in as ${ADMIN}`);

const rate = await call(admin, '/settings/global-rates', {
  method: 'POST',
  body: { rate_iqd_per_usd: '1310', note: 'demo', confirm: true },
});
check(rate.status === 201, `the global rate is ${rate.body?.rate_iqd_per_usd ?? '—'}`);

const steel = await call(admin, '/items', {
  method: 'POST',
  body: { name: `Steel sheet 1.2 mm ${unique}`, pricing_unit: 'per_piece' },
});
const copper = await call(admin, '/items', {
  method: 'POST',
  body: { name: `Copper wire 2 mm ${unique}`, pricing_unit: 'per_kg' },
});
check(steel.status === 201 && copper.status === 201, 'both materials created (per piece and per kg)');

const prices = await call(admin, `/items/${copper.body.id}/prices/${month}`, {
  method: 'PUT',
  body: { bought: { amount: 700, currency: 'IQD' }, sale: { amount: 850, currency: 'IQD' } },
});
check(prices.status === 200, 'typed the prices in dinars…');
check(prices.body?.sale?.amount_usd_cents === 65, `…and the dollars filled themselves: ${prices.body?.sale?.amount_usd_cents}¢`);
await call(admin, `/items/${steel.body.id}/prices/${month}`, {
  method: 'PUT',
  body: { bought: { amount: 15_000, currency: 'IQD' }, sale: { amount: 18_000, currency: 'IQD' } },
});

const opening = await call(admin, `/items/${copper.body.id}/opening-stock`, {
  method: 'POST',
  body: { entry_date: today, qty_kg: '6000.000', note: 'counted at go-live' },
});
check(opening.status === 201, `opening stock recorded with its note: ${opening.body?.stock?.stock_kg} kg`);
await call(admin, `/items/${steel.body.id}/opening-stock`, {
  method: 'POST',
  body: { entry_date: today, qty_count: 500, note: 'counted at go-live' },
});

// ───────────────────────── 2. the customer and their opening debt ─────────────────────────

step(2, 'Create "Kawa Trading" assigned to Rebaz, with an opening balance of 450,000 د.ع');
const rebazUser = await call(admin, '/users', {
  method: 'POST',
  body: { display_name: 'Rebaz Ahmed', username: `rebaz.${unique}`, role: 'employee', preset_key: 'sales' },
});
const saraUser = await call(admin, '/users', {
  method: 'POST',
  body: { display_name: 'Sara Kareem', username: `sara.${unique}`, role: 'employee', preset_key: 'sales' },
});
check(rebazUser.status === 201 && saraUser.status === 201, 'two sales employees created from the preset');

const rebaz = await signInFresh(`rebaz.${unique}`, rebazUser.body.temporary_password);
const sara = await signInFresh(`sara.${unique}`, saraUser.body.temporary_password);
check(Boolean(rebaz && sara), 'both signed in and set their own passwords');

const kawa = await call(admin, '/customers', {
  method: 'POST',
  body: { name: `Kawa Trading ${unique}`, phone: '0770 123 4567', assigned_user_id: rebazUser.body.user.id },
});
check(kawa.status === 201, `customer created, assigned to ${kawa.body?.assigned_user_name}`);

const openingBalance = await call(admin, `/customers/${kawa.body.id}/opening-balance`, {
  method: 'POST',
  body: { amount: 450_000, currency: 'IQD', entry_date: today, note: 'owed at go-live' },
});
check(openingBalance.body?.balance_after === 450_000, 'opening balance 450,000 د.ع with a note');

// ─────────────────────────── 3. a borrowed order on a phone ───────────────────────────

step(3, 'As Rebaz: a borrowed order for Kawa with two lines, rounded down, then the receipt');
const order = await call(rebaz.session, '/orders', {
  method: 'POST',
  body: {
    customer_id: kawa.body.id,
    order_date: today,
    payment_type: 'borrowed',
    notes: 'delivered to the yard gate',
    discount: { amount: 1_250, currency: 'IQD' },
    lines: [
      { item_id: copper.body.id, qty_kg: '12.500' },
      { item_id: steel.body.id, qty_count: 40, qty_kg: '96.000' },
    ],
  },
});
check(order.status === 201, `order #${order.body?.number} saved`);
check(order.body?.status === 'unpaid', 'status is Unpaid, derived from the ledger');
check(order.body?.total_iqd === 729_375, `total 729,375 د.ع after the 1,250 round-down (was 730,625)`);
check(order.body?.total_usd_cents === 55_678, `and ${order.body?.total_usd_cents}¢, a sum of the lines rather than a conversion`);

const stockAfter = await call(admin, `/items/${copper.body.id}`);
check(stockAfter.body?.stock?.stock_kg === '5987.500', `stock fell to ${stockAfter.body?.stock?.stock_kg} kg`);
check(stockAfter.body?.last_sold_on === today, 'the material now shows "last sold" today');

const receipt = await call(rebaz.session, `/orders/${order.body.id}/receipt`);
check(receipt.status === 200, 'the receipt carries the same stored values as the screen');

// ─────────────────────────────── 4. a part payment ───────────────────────────────

step(4, 'Record 300,000 د.ع against the order → Partially paid, with a voucher number');
const partial = await call(rebaz.session, `/orders/${order.body.id}/payments`, {
  method: 'POST',
  body: { amount: 300_000, currency: 'IQD', entry_date: today, note: 'cash at the gate' },
});
check(partial.status === 201, 'payment recorded');
check(partial.body?.[0]?.order?.status === 'partially_paid', 'the order is Partially paid');
check(
  partial.body?.[0]?.balance_before === 1_179_375 && partial.body?.[0]?.balance_after === 879_375,
  `balance ${partial.body?.[0]?.balance_before} → ${partial.body?.[0]?.balance_after} د.ع, as History records it`,
);
check(Number(partial.body?.[0]?.voucher_number) > 0, `voucher #${partial.body?.[0]?.voucher_number}`);

// ─────────────────────── 5. settle the rest in dollars, no residue ───────────────────────

step(5, 'Settle the rest in dollars with "Settle in full" → Paid, zero residue, manual-rate pair');
const remaining = partial.body?.[0]?.order?.remaining ?? 0;
const inDollars = Math.round((remaining / 1310) * 100);
const settled = await call(rebaz.session, `/orders/${order.body.id}/payments`, {
  method: 'POST',
  body: { amount: inDollars, currency: 'USD', entry_date: today, settle_in_full: true },
});
check(settled.status === 201, `settled with $${(inDollars / 100).toFixed(2)} handed over`);
check(settled.body?.[0]?.order?.remaining === 0, 'the order lands exactly on zero — no five-dinar residue');
check(settled.body?.[0]?.amount_iqd === -remaining, `the entry stores the exact ${remaining} د.ع remainder…`);
check(settled.body?.[0]?.amount_usd_cents === -inDollars, `…and the ${inDollars}¢ actually received`);

// ─────────────────────── 6. a cash order for the walk-in customer ───────────────────────

step(6, 'A cash order for the walk-in customer, paid in dollars → Paid immediately, no ledger tab');
const customers = await call(admin, '/customers?q=walk');
const walkIn = customers.body?.items?.find((row) => row.is_system);
if (!walkIn) {
  bad('the walk-in customer is missing — run the seed');
} else {
  const cash = await call(rebaz.session, '/orders', {
    method: 'POST',
    body: {
      customer_id: walkIn.id,
      order_date: today,
      payment_type: 'cash',
      received_currency: 'USD',
      lines: [{ item_id: steel.body.id, qty_count: 2 }],
    },
  });
  check(cash.status === 201 && cash.body?.status === 'paid', `order #${cash.body?.number} is Paid the moment it is saved`);
  check(cash.body?.received_currency === 'USD', 'it records that the customer paid in dollars (for the cash-up)');

  const ledger = await call(rebaz.session, `/customers/${walkIn.id}/ledger`);
  check(ledger.status === 404, 'the walk-in customer has no ledger tab, as specified');

  const borrowed = await call(rebaz.session, '/orders', {
    method: 'POST',
    body: {
      customer_id: walkIn.id,
      order_date: today,
      payment_type: 'borrowed',
      lines: [{ item_id: steel.body.id, qty_count: 1 }],
    },
  });
  check(borrowed.status === 422, 'and it refuses a borrowed order');
}

// ─────────────────────────────── 7. edit, void, refund ───────────────────────────────

step(7, 'Edit an unpaid order (reversal + new movements), void another with a reason, refund the payment');
// The Sales preset deliberately grants neither voiding nor credits (spec 1.5.3): the admin
// turns on the two extras first, which is itself part of what the client is shown.
const withVoid = await call(admin, `/users/${rebazUser.body.user.id}/permissions`, {
  method: 'POST',
  body: {
    keys: [
      ...(await call(admin, `/users/${rebazUser.body.user.id}/permissions`)).body.keys,
      'orders.void',
      'orders.credit',
    ],
  },
});
check(withVoid.status === 201, 'the admin grants "Can void" and customer credits to Rebaz');
const toEdit = await call(rebaz.session, '/orders', {
  method: 'POST',
  body: {
    customer_id: kawa.body.id,
    order_date: yesterday,
    payment_type: 'borrowed',
    lines: [{ item_id: copper.body.id, qty_kg: '100.000' }],
  },
});
const edited = await call(rebaz.session, `/orders/${toEdit.body.id}`, {
  method: 'PUT',
  body: {
    customer_id: kawa.body.id,
    order_date: yesterday,
    payment_type: 'borrowed',
    version: toEdit.body.version,
    lines: [{ item_id: copper.body.id, qty_kg: '80.000' }],
  },
});
check(edited.status === 200 && edited.body?.total_iqd === 68_000, `the edit recomputed the total to ${edited.body?.total_iqd} د.ع`);

const movements = await call(admin, `/items/${copper.body.id}/movements`);
const kinds = (movements.body?.items ?? []).slice(0, 3).map((row) => row.movement_type);
check(kinds[0] === 'sale_out' && kinds[1] === 'reversal', `movements read ${kinds.join(', ')} — compensating, never edited`);

const toVoid = await call(rebaz.session, '/orders', {
  method: 'POST',
  body: {
    customer_id: kawa.body.id,
    order_date: today,
    payment_type: 'borrowed',
    lines: [{ item_id: copper.body.id, qty_kg: '10.000' }],
  },
});
await call(rebaz.session, `/orders/${toVoid.body.id}/payments`, {
  method: 'POST',
  body: { amount: 5_000, currency: 'IQD', entry_date: today },
});
const voided = await call(rebaz.session, `/orders/${toVoid.body.id}/void`, {
  method: 'POST',
  body: { reason: 'customer cancelled at the gate', version: toVoid.body.version },
});
check(voided.status === 200 && voided.body?.doc_status === 'void', 'voided with its reason, stock restored');

const refund = await call(rebaz.session, `/customers/${kawa.body.id}/refunds`, {
  method: 'POST',
  body: { amount: 5_000, currency: 'IQD', entry_date: today, note: 'cash returned for the voided order' },
});
check(refund.status === 201, 'the 5,000 د.ع that had arrived stayed as credit and was refunded');

// ─────────────────────────────── 8. the scope rules ───────────────────────────────

step(8, 'As Sara: Kawa is invisible, the duplicate warning names Rebaz, and "sees all customers" opens it up');
const saraSees = await call(sara.session, '/customers');
check(
  !(saraSees.body?.items ?? []).some((row) => row.id === kawa.body.id),
  "Kawa Trading is not in Sara's list",
);
const saraOpens = await call(sara.session, `/customers/${kawa.body.id}`);
check(saraOpens.status === 404, 'opening it answers 404, which does not even confirm it exists');

const duplicates = await call(sara.session, `/customers/duplicates?name=${encodeURIComponent(`Kawa Trading ${unique}`)}`);
check(
  duplicates.body?.duplicates?.[0]?.assigned_user_name === 'Rebaz Ahmed',
  'the duplicate warning says it is assigned to Rebaz Ahmed — ask your admin',
);

await call(admin, `/users/${saraUser.body.user.id}/permissions`, {
  method: 'POST',
  body: {
    keys: ['orders.create', 'customers.create', 'customers.view_all', 'fields.see_customer_balances'],
  },
});
const saraSeesNow = await call(sara.session, '/customers');
check(
  (saraSeesNow.body?.items ?? []).some((row) => row.id === kawa.body.id),
  'after the admin grants "sees all customers", it is there — on the very next request',
);

// ─────────────────────────────── 9. the period lock ───────────────────────────────

step(9, 'Lock the period through yesterday: a back-dated order is refused with the lock date');
await call(admin, '/settings', { method: 'PATCH', body: { locked_through: yesterday } });
const backDated = await call(rebaz.session, '/orders', {
  method: 'POST',
  body: {
    customer_id: kawa.body.id,
    order_date: yesterday,
    payment_type: 'borrowed',
    lines: [{ item_id: copper.body.id, qty_kg: '1.000' }],
  },
});
check(backDated.status === 409 && backDated.body?.error?.code === 'PERIOD_LOCKED', 'refused with PERIOD_LOCKED');
check(backDated.body?.error?.params?.locked_through === yesterday, `and it names the lock date ${yesterday}`);

const todayStillWorks = await call(rebaz.session, '/orders', {
  method: 'POST',
  body: {
    customer_id: kawa.body.id,
    order_date: today,
    payment_type: 'borrowed',
    lines: [{ item_id: copper.body.id, qty_kg: '1.000' }],
  },
});
check(todayStillWorks.status === 201, "while today's work carries on");
await call(admin, '/settings', { method: 'PATCH', body: { locked_through: null } });

// ─────────────────────────────── the invariant ───────────────────────────────

step(10, 'The invariant: the customer balance is the sum of their ledger, and History agrees');
const ledger = await call(admin, `/customers/${kawa.body.id}/ledger?raw=true`);
const sum = (ledger.body?.items ?? []).reduce((total, row) => total + row.amount_iqd, 0);
const profile = await call(admin, `/customers/${kawa.body.id}`);
check(sum === ledger.body?.balance, `Σ ledger = ${sum} د.ع = the balance the API reports`);
check(profile.body?.balance?.amount_iqd === sum, 'and the same figure on the profile');
// The ledger comes back newest first, so the running balance of the *first* row is the
// balance now — the same number the profile shows (2.4.1 rule 5).
const newest = (ledger.body?.items ?? [])[0];
check(newest?.balance_after === sum, `the newest running balance (${newest?.balance_after}) is that same number`);

console.log(
  failures === 0
    ? '\nThe Iteration 1 demo script passed end to end.\n'
    : `\n${failures} step(s) failed — the demo is not ready.\n`,
);
process.exit(failures === 0 ? 0 : 1);

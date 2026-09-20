/**
 * The Iteration 2 demo script of specification 4.4, executable.
 *
 * The seven steps of the brief, in order, against a live deployment: the company and its own
 * rate, a purchase from a phone with its stock and "first bought", payments in either currency
 * with the automatic conversion and an override, an adjustment with its note and old → new, a
 * rate change that leaves stored entries alone, a settlement-currency change through one
 * re-basing entry, an edit and a void with compensating movements, an opening debt with a
 * statement, and the companies list by highest balance.
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
console.log(`Mizan — Iteration 2 demo script (buying) against ${BASE}`);

// ─────────────────────── 1. the company and its own rate ───────────────────────

step(1, 'As accountant: create "Al-Noor Steel Co." (settlement IQD) and set its rate to 1,310');
const login = await call(admin, '/auth/login', {
  method: 'POST',
  body: { username_or_phone: ADMIN, password: ADMIN_PASSWORD },
});
check(login.status === 200, `signed in as ${ADMIN}`);

// The global rate is 1,300 for this demo, so the company's 1,310 is visibly its own.
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
check(warehouseUser.status === 201 && accountantUser.status === 201, 'a warehouse employee and an accountant, from the presets');

const hemin = await signInFresh(`hemin.${unique}`, warehouseUser.body.temporary_password);
const nazdar = await signInFresh(`nazdar.${unique}`, accountantUser.body.temporary_password);
check(Boolean(hemin && nazdar), 'both signed in and set their own passwords');

const alNoor = await call(nazdar.session, '/companies', {
  method: 'POST',
  body: {
    name: `Al-Noor Steel Co. ${unique}`,
    contact_name: 'Abu Ahmad',
    phone: '0751 222 3344',
    settlement_currency: 'IQD',
  },
});
check(alNoor.status === 201, `company created, settled in ${alNoor.body?.settlement_currency}`);
check(alNoor.body?.rate?.is_company_rate === false, 'with no rate of its own yet, so the global 1,300 applies');

const companyRate = await call(nazdar.session, `/companies/${alNoor.body.id}/rates`, {
  method: 'POST',
  body: { rate_iqd_per_usd: '1310', note: 'agreed for September' },
});
check(companyRate.status === 201, `the company's own rate is ${companyRate.body?.rate_iqd_per_usd}`);

// ─────────────────────── 2. the purchase, from a phone ───────────────────────

step(2, 'As Hemin on a phone: add material from Al-Noor with two lines → stock, first bought, and what we owe');
const steel = await call(admin, '/items', {
  method: 'POST',
  body: { name: `Steel sheet 1.2 mm ${unique}`, pricing_unit: 'per_piece' },
});
const copper = await call(admin, '/items', {
  method: 'POST',
  body: { name: `Copper wire 2 mm ${unique}`, pricing_unit: 'per_kg' },
});
await call(admin, `/items/${copper.body.id}/prices/${month}`, {
  method: 'PUT',
  body: { bought: { amount: 700, currency: 'IQD' }, sale: { amount: 850, currency: 'IQD' } },
});
await call(admin, `/items/${steel.body.id}/prices/${month}`, {
  method: 'PUT',
  body: { bought: { amount: 15_000, currency: 'IQD' }, sale: { amount: 18_000, currency: 'IQD' } },
});
check(steel.status === 201 && copper.status === 201, 'two materials with this month\'s bought prices typed in dinars');

const purchase = await call(hemin.session, '/purchases', {
  method: 'POST',
  body: {
    company_id: alNoor.body.id,
    purchase_date: today,
    notes: 'delivered by lorry',
    lines: [
      { item_id: copper.body.id, qty_kg: '5000.000' },
      { item_id: steel.body.id, qty_count: 20, qty_kg: '48.000' },
    ],
  },
});
check(purchase.status === 201, `purchase #${purchase.body?.number} saved`);
check(purchase.body?.rate_source === 'company', `valued at the company's rate (${purchase.body?.rate_iqd_per_usd})`);
// 700 × 5,000 = 3,500,000 and 15,000 × 20 = 300,000; each currency summed on its own.
check(purchase.body?.cost?.total_iqd === 3_800_000, `total ${purchase.body?.cost?.total_iqd} د.ع`);
check(
  purchase.body?.cost?.total_usd_cents === Math.round((3_500_000 / 1310) * 100) + Math.round((300_000 / 1310) * 100),
  `and ${purchase.body?.cost?.total_usd_cents}¢ at 1,310 — a sum of the lines, not a conversion of the total`,
);

const copperAfter = await call(admin, `/items/${copper.body.id}`);
check(copperAfter.body?.stock?.stock_kg === '5000.000', `stock rose to ${copperAfter.body?.stock?.stock_kg} kg`);
check(copperAfter.body?.first_bought_on === today, 'and the material now shows "first bought" today');

const owed = await call(nazdar.session, `/companies/${alNoor.body.id}`);
check(owed.body?.balance?.amount_iqd === 3_800_000, `we owe Al-Noor ${owed.body?.balance?.amount_iqd} د.ع`);

const perPurchase = await call(nazdar.session, `/purchases/${purchase.body.id}/balance`);
check(perPurchase.body?.cost?.remaining === 3_800_000, 'and remaining on the purchase equals its total');

// ─────────────────────── 3. payments in either currency ───────────────────────

step(3, 'As Nazdar: pay 1,000,000 د.ع → the dollars fill at 1,310; then 500 $ with the dinars overridden');
const firstPayment = await call(nazdar.session, `/companies/${alNoor.body.id}/payments`, {
  method: 'POST',
  body: { amount: 1_000_000, currency: 'IQD', entry_date: today, method: 'cash', note: 'first instalment' },
});
check(firstPayment.status === 201, 'payment recorded');
check(
  firstPayment.body?.[0]?.amount_usd_cents === -Math.round((1_000_000 / 1310) * 100),
  `1,000,000 د.ع is ${firstPayment.body?.[0]?.amount_usd_cents}¢ at the company's rate, not the global one`,
);
check(
  firstPayment.body?.[0]?.balance_before === 3_800_000 && firstPayment.body?.[0]?.balance_after === 2_800_000,
  `balance ${firstPayment.body?.[0]?.balance_before} → ${firstPayment.body?.[0]?.balance_after} د.ع, as History records it`,
);
check(Number(firstPayment.body?.[0]?.voucher_number) > 0, `voucher #${firstPayment.body?.[0]?.voucher_number}`);

const secondPayment = await call(nazdar.session, `/companies/${alNoor.body.id}/payments`, {
  method: 'POST',
  body: {
    amount: 50_000,
    currency: 'USD',
    other_amount: 650_000,
    entry_date: today,
    note: 'second instalment, rate agreed on the day',
  },
});
check(secondPayment.status === 201, '500 $ recorded with the dinar side typed by hand');
check(secondPayment.body?.[0]?.amount_iqd === -650_000, `${secondPayment.body?.[0]?.amount_iqd} د.ع, the figure they agreed`);

const ledger = await call(nazdar.session, `/companies/${alNoor.body.id}/ledger?raw=true`);
const manual = (ledger.body?.items ?? []).find((row) => row.rate_source === 'manual');
check(manual?.rate_iqd_per_usd === '1300.0000', `and it carries the implied manual rate ${manual?.rate_iqd_per_usd}`);

const breakdown = await call(nazdar.session, `/companies/${alNoor.body.id}/purchase-breakdown`);
const mine = (breakdown.body?.allocation?.purchases ?? []).find((row) => row.purchase_id === purchase.body.id);
check(mine?.remaining === 2_150_000, `the purchase shows ${mine?.remaining} د.ع left without anything being linked`);
check(
  (breakdown.body?.allocation?.purchases ?? []).reduce((total, row) => total + row.remaining, 0) +
    breakdown.body?.allocation?.general ===
    breakdown.body?.allocation?.balance,
  'Σ remaining + General = the company balance (the identity FR-712 asks for)',
);

// ─────────────────────── 4. adjust what we owe ───────────────────────

step(4, 'Adjust what we owe by −150,000 with a note → old → new in History; without a note it is refused');
const adjustment = await call(nazdar.session, `/companies/${alNoor.body.id}/adjustments`, {
  method: 'POST',
  body: { delta: -150_000, currency: 'IQD', entry_date: today, note: 'agreed discount on the delivery' },
});
check(adjustment.status === 201, 'adjustment recorded as exactly the delta');
check(
  adjustment.body?.balance_before === 2_150_000 && adjustment.body?.balance_after === 2_000_000,
  `balance ${adjustment.body?.balance_before} → ${adjustment.body?.balance_after} د.ع`,
);

const noNote = await call(nazdar.session, `/companies/${alNoor.body.id}/adjustments`, {
  method: 'POST',
  body: { delta: -1_000, currency: 'IQD', entry_date: today, note: '' },
});
check(noNote.status === 422, 'and the same change without a note is refused');

const history = await call(nazdar.session, `/companies/${alNoor.body.id}/history`);
const logged = (history.body?.items ?? []).find((row) => row.note === 'agreed discount on the delivery');
check(Boolean(logged), 'History carries the note…');
check(
  logged?.changes?.balance?.before?.amount === 2_150_000 && logged?.changes?.balance?.after?.amount === 2_000_000,
  '…with the balance before and after',
);

// ─────────────────────── 5. the rate change and the settlement currency ───────────────────────

step(5, 'Change the company rate → new documents use it, stored entries are untouched; then re-base a USD company');
const storedBefore = (await call(nazdar.session, `/companies/${alNoor.body.id}/ledger?raw=true`)).body?.items ?? [];
const newRate = await call(nazdar.session, `/companies/${alNoor.body.id}/rates`, {
  method: 'POST',
  body: { rate_iqd_per_usd: '1400', note: 'October rate' },
});
check(newRate.status === 201, `the company's rate is now ${newRate.body?.rate_iqd_per_usd}`);

const storedAfter = (await call(nazdar.session, `/companies/${alNoor.body.id}/ledger?raw=true`)).body?.items ?? [];
check(
  JSON.stringify(storedBefore.map((row) => [row.amount_iqd, row.amount_usd_cents, row.rate_iqd_per_usd])) ===
    JSON.stringify(storedAfter.map((row) => [row.amount_iqd, row.amount_usd_cents, row.rate_iqd_per_usd])),
  'every stored entry is byte-for-byte what it was — nothing is recalculated from a later rate',
);

const guard = await call(nazdar.session, `/companies/${alNoor.body.id}/rates`, {
  method: 'POST',
  body: { rate_iqd_per_usd: '14000' },
});
check(guard.status === 422 && guard.body?.error?.code === 'RATE_GUARD', 'a rate ten times too large asks for confirmation');

const gulf = await call(nazdar.session, '/companies', {
  method: 'POST',
  body: { name: `Gulf Steel FZE ${unique}`, settlement_currency: 'USD' },
});
await call(nazdar.session, `/companies/${gulf.body.id}/rates`, {
  method: 'POST',
  body: { rate_iqd_per_usd: '1310' },
});
const gulfPurchase = await call(hemin.session, '/purchases', {
  method: 'POST',
  body: {
    company_id: gulf.body.id,
    purchase_date: today,
    lines: [{ item_id: copper.body.id, qty_kg: '1000.000' }],
  },
});
check(
  gulfPurchase.body?.cost?.total_usd_cents === Math.round((700_000 / 1310) * 100),
  `a USD-settled company's purchase is valued at its own rate: ${gulfPurchase.body?.cost?.total_usd_cents}¢ though the price was typed in dinars`,
);

const refused = await call(admin, `/companies/${gulf.body.id}/settlement-currency`, {
  method: 'PUT',
  body: { currency: 'IQD', note: 'they invoice in dinars now' },
});
check(
  refused.status === 422 && refused.body?.error?.code === 'REBASE_RATE_REQUIRED',
  'changing the settlement currency with money on the account needs a re-basing rate',
);

const rebased = await call(admin, `/companies/${gulf.body.id}/settlement-currency`, {
  method: 'PUT',
  body: { currency: 'IQD', note: 'they invoice in dinars now', rebase_rate: '1310' },
});
check(rebased.status === 200 && rebased.body?.settlement_currency === 'IQD', 'with one it succeeds');
// The balance being carried over is the *dollar* one the account was kept in — $534.35 — and
// at 1,310 that is 699,999 د.ع, not the 700,000 the purchase happens to have been invoiced
// for. The dinar of difference is the rounding of the stored cents, and it is in the marker
// row rather than in any historical amount (2.3.5).
const agreed = Math.round((gulfPurchase.body.cost.total_usd_cents / 100) * 1310);
check(
  rebased.body?.balance?.amount_iqd === agreed,
  `and the balance is exactly the agreed ${rebased.body?.balance?.amount_iqd} د.ع ($${(gulfPurchase.body.cost.total_usd_cents / 100).toFixed(2)} at 1,310)`,
);
const gulfLedger = await call(nazdar.session, `/companies/${gulf.body.id}/ledger?raw=true`);
check(
  (gulfLedger.body?.items ?? []).some((row) => row.entry_type === 'settlement_change'),
  'through one marker entry, with no historical amount touched',
);

// ─────────────────────── 6. edit and void ───────────────────────

step(6, 'Edit the purchase on the same day, then void a second one → the stock ledger tells the whole story');
const reread = await call(hemin.session, `/purchases/${purchase.body.id}`);
const edited = await call(hemin.session, `/purchases/${purchase.body.id}`, {
  method: 'PUT',
  body: {
    company_id: alNoor.body.id,
    purchase_date: today,
    version: reread.body.version,
    notes: 'delivered by lorry (corrected weight)',
    lines: [
      { item_id: copper.body.id, qty_kg: '5200.000' },
      { item_id: steel.body.id, qty_count: 20, qty_kg: '48.000' },
    ],
  },
});
check(edited.status === 200, 'the quantity corrected from 5,000 to 5,200 kg');
check(edited.body?.cost?.total_iqd === 3_940_000, `total ${edited.body?.cost?.total_iqd} د.ع`);

const movements = await call(admin, `/items/${copper.body.id}/movements`);
const kinds = (movements.body?.items ?? []).map((row) => row.movement_type);
check(kinds.filter((kind) => kind === 'reversal').length >= 1, 'the old movement was reversed rather than edited');
const copperNow = await call(admin, `/items/${copper.body.id}`);
check(copperNow.body?.stock?.stock_kg === '6200.000', `and stock now reads ${copperNow.body?.stock?.stock_kg} kg`);

const second = await call(hemin.session, '/purchases', {
  method: 'POST',
  body: {
    company_id: alNoor.body.id,
    purchase_date: today,
    lines: [{ item_id: steel.body.id, qty_count: 5, qty_kg: '12.000' }],
  },
});
// Hemin may record and correct a purchase but not void one: the Warehouse preset holds no
// `purchases.void` key, so the void is the admin's (or an owner's) call (FR-405, 2.7).
const heminTriesToVoid = await call(hemin.session, `/purchases/${second.body.id}/void`, {
  method: 'POST',
  body: { reason: 'the lorry came back half empty' },
});
check(heminTriesToVoid.status === 403, 'the warehouse employee is refused the void, as the preset says');

const voided = await call(admin, `/purchases/${second.body.id}/void`, {
  method: 'POST',
  body: { reason: 'the lorry came back half empty' },
});
check(voided.status === 200 && voided.body?.doc_status === 'void', `purchase #${second.body?.number} voided with its reason`);
const steelNow = await call(admin, `/items/${steel.body.id}`);
check(steelNow.body?.stock?.stock_count === 20, `steel stock is back to ${steelNow.body?.stock?.stock_count} pieces`);

// ─────────────────────── 7. an opening debt, a statement, the list ───────────────────────

step(7, 'Record an opening debt for a new company with a note, share its statement, and sort the list by balance');
const zagros = await call(nazdar.session, '/companies', {
  method: 'POST',
  body: { name: `Zagros Metals ${unique}`, settlement_currency: 'IQD' },
});
const openingDebt = await call(nazdar.session, `/companies/${zagros.body.id}/opening-balance`, {
  method: 'POST',
  body: { amount: 5_000_000, currency: 'IQD', entry_date: today, note: 'owed at go-live' },
});
check(openingDebt.status === 201, `opening debt ${openingDebt.body?.balance_after} د.ع with its note`);

const statement = await call(nazdar.session, `/companies/${zagros.body.id}/statement`);
check(statement.status === 200 && statement.body?.closing_balance === 5_000_000, 'the statement carries the same figure');

const byBalance = await call(nazdar.session, '/companies?sort=balance');
const balances = (byBalance.body?.items ?? []).map((row) => row.balance?.amount_iqd ?? 0);
// Ordered, not "our row is first": the script is run repeatedly against a database that keeps
// everything it made, so a second Zagros of the same size is a tie, not a failure.
check(
  balances.every((amount, index) => index === 0 || balances[index - 1] >= amount),
  `and the companies list puts the highest balance first (${balances[0]} د.ع)`,
);
check(balances[0] >= 5_000_000, "with this company's opening debt at the top of it");

// ─────────────────────── the invariant ───────────────────────

step(8, 'The invariant: the company balance is the sum of its ledger, and the allocation reconciles with it');
const finalLedger = await call(nazdar.session, `/companies/${alNoor.body.id}/ledger?raw=true`);
const sum = (finalLedger.body?.items ?? []).reduce((total, row) => total + row.amount_iqd, 0);
const profile = await call(nazdar.session, `/companies/${alNoor.body.id}`);
check(sum === finalLedger.body?.balance, `Σ ledger = ${sum} د.ع = the balance the API reports`);
check(profile.body?.balance?.amount_iqd === sum, 'and the same figure on the profile');
const finalBreakdown = await call(nazdar.session, `/companies/${alNoor.body.id}/purchase-breakdown`);
check(
  (finalBreakdown.body?.allocation?.purchases ?? []).reduce((total, row) => total + row.remaining, 0) +
    finalBreakdown.body?.allocation?.general ===
    sum,
  'Σ remaining + General still equals it after an edit, a void and a re-basing',
);

console.log(
  failures === 0
    ? '\nThe Iteration 2 demo script passed end to end.\n'
    : `\n${failures} step(s) failed — the demo is not ready.\n`,
);
process.exit(failures === 0 ? 0 : 1);

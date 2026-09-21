/**
 * The Iteration 5 demo script of specification 4.7, executable.
 *
 * The five steps of the brief, in order, against a live deployment: a shared tablet where Sara
 * sets a six-digit PIN and unlocks with it; the handover to Rebaz, whose PIN signs him in on
 * the browser he last used his password on, ending Sara's session; the payment he records,
 * which History marks as taken from a PIN session on Floor tablet 2; the admin revoking the
 * ticket and then switching PIN sign-in off for shared tablets altogether; and the Advanced
 * grid granting one key, with old set → new set in History.
 *
 * What a script cannot show is the part that lives in the browser: the recent-user list, the pad
 * itself, and each employee's own language coming back with them (FR-1103) — those are the
 * Playwright checks and the real-phone walk-through. Everything here is what the server must do
 * for those screens to be honest.
 *
 * Point it at staging with DEMO_BASE_URL. It leaves everything it creates behind on purpose.
 */
const BASE = process.env.DEMO_BASE_URL ?? 'http://localhost:3000/api/v1';
const ADMIN = process.env.DEMO_ADMIN ?? 'admin';
const ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD ?? 'ChangeMe!2026';
const TABLET = 'Floor tablet 2';

let failures = 0;
const step = (n, text) => console.log(`\n${n}. ${text}`);
const ok = (text) => console.log(`   ✓ ${text}`);
const bad = (text) => {
  failures += 1;
  console.log(`   ✗ ${text}`);
};
const check = (condition, text) => (condition ? ok(text) : bad(text));

/** A browser: its cookie jar, and the device ticket it keeps beside the display name. */
function browser(label = TABLET) {
  const cookies = new Map();
  return {
    label,
    tickets: new Map(),
    absorb(response) {
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const [name, value] = pair.split('=');
        cookies.set(name, value);
      }
    },
    forget() {
      cookies.clear();
    },
    header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
    csrf: () => cookies.get('mizan_csrf') ?? '',
  };
}

async function call(device, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: device.header(),
      ...(method === 'GET' ? {} : { 'X-CSRF-Token': device.csrf() }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  device.absorb(response);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** A password sign-in on this browser, which is what hands it a ticket (FR-106). */
async function signIn(device, username, password, { shared = true } = {}) {
  const response = await call(device, '/auth/login', {
    method: 'POST',
    body: {
      username_or_phone: username,
      password,
      is_shared_device: shared,
      device_label: device.label,
      replaces_ticket: device.tickets.get(username) ?? null,
    },
  });
  if (response.status === 200) device.tickets.set(username, response.body.device_ticket);
  return response;
}

const unique = Date.now().toString().slice(-6);
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Baghdad' });

const office = browser('Office laptop');
console.log(`Mizan — Iteration 5 demo script (shared tablets) against ${BASE}`);

const login = await signIn(office, ADMIN, ADMIN_PASSWORD, { shared: false });
check(login.status === 200, `signed in as ${ADMIN}`);
await call(office, '/settings/global-rates', {
  method: 'POST',
  body: { rate_iqd_per_usd: '1300', note: 'demo', confirm: true },
});
await call(office, '/settings', { method: 'PATCH', body: { allow_pin_switch_on_shared: true } });

const saraUser = await call(office, '/users', {
  method: 'POST',
  body: { display_name: 'Sara Kareem', username: `sara.${unique}`, role: 'employee', preset_key: 'sales' },
});
const rebazUser = await call(office, '/users', {
  method: 'POST',
  body: { display_name: 'Rebaz Ahmed', username: `rebaz.${unique}`, role: 'employee', preset_key: 'sales' },
});
check(saraUser.status === 201 && rebazUser.status === 201, 'two sales employees, from the preset');

// Each of them changes the temporary password, as the system makes them.
const passwords = { sara: `${saraUser.body.temporary_password}-demo`, rebaz: `${rebazUser.body.temporary_password}-demo` };
for (const [who, user, temporary] of [
  ['sara', saraUser, saraUser.body.temporary_password],
  ['rebaz', rebazUser, rebazUser.body.temporary_password],
]) {
  const first = browser('Office laptop');
  await call(first, '/auth/login', {
    method: 'POST',
    body: { username_or_phone: user.body.user.username, password: temporary },
  });
  await call(first, '/auth/change-password', {
    method: 'POST',
    body: { current: temporary, new: passwords[who] },
  });
}

// ─────────────── 1. Sara on the shared tablet: a six-digit PIN, and an unlock ───────────────

step(1, 'On a tablet marked "shared": Sara signs in, sets a six-digit PIN, the tablet locks, she unlocks with it');
const tablet = browser(TABLET);
const sarasSignIn = await signIn(tablet, saraUser.body.user.username, passwords.sara);
check(sarasSignIn.status === 200, `Sara signed in with her password on ${TABLET}`);
check(Boolean(tablet.tickets.get(saraUser.body.user.username)), 'the tablet was handed a device ticket for her');

const shortPin = await call(tablet, '/auth/pin', {
  method: 'POST',
  body: { pin: '4321', current_password: passwords.sara },
});
check(shortPin.status === 204, 'a four-digit PIN is accepted as a PIN…');

const lockedOut = await call(tablet, '/auth/lock', { method: 'POST' });
check(lockedOut.status === 204, 'the tablet locks');
const refusedShort = await call(tablet, '/auth/unlock', { method: 'POST', body: { pin: '4321' } });
check(
  refusedShort.body?.error?.fields?.[0]?.message_key === 'auth:pin_too_short',
  '…but on a shared tablet it is refused with "set a longer PIN" (FR-106)',
);

await call(tablet, '/auth/unlock', { method: 'POST', body: { password: passwords.sara } });
const sixDigits = await call(tablet, '/auth/pin', {
  method: 'POST',
  body: { pin: '246813', current_password: passwords.sara },
});
check(sixDigits.status === 204, 'she sets a six-digit PIN instead');

await call(tablet, '/auth/lock', { method: 'POST' });
const whileLocked = await call(tablet, '/orders');
check(whileLocked.status === 423, 'while locked every other call is refused (423)');

const wrong = await call(tablet, '/auth/unlock', { method: 'POST', body: { pin: '000000' } });
check(
  wrong.body?.error?.fields?.[0]?.params?.attempts_left === 4,
  `a wrong PIN says how many attempts are left (${wrong.body?.error?.fields?.[0]?.params?.attempts_left})`,
);

const unlocked = await call(tablet, '/auth/unlock', { method: 'POST', body: { pin: '246813' } });
check(unlocked.status === 204, 'and the right one opens the same session, with its drafts');
const meAfterUnlock = await call(tablet, '/auth/me');
check(
  meAfterUnlock.body?.auth_method === 'password',
  'which still says "password": that is how this session was opened (D-034)',
);

// ─────────────── 2. the handover: Rebaz's PIN, and Sara's session ending ───────────────

step(2, 'Sara taps "Switch user" → Rebaz → his PIN; his session starts and hers ends');
// Rebaz signed in with his password on this tablet earlier in the day, which is what leaves a
// ticket here for him; without that his PIN is worth nothing on this browser.
const rebazEarlier = browser(TABLET);
await signIn(rebazEarlier, rebazUser.body.user.username, passwords.rebaz);
const rebazTicket = rebazEarlier.tickets.get(rebazUser.body.user.username);
await call(rebazEarlier, '/auth/pin', {
  method: 'POST',
  body: { pin: '135791', current_password: passwords.rebaz },
});
check(Boolean(rebazTicket), 'Rebaz had signed in with his password on this tablet earlier');

// Sara puts the tablet down: it locks, and Rebaz takes it over with his PIN.
await call(tablet, '/auth/lock', { method: 'POST' });
const handover = await call(tablet, '/auth/login', {
  method: 'POST',
  body: {
    ticket: rebazTicket,
    pin: '135791',
    is_shared_device: true,
    device_label: TABLET,
    switch_from_session: true,
  },
});
check(handover.status === 200 && handover.body.user.display_name === 'Rebaz Ahmed', 'Rebaz is signed in');
check(
  handover.body?.device_ticket === undefined,
  'with no new ticket: a PIN sign-in proves the browser, it does not re-prove the person',
);
const meAsRebaz = await call(tablet, '/auth/me');
check(meAsRebaz.body?.auth_method === 'ticket_pin', 'and this session says so: signed in with a PIN');
check(meAsRebaz.body?.device_label === TABLET, `on ${meAsRebaz.body?.device_label}`);

const history = await call(office, `/history?limit=20`);
const entries = history.body?.items ?? [];
check(
  entries.some((entry) => entry.action === 'lock' && entry.actor_display_name === 'Sara Kareem'),
  "History shows Sara's lock",
);
check(
  entries.some((entry) => entry.action === 'switch_user' && entry.actor_display_name === 'Sara Kareem'),
  'and the handover under her name — she is the one who gave the device away',
);
check(
  entries.some(
    (entry) => entry.action === 'login' && entry.actor_display_name === 'Rebaz Ahmed' && entry.auth_method === 'ticket_pin',
  ),
  "and Rebaz's PIN sign-in",
);
ok('(the app opening in Rebaz\'s own language is the browser\'s part of this step — FR-1103)');

// ─────────────── 3. what he records carries the method ───────────────

step(3, 'Rebaz records a payment; the admin opens that History entry');
const customer = await call(office, '/customers', {
  method: 'POST',
  body: { name: `Kawa Trading ${unique}`, assigned_user_id: rebazUser.body.user.id },
});
const item = await call(office, '/items', {
  method: 'POST',
  body: { name: `Copper wire 2 mm ${unique}`, pricing_unit: 'per_kg' },
});
await call(office, `/items/${item.body.id}/prices/${today.slice(0, 7)}`, {
  method: 'PUT',
  body: { bought: { amount: 700, currency: 'IQD' }, sale: { amount: 850, currency: 'IQD' } },
});
await call(office, `/items/${item.body.id}/opening-stock`, {
  method: 'POST',
  body: { entry_date: today, qty_kg: '1000.000', note: 'counted at go-live' },
});

const order = await call(tablet, '/orders', {
  method: 'POST',
  body: {
    customer_id: customer.body.id,
    order_date: today,
    payment_type: 'borrowed',
    lines: [{ item_id: item.body.id, qty_kg: '20.000' }],
  },
});
const payment = await call(tablet, `/orders/${order.body.id}/payments`, {
  method: 'POST',
  body: { amount: 10_000, currency: 'IQD', entry_date: today, note: 'part payment at the gate' },
});
check(payment.status === 201, `a payment of 10,000 د.ع recorded from the tablet`);

// The payment's own History entry, which the order's tab lists under its ledger entries and
// History proper lists as a money entry by Rebaz.
const rebazHistory = await call(office, `/history?done_by=${rebazUser.body.user.id}&limit=50`);
const ledgerEntry = (rebazHistory.body?.items ?? []).find((entry) => entry.action === 'ledger_entry');
check(
  ledgerEntry?.auth_method === 'ticket_pin',
  'the History entry says it was taken from a PIN session (2.8: a disputed payment is traceable)',
);
const pinSignIn = (rebazHistory.body?.items ?? []).find(
  (entry) => entry.action === 'login' && entry.auth_method === 'ticket_pin',
);
check(
  pinSignIn?.changes?.device_label === TABLET,
  `and the sign-in it belongs to names the tablet: ${pinSignIn?.changes?.device_label}`,
);

// ─────────────── 4. the admin takes the PIN away ───────────────

step(4, 'The admin revokes the ticket, then switches PIN sign-in off for shared tablets');
const listed = await call(office, `/users/${rebazUser.body.user.id}/sessions`);
check(
  (listed.body?.device_tickets ?? []).some((ticket) => ticket.device_label === TABLET && ticket.revoked_at === null),
  `Sessions shows ${TABLET} among the browsers that may use his PIN`,
);

const revoked = await call(office, `/users/${rebazUser.body.user.id}/device-tickets`, { method: 'DELETE' });
check(revoked.body?.revoked >= 1, `${revoked.body?.revoked} ticket(s) revoked`);

const afterRevoke = await call(browser(TABLET), '/auth/login', {
  method: 'POST',
  body: { ticket: rebazTicket, pin: '135791', is_shared_device: true },
});
check(
  afterRevoke.body?.error?.params?.reason === 'ticket_invalid',
  'his next switch is asked for the password instead',
);

// A fresh password sign-in brings the PIN back, which is what makes this a reset.
const freshTablet = browser(TABLET);
await signIn(freshTablet, rebazUser.body.user.username, passwords.rebaz);
const backAgain = await call(browser(TABLET), '/auth/login', {
  method: 'POST',
  body: {
    ticket: freshTablet.tickets.get(rebazUser.body.user.username),
    pin: '135791',
    is_shared_device: true,
  },
});
check(backAgain.status === 200, 'and his password brings PIN sign-in back on this tablet');

await call(office, '/settings', { method: 'PATCH', body: { allow_pin_switch_on_shared: false } });
const switchedOff = await call(browser(TABLET), '/auth/login', {
  method: 'POST',
  body: {
    ticket: freshTablet.tickets.get(rebazUser.body.user.username),
    pin: '135791',
    is_shared_device: true,
  },
});
check(
  switchedOff.body?.error?.params?.reason === 'pin_switch_disabled',
  'with the switch off, a shared tablet offers passwords only',
);
const personalStillWorks = await call(browser('Rebaz phone'), '/auth/login', {
  method: 'POST',
  body: { username_or_phone: rebazUser.body.user.username, password: passwords.rebaz, is_shared_device: false },
});
check(personalStillWorks.status === 200, 'his own phone is unaffected — the setting is about shared tablets');
await call(office, '/settings', { method: 'PATCH', body: { allow_pin_switch_on_shared: true } });

// ─────────────── 5. the Advanced grid ───────────────

step(5, 'The admin opens Advanced on Rebaz and grants one key, watching what comes with it');
const before = await call(office, `/users/${rebazUser.body.user.id}/permissions`);
check(
  !before.body.keys.includes('companies.record_payment'),
  `he holds ${before.body.keys.length} keys, and paying suppliers is not one of them`,
);

// "Pay a company" implies seeing companies and their balances — the grid says so before saving.
const granted = await call(office, `/users/${rebazUser.body.user.id}/permissions`, {
  method: 'POST',
  body: {
    keys: [...new Set([...before.body.keys, 'companies.record_payment', 'companies.view', 'fields.see_company_balances'])],
    preset_key: null,
  },
});
check(granted.status === 201, 'the key is granted with the two it implies');

const permissionChange = (await call(office, `/history?entity_type=user&limit=20`)).body?.items?.find(
  (entry) => entry.action === 'permission_change' && entry.entity_id === rebazUser.body.user.id,
);
check(
  Array.isArray(permissionChange?.changes?.permissions?.old) &&
    Array.isArray(permissionChange?.changes?.permissions?.new),
  'History shows the old set → the new set (FR-103)',
);
check(
  (permissionChange?.changes?.granted ?? []).includes('companies.record_payment'),
  `naming what was added: ${(permissionChange?.changes?.granted ?? []).join(', ')}`,
);

const asRebaz = browser('Rebaz phone');
await signIn(asRebaz, rebazUser.body.user.username, passwords.rebaz, { shared: false });
const reachable = await call(asRebaz, '/companies');
check(reachable.status === 200, 'and the key is live on his very next request, with no re-login (FR-103)');

console.log(
  failures === 0
    ? '\nThe Iteration 5 demo script passed end to end.\n'
    : `\n${failures} step(s) failed — the demo is not ready.\n`,
);
process.exit(failures === 0 ? 0 : 1);

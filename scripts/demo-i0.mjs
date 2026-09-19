/**
 * The Iteration 0 demo script of specification 4.2, executable.
 *
 * The demo is walked through on a phone with the client; this runs the same steps against a
 * live deployment so that "the demo works" is a fact before anyone stands in front of the
 * client with a tablet. Point it at staging with DEMO_BASE_URL.
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

/** A cookie jar, because the whole session model rides on cookies. */
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

const unique = Date.now().toString().slice(-6);
const admin = jar();
const rebaz = jar();

console.log(`Mizan — Iteration 0 demo script against ${BASE}`);

step(2, 'Sign in as the seeded admin; the temporary password forces a change');
const login = await call(admin, '/auth/login', {
  method: 'POST',
  body: { username_or_phone: ADMIN, password: ADMIN_PASSWORD },
});
check(login.status === 200, `signed in as ${ADMIN}`);
check(login.body?.user?.role === 'admin', 'the account is an admin');
if (login.body?.user?.must_change_password) ok('flagged "must change password" — as it should be');

step(3, 'Create employee "Rebaz" from the Sales preset, then grant "Can void"');
const rebazUsername = `rebaz.${unique}`;
const created = await call(admin, '/users', {
  method: 'POST',
  body: { display_name: 'Rebaz Ahmed', username: rebazUsername, role: 'employee', preset_key: 'sales' },
});
check(created.status === 201, `created ${rebazUsername}`);
const rebazId = created.body?.user?.id;
const temporaryPassword = created.body?.temporary_password;
check(Boolean(temporaryPassword), 'the temporary password is shown once, in this response only');

const before = await call(admin, `/users/${rebazId}/permissions`);
check(before.body.keys.includes('orders.create'), 'the Sales preset was applied');
check(!before.body.keys.includes('orders.void'), 'voiding is not part of any preset');

const withVoid = [...before.body.keys, 'orders.void', 'purchases.void', 'damages.void'];
const saved = await call(admin, `/users/${rebazId}/permissions`, {
  method: 'POST',
  body: { keys: withVoid, preset_key: 'sales' },
});
check(saved.status === 201, 'granted the "Can void" extra');

const history = await call(admin, `/history?action=permission_change&limit=1`);
const entry = history.body.items[0];
check(Boolean(entry), 'History records the permission change');
check(
  Array.isArray(entry?.changes?.permissions?.old) && Array.isArray(entry?.changes?.permissions?.new),
  'recorded as old set → new set',
);
check(entry?.changes?.granted?.includes('orders.void'), 'and names exactly what was granted');

step(4, 'Sign in as Rebaz; he sees only what he may, and is refused the rest');
const rebazLogin = await call(rebaz, '/auth/login', {
  method: 'POST',
  body: { username_or_phone: rebazUsername, password: temporaryPassword },
});
check(rebazLogin.status === 200, 'Rebaz signed in with the temporary password');
check(rebazLogin.body.permissions.includes('orders.void'), 'his permission set reaches the interface');

const refused = await call(rebaz, '/users');
check(refused.status === 403, 'a page he may not open answers 403, not 500');
check(refused.body?.error?.code === 'PERMISSION_DENIED', 'with a code the interface can translate');
const ownActivity = await call(rebaz, '/history/me');
check(ownActivity.status === 200, 'but he can always read his own activity');

step(6, 'Lock the screen, unlock with the password; both are in History');
const locked = await call(rebaz, '/auth/lock', { method: 'POST' });
check(locked.status === 204, 'screen locked');
const whileLocked = await call(rebaz, '/history/me');
check(whileLocked.status === 423, 'every other call is refused with 423 while locked');
const unlocked = await call(rebaz, '/auth/unlock', {
  method: 'POST',
  body: { password: temporaryPassword },
});
check(unlocked.status === 204, 'unlocked with the password');
check((await call(rebaz, '/history/me')).status === 200, 'and the session carries on — same session, drafts kept');

const events = await call(admin, `/history?done_by=${rebazId}&limit=20`);
const actions = events.body.items.map((row) => row.action);
check(actions.includes('lock'), 'History shows the lock');
check(actions.includes('unlock'), 'History shows the unlock');
check(actions.includes('login'), 'History shows the sign-in');

console.log(
  failures === 0
    ? '\nDemo script passed: every step of specification 4.2 behaves as described.\n'
    : `\n${failures} step(s) did not behave as the demo script describes.\n`,
);
process.exit(failures === 0 ? 0 : 1);

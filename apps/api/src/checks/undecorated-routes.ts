/**
 * Rule 4: "Every API route carries `@RequirePermission(...)` or `@AdminOnly()`; a CI test
 * fails on an undecorated route" (spec 2.6.2, FR-104).
 *
 * `@Public()` and `@SessionOnly()` also count, because they are deliberate declarations —
 * the login screen and the user directory have to be reachable. What fails the build is a
 * route with *no* declaration at all, which is the case that happens by accident.
 */
import { collectRoutes } from './routes.js';

const routes = await collectRoutes();
const undecorated = routes.filter((route) => route.protection.kind === 'none');

for (const route of routes) {
  const label =
    route.protection.kind === 'permission'
      ? route.protection.keys.join(' + ')
      : route.protection.kind === 'admin'
        ? 'admin only'
        : route.protection.kind;
  console.log(`  ${route.method.padEnd(6)} ${route.path.padEnd(42)} ${label}`);
}

if (undecorated.length > 0) {
  console.error(`\n${undecorated.length} route(s) carry no permission declaration:\n`);
  for (const route of undecorated) {
    console.error(`  - ${route.method} ${route.path} (${route.controller}.${route.handler})`);
  }
  console.error('\nAdd @RequirePermission(...), @AdminOnly(), @SessionOnly() or @Public().\n');
  process.exit(1);
}

console.log(`\n${routes.length} routes, all declared.`);

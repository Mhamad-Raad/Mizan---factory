import { SetMetadata, applyDecorators } from '@nestjs/common';

/**
 * Rule 4: every route carries `@RequirePermission(...)` or `@AdminOnly()`. The two other
 * decorators exist so that the CI check can tell "deliberately open" from "forgotten":
 * `@Public()` for the login and health routes, `@SessionOnly()` for routes any signed-in
 * user may call (their own password, their own activity, the user directory — spec 2.7).
 */
export const PERMISSION_KEY = 'mizan:permission';
export const ADMIN_ONLY_KEY = 'mizan:admin_only';
export const PUBLIC_KEY = 'mizan:public';
export const SESSION_ONLY_KEY = 'mizan:session_only';
export const ALLOW_WHEN_LOCKED_KEY = 'mizan:allow_when_locked';

/**
 * One key, or several that are **all** required — the specification's route table writes the
 * money routes as `companies.view` + `fields.see_company_balances` (2.9.3), and a route that
 * needs two keys must ask for two rather than leaning on a response filter.
 */
export const RequirePermission = (...permissions: [string, ...string[]]) =>
  SetMetadata(PERMISSION_KEY, permissions);

export const AdminOnly = () => SetMetadata(ADMIN_ONLY_KEY, true);

export const Public = () => applyDecorators(SetMetadata(PUBLIC_KEY, true), SetMetadata(ALLOW_WHEN_LOCKED_KEY, true));

export const SessionOnly = () => SetMetadata(SESSION_ONLY_KEY, true);

/**
 * While a session is locked every call is refused with 423 except unlock, login, logout and
 * `me` (spec 2.8). Those four carry this marker.
 */
export const AllowWhenLocked = () => SetMetadata(ALLOW_WHEN_LOCKED_KEY, true);

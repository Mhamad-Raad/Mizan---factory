/**
 * The two accounts the screenshot suite signs in as. They live in their own module so both
 * the setup project (which creates them) and the specs (which sign in) can import them
 * without importing each other.
 */
export const ADMIN = { username: 'e2e.admin', password: 'mizan-e2e-2026-plum' } as const;
export const SALES = { username: 'e2e.rebaz', password: 'mizan-e2e-2026-rebaz' } as const;
/** The warehouse employee who records purchases, and the accountant who pays for them. */
export const WAREHOUSE = { username: 'e2e.hemin', password: 'mizan-e2e-2026-hemin' } as const;
export const ACCOUNTANT = { username: 'e2e.nazdar', password: 'mizan-e2e-2026-nazdar' } as const;

/** Where the suite reaches the API directly (not through the web server): `E2E_API_URL`. */
export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000/api/v1';

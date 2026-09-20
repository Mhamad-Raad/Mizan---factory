/**
 * The two accounts the screenshot suite signs in as. They live in their own module so both
 * the setup project (which creates them) and the specs (which sign in) can import them
 * without importing each other.
 */
export const ADMIN = { username: 'e2e.admin', password: 'mizan-e2e-2026-plum' } as const;
export const SALES = { username: 'e2e.rebaz', password: 'mizan-e2e-2026-rebaz' } as const;

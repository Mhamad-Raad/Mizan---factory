import { z } from 'zod';

/**
 * Configuration comes from the environment only (spec 2.13: secrets are never in the
 * repository). Names follow `.env.example` and sections 2.8, 2.13 and 2.14.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  DATABASE_MIGRATE_URL: z.string().min(1).optional(),
  /** Mixed into the session-token hash so a stolen database dump cannot replay a cookie. */
  SESSION_PEPPER: z.string().min(16),
  FIRST_ADMIN_USERNAME: z.string().default('admin'),
  FIRST_ADMIN_PASSWORD: z.string().optional(),
  APP_BASE_URL: z.string().default('http://localhost:5173'),
  TZ: z.string().default('Asia/Baghdad'),
  /**
   * Express's `trust proxy`: how many proxies stand in front of the API, so `request.ip` is the
   * browser's address and not the proxy's. `compose.yml` sets 1 (Caddy). The default trusts
   * nothing, so a client cannot choose its own address with an `X-Forwarded-For` header on a
   * server that is reached directly. A number of hops, `true`/`false`, or Express's list form
   * (`loopback, 172.16.0.0/12`).
   */
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((value): boolean | number | string => {
      const trimmed = value.trim();
      if (trimmed === 'false' || trimmed === '' || trimmed === '0') return false;
      if (trimmed === 'true') return true;
      if (/^\d+$/.test(trimmed)) return Number(trimmed);
      return trimmed;
    }),
  /** Sign-in attempts per address per door (auth/sign-in-throttle.ts). */
  SIGN_IN_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),
  SIGN_IN_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(200),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`);
  }
  return parsed.data;
}

export const ENV = Symbol('ENV');

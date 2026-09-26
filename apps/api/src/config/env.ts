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
  /** Wrong passwords per network address per hour, across every account (auth/sign-in-throttle.ts). */
  SIGN_IN_FAILURES_PER_HOUR: z.coerce.number().int().positive().default(100),
  /** How long an address that reached that ceiling is refused; doubles per further block in a day. */
  SIGN_IN_BLOCK_MINUTES: z.coerce.number().int().positive().default(5),
});

export type Env = z.infer<typeof schema>;

/**
 * Where `development` may run: this machine, or a private network a developer tests a phone on.
 * Development sends the session cookie without `Secure` (plain http on localhost would drop it),
 * so it must never be what a server on the internet runs by accident — and `NODE_ENV` unset
 * *is* development (security review, finding 13).
 */
export function isDevelopmentHost(appBaseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(appBaseUrl).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1') return true;
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'development' && !isDevelopmentHost(env.APP_BASE_URL)) {
    throw new Error(
      'Invalid environment configuration:\n' +
        `  - NODE_ENV is "development"${source.NODE_ENV ? '' : ' (the default when it is not set)'}, which sends ` +
        `the session cookie without Secure, but APP_BASE_URL is ${env.APP_BASE_URL} — not this machine or a ` +
        'private network. Set NODE_ENV=production for a real server, or point APP_BASE_URL at localhost for development.',
    );
  }
  return env;
}

export const ENV = Symbol('ENV');

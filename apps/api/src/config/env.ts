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

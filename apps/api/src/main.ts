import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { applyRequestLimits } from './request-limits.js';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { StructuredLogger } from './common/logger.js';
import { loadEnv } from './config/env.js';
import { pendingMigrations } from './database/migrate.js';

const env = loadEnv();
const logger = new Logger('Bootstrap');

// The API refuses to start on a pending migration (spec 2.14), so a deploy can never serve
// requests against a schema it does not expect. Checked as the application role: the API has
// no use for the migrate role's credentials and is not given them (security review, 9).
const pending = await pendingMigrations(env.DATABASE_URL).catch((error: Error) => {
  logger.error(`refusing to start: ${error.message}`);
  process.exit(1);
});
if (pending.length > 0) {
  logger.error(`refusing to start: ${pending.length} pending migration(s): ${pending.join(', ')}`);
  process.exit(1);
}

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  bodyParser: true,
  logger: env.NODE_ENV === 'production' ? new StructuredLogger() : undefined,
});
applyRequestLimits(app);
// Behind Caddy, `request.ip` must be the browser's address — the sign-in throttle counts by it,
// and History records it (security review, finding 4). See TRUST_PROXY in config/env.ts.
app.set('trust proxy', env.TRUST_PROXY);
app.setGlobalPrefix('api/v1');
app.use(cookieParser());
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'same-origin' },
  }),
);
app.enableCors({ origin: env.APP_BASE_URL, credentials: true });

await app.listen(env.PORT);
logger.log(`Mizan API listening on ${env.PORT} (${env.NODE_ENV})`);

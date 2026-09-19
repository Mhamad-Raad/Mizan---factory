import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { StructuredLogger } from './common/logger.js';
import { loadEnv } from './config/env.js';
import { pendingMigrations } from './database/migrate.js';

const env = loadEnv();
const logger = new Logger('Bootstrap');

// The API refuses to start on a pending migration (spec 2.14), so a deploy can never serve
// requests against a schema it does not expect.
const pending = await pendingMigrations(env.DATABASE_MIGRATE_URL ?? env.DATABASE_URL);
if (pending.length > 0) {
  logger.error(`refusing to start: ${pending.length} pending migration(s): ${pending.join(', ')}`);
  process.exit(1);
}

const app = await NestFactory.create(AppModule, {
  bodyParser: true,
  logger: env.NODE_ENV === 'production' ? new StructuredLogger() : undefined,
});
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

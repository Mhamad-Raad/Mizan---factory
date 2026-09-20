import { Inject, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ENV, loadEnv } from './config/env.js';
import type { Env } from './config/env.js';
import { AuditService } from './audit/audit.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { PasswordService } from './auth/password.service.js';
import { SessionService } from './auth/session.service.js';
import { CsrfMiddleware } from './common/csrf.middleware.js';
import { ErrorFilter } from './common/error.filter.js';
import { IdempotencyInterceptor } from './common/idempotency.interceptor.js';
import { RequestIdMiddleware } from './common/request-id.middleware.js';
import { SensitiveFieldInterceptor } from './common/sensitive-field.interceptor.js';
import { Database } from './database/pool.js';
import { HealthController } from './health/health.controller.js';
import { HistoryController } from './history/history.controller.js';
import { HistoryRepository } from './history/history.repository.js';
import { ItemsController } from './items/items.controller.js';
import { ItemsRepository } from './items/items.repository.js';
import { ItemsService } from './items/items.service.js';
import { CustomerLedgerService } from './ledger/customer-ledger.service.js';
import { RatesService } from './rates/rates.service.js';
import { PeriodService } from './settings/period.service.js';
import { StockService } from './stock/stock.service.js';
import { SettingsController } from './settings/settings.controller.js';
import { SettingsService } from './settings/settings.service.js';
import { UsersController } from './users/users.controller.js';
import { UsersRepository } from './users/users.repository.js';
import { UsersService } from './users/users.service.js';

/**
 * One module. Iteration 1 adds materials, customers and orders, with the shared money
 * services they all go through: the global rate, the customer ledger writer, the stock ledger
 * and the period lock. Companies, purchases and damages arrive with their own iterations.
 */
@Module({
  controllers: [
    AuthController,
    UsersController,
    HistoryController,
    SettingsController,
    ItemsController,
    HealthController,
  ],
  providers: [
    { provide: ENV, useFactory: (): Env => loadEnv() },
    Database,
    AuditService,
    PasswordService,
    SessionService,
    AuthService,
    AuthGuard,
    UsersRepository,
    UsersService,
    HistoryRepository,
    SettingsService,
    PeriodService,
    RatesService,
    StockService,
    CustomerLedgerService,
    ItemsRepository,
    ItemsService,
    IdempotencyInterceptor,
    // The guard runs on every route: a route without a decorator is refused, not opened.
    { provide: APP_GUARD, useExisting: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
    { provide: APP_INTERCEPTOR, useClass: SensitiveFieldInterceptor },
    { provide: APP_INTERCEPTOR, useExisting: IdempotencyInterceptor },
  ],
  exports: [Database, AuthGuard],
})
export class AppModule implements NestModule {
  constructor(@Inject(ENV) private readonly env: Env) {}

  configure(consumer: MiddlewareConsumer): void {
    const csrf = new CsrfMiddleware(this.env.APP_BASE_URL);
    consumer.apply(RequestIdMiddleware).forRoutes('*path');
    consumer.apply(csrf.use.bind(csrf)).forRoutes('*path');
  }
}

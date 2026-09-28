import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Database } from './pool.js';

/** Once an hour: cheap, and nothing waits on it. */
const EVERY_MS = 60 * 60 * 1000;

/**
 * The API's own housekeeping: expired idempotency keys and long-dead sessions are deleted by
 * `mizan_prune_expired()` (migration 0021). Nothing called it outside a test, so every write
 * kept its stored response for ever — millions of rows over the years this system is meant to
 * run unattended (review). It runs at start-up and then hourly; a failure is logged and the
 * next hour tries again, it never takes the API down.
 */
@Injectable()
export class HousekeepingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Housekeeping');
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly database: Database) {}

  onModuleInit(): void {
    void this.prune();
    this.timer = setInterval(() => void this.prune(), EVERY_MS);
    // An interval must not keep a finished process (a test, a one-off script) alive.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async prune(): Promise<void> {
    try {
      const { rows } = await this.database.query<{ pruned_idempotency_keys: string; pruned_sessions: string }>(
        'SELECT * FROM mizan_prune_expired()',
      );
      const row = rows[0];
      if (row && (Number(row.pruned_idempotency_keys) > 0 || Number(row.pruned_sessions) > 0)) {
        this.logger.log(`pruned ${row.pruned_idempotency_keys} idempotency keys, ${row.pruned_sessions} sessions`);
      }
    } catch (error) {
      this.logger.error(`prune failed: ${(error as Error).message}`);
    }
  }
}

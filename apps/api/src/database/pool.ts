import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';
import { ENV } from '../config/env.js';
import type { Env } from '../config/env.js';

/** A connection that may be the pool or an open transaction. Repositories accept either. */
export interface Db {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * The database. Every statement is parameterised (spec 2.13) and every write that touches a
 * ledger runs inside `transaction()` together with the record it belongs to (rule 2 of
 * CLAUDE.md, spec 2.4.1 rule 1).
 */
@Injectable()
export class Database implements Db, OnModuleDestroy {
  private readonly logger = new Logger('Database');
  private readonly pool: Pool;

  constructor(@Inject(ENV) env: Env) {
    this.pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      application_name: 'mizan-api',
    });
    this.pool.on('error', (error) => this.logger.error(`idle client error: ${error.message}`));
  }

  query<R extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
    return this.pool.query<R>(text, values);
  }

  /**
   * One transaction per write. The callback receives the same `Db` interface, so a repository
   * method is written once and works both standalone and inside a larger transaction.
   */
  async transaction<T>(work: (tx: Db & { client: PoolClient }) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const scoped = {
        client,
        query: <R extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) =>
          client.query<R>(text, values),
      };
      const result = await work(scoped);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators.js';
import { Database } from '../database/pool.js';

@Controller('health')
export class HealthController {
  constructor(private readonly database: Database) {}

  /** Liveness and readiness for the uptime check every minute (spec 2.14). */
  @Get()
  @Public()
  async health() {
    const start = Date.now();
    await this.database.query('SELECT 1');
    return { status: 'ok', database_ms: Date.now() - start, time: new Date().toISOString() };
  }
}

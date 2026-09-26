import { Injectable } from '@nestjs/common';
import { formatRate } from '@mizan/money';
import type { Rate } from '@mizan/money';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/errors.js';
import type { RequestContext } from '../common/request-context.js';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';

export interface GlobalRateRow {
  id: string;
  rate_iqd_per_usd: string;
  effective_from: Date;
  note: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: Date;
}

export interface CurrentRate {
  rate_iqd_per_usd: Rate;
  effective_from: string;
}

/**
 * The global default rate (FR-1106): the customer-side rate, kept as an append-only history
 * so every stored amount can name the rate it was filled with and none is ever recomputed.
 */
@Injectable()
export class RatesService {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
  ) {}

  /** The row with the latest `effective_from ≤ now()`, or null before the first rate is set. */
  async current(tx?: Db): Promise<CurrentRate | null> {
    const { rows } = await (tx ?? this.database).query<{
      rate_iqd_per_usd: string;
      effective_from: Date;
    }>(
      `SELECT rate_iqd_per_usd::text AS rate_iqd_per_usd, effective_from
         FROM global_rates
        WHERE effective_from <= now()
        ORDER BY effective_from DESC
        LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;

    return {
      rate_iqd_per_usd: formatRate(row.rate_iqd_per_usd),
      effective_from: row.effective_from.toISOString(),
    };
  }

  /**
   * Every amount an order or a payment stores needs a rate, so a system with no rate yet
   * cannot record money. The refusal names the field and says what to do rather than
   * inventing a rate nobody agreed to (go-live checklist, section 4.8).
   */
  async requireCurrent(tx?: Db): Promise<Rate> {
    const rate = await this.current(tx);
    if (!rate) {
      throw ApiError.validation([
        {
          path: 'rate_iqd_per_usd',
          code: 'NO_GLOBAL_RATE',
          message_key: 'errors:no_global_rate',
          params: {},
        },
      ]);
    }
    return rate.rate_iqd_per_usd;
  }

  async history(limit = 50): Promise<GlobalRateRow[]> {
    const { rows } = await this.database.query<GlobalRateRow>(
      `SELECT r.id, r.rate_iqd_per_usd::text AS rate_iqd_per_usd, r.effective_from, r.note,
              r.created_by, u.display_name AS created_by_name, r.created_at
         FROM global_rates r
         LEFT JOIN users u ON u.id = r.created_by
        ORDER BY r.effective_from DESC
        LIMIT $1`,
      [Math.min(limit, 100)],
    );
    return rows;
  }

  /** A new rate (FR-1106), kept as append-only history so stored amounts keep their own rate. */
  async set(
    context: RequestContext,
    input: { rate_iqd_per_usd: string; note?: string | null },
  ): Promise<CurrentRate> {
    const rate = formatRate(input.rate_iqd_per_usd);
    if (Number(rate) <= 0) {
      throw ApiError.validation([
        {
          path: 'rate_iqd_per_usd',
          code: 'INVALID',
          message_key: 'errors:field.required',
          params: {},
        },
      ]);
    }

    const previous = await this.current();

    await this.database.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO global_rates (rate_iqd_per_usd, note, created_by) VALUES ($1, $2, $3)`,
        [rate, input.note?.trim() || null, context.userId],
      );
      await this.audit.record(
        context,
        {
          action: 'rate_change',
          entity_type: 'settings',
          entity_id: 'global_rate',
          entity_label: 'Global default rate',
          changes: { rate_iqd_per_usd: { old: previous?.rate_iqd_per_usd ?? null, new: rate } },
          note: input.note?.trim() || null,
        },
        tx,
      );
    });

    return (await this.current()) as CurrentRate;
  }
}

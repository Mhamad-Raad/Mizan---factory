import { Body, Controller, Get, HttpCode, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { AdminOnly, RequirePermission, SessionOnly } from '../common/decorators.js';
import { contextOf } from '../common/request-context.js';
import type { RequestWithContext } from '../common/request-context.js';
import { zodBody } from '../common/zod.pipe.js';
import { RatesService } from '../rates/rates.service.js';
import { SettingsService } from './settings.service.js';
import { PUBLIC_SETTING_KEYS } from './settings.types.js';

const patchSchema = z
  .object({
    idle_lock_shared_minutes: z.number().int().min(1).max(120).optional(),
    idle_lock_default_minutes: z.number().int().min(1).max(1440).optional(),
    week_start: z.enum(['sat', 'sun', 'mon']).optional(),
    date_format: z.literal('dd/MM/yyyy').optional(),
    // Iteration 1: the System card of the Settings page (FR-1107, FR-1109).
    allow_negative_stock: z.boolean().optional(),
    default_customer_currency: z.enum(['IQD', 'USD']).optional(),
    rate_guard_percent: z.number().int().min(1).max(100).optional(),
    settle_tolerance_iqd: z.number().int().min(0).max(100_000).optional(),
    settle_tolerance_usd_cents: z.number().int().min(0).max(10_000).optional(),
    order_edit_window_days: z.number().int().min(0).max(365).nullable().optional(),
    // Iteration 2: the same window for purchases (FR-405).
    purchase_edit_window_days: z.number().int().min(0).max(365).nullable().optional(),
    allow_edit_after_payment: z.boolean().optional(),
    locked_through: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    rate_stale_days: z.number().int().min(1).max(60).optional(),
  })
  // Unknown keys are refused rather than dropped: an admin who types a setting this
  // iteration does not own must be told, not quietly ignored.
  .strict();

const rateSchema = z.object({
  rate_iqd_per_usd: z.union([z.string().regex(/^\d+(\.\d{1,4})?$/), z.number().positive()]),
  note: z.string().max(2000).nullish(),
  /** The ±`rate_guard_percent` guard asks for confirmation rather than refusing outright. */
  confirm: z.boolean().optional(),
});

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly rates: RatesService,
  ) {}

  /**
   * An admin reads every setting; everyone else reads the keys their screens need in order to
   * behave correctly — the week start and date format for rendering, and the stock, tolerance
   * and edit-window rules so a form can warn *before* the API refuses (FR-1107, spec 2.6.3).
   * Nothing here is sensitive; the rules it exposes are the ones the employee is subject to.
   */
  @Get()
  @SessionOnly()
  async read(@Req() request: RequestWithContext) {
    const all = await this.settings.all();
    if (contextOf(request).role === 'admin') return all;
    return Object.fromEntries(PUBLIC_SETTING_KEYS.map((key) => [key, all[key]]));
  }

  @Patch()
  @AdminOnly()
  async update(@Req() request: RequestWithContext, @Body(zodBody(patchSchema)) body: z.infer<typeof patchSchema>) {
    return this.settings.update(contextOf(request), body);
  }

  /**
   * The global default rate and its history (FR-1106). Any signed-in user may read it — every
   * amount they enter is filled with it, so hiding it would only make the screens lie — while
   * setting it needs `settings.set_global_rate`.
   */
  @Get('global-rates')
  @SessionOnly()
  async rateHistory(@Query(zodBody(z.object({ limit: z.coerce.number().int().positive().max(100).optional() }))) query: {
    limit?: number;
  }) {
    const [current, history] = await Promise.all([this.rates.current(), this.rates.history(query.limit)]);
    return {
      current,
      items: history.map((row) => ({
        id: row.id,
        rate_iqd_per_usd: row.rate_iqd_per_usd,
        effective_from: row.effective_from.toISOString(),
        note: row.note,
        created_by: row.created_by,
        created_by_name: row.created_by_name,
      })),
    };
  }

  @Post('global-rates')
  @RequirePermission('settings.set_global_rate')
  @HttpCode(201)
  async setRate(@Req() request: RequestWithContext, @Body(zodBody(rateSchema)) body: z.infer<typeof rateSchema>) {
    return this.rates.set(contextOf(request), {
      rate_iqd_per_usd: String(body.rate_iqd_per_usd),
      note: body.note ?? null,
      confirm: body.confirm,
    });
  }
}

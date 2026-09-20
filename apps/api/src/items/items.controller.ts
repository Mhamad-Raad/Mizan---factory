import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { AdminOnly, RequirePermission } from '../common/decorators.js';
import { contextOf } from '../common/request-context.js';
import type { RequestWithContext } from '../common/request-context.js';
import { SensitiveFields } from '../common/sensitive-field.interceptor.js';
import { zodBody } from '../common/zod.pipe.js';
import { ItemsService } from './items.service.js';

const uuid = z.string().uuid();
const kg = z.string().regex(/^-?\d{1,9}(\.\d{1,3})?$/);
const money = z.object({
  amount: z.number().int(),
  currency: z.enum(['IQD', 'USD']),
  /** Overwriting the calculated side stores the implied rate as `manual` (spec 2.3.2). */
  other_amount: z.number().int().nullish(),
});

const listSchema = z.object({
  q: z.string().max(200).optional(),
  pricing_unit: z.enum(['per_piece', 'per_kg']).optional(),
  stock: z.enum(['in', 'out']).optional(),
  include_inactive: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().positive().optional(),
  page_size: z.coerce.number().int().positive().max(100).optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  pricing_unit: z.enum(['per_piece', 'per_kg']),
  code: z.string().max(40).nullish(),
  min_stock_count: z.number().int().min(0).nullish(),
  min_stock_kg: kg.nullish(),
  notes: z.string().max(2000).nullish(),
});

const updateSchema = createSchema.partial().extend({ version: z.number().int().positive() });
const versionSchema = z.object({ version: z.number().int().positive() });

const pricesSchema = z.object({
  bought: money.nullish(),
  sale: money.nullish(),
  note: z.string().max(2000).nullish(),
  version: z.number().int().positive().nullish(),
});

const copyMonthSchema = z.object({
  source_month: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/),
  target_month: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/),
  item_ids: z.array(uuid).max(1000).nullish(),
});

const movementSchema = z.object({
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  qty_count: z.number().int().nullish(),
  qty_kg: kg.nullish(),
  unit_cost: money.nullish(),
  note: z.string().min(1).max(2000),
});

const pageSchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  page_size: z.coerce.number().int().positive().max(100).optional(),
});

const historySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

/**
 * Materials, their monthly prices and their stock movements (FR-301 to FR-309).
 *
 * `@SensitiveFields` removes every `bought` key from every response of this controller for a
 * user without `fields.see_bought_price` — list rows, the detail card, the price list and the
 * opening-stock valuation alike — so the flag is enforced in one place rather than remembered
 * at each shape (FR-305, spec 2.6.2).
 */
@Controller()
@SensitiveFields({ bought: 'fields.see_bought_price', unit_cost_iqd: 'fields.see_bought_price', unit_cost_usd_cents: 'fields.see_bought_price' })
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get('items')
  @RequirePermission('materials.view')
  async list(@Query(zodBody(listSchema)) query: z.infer<typeof listSchema>) {
    return this.items.list({
      q: query.q,
      pricing_unit: query.pricing_unit,
      stock: query.stock,
      include_inactive: query.include_inactive === 'true',
      page: query.page,
      page_size: query.page_size,
    });
  }

  @Post('items')
  @RequirePermission('materials.create')
  @HttpCode(201)
  async create(@Req() request: RequestWithContext, @Body(zodBody(createSchema)) body: z.infer<typeof createSchema>) {
    return this.items.create(contextOf(request), {
      name: body.name,
      pricing_unit: body.pricing_unit,
      code: body.code ?? null,
      min_stock_count: body.min_stock_count ?? null,
      min_stock_kg: body.min_stock_kg ?? null,
      notes: body.notes ?? null,
    });
  }

  /** The copy-month action sits before `items/:id` so "prices" is never read as an id. */
  @Post('items/prices/copy-month')
  @RequirePermission('materials.set_prices')
  async copyMonth(
    @Req() request: RequestWithContext,
    @Body(zodBody(copyMonthSchema)) body: z.infer<typeof copyMonthSchema>,
  ) {
    return this.items.copyMonth(contextOf(request), {
      source_month: normalizeMonth(body.source_month),
      target_month: normalizeMonth(body.target_month),
      item_ids: body.item_ids ?? null,
    });
  }

  @Get('items/:id')
  @RequirePermission('materials.view')
  async get(@Param('id') id: string) {
    return this.items.get(id);
  }

  @Patch('items/:id')
  @RequirePermission('materials.edit')
  async update(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    return this.items.update(contextOf(request), id, {
      ...body,
      code: body.code ?? undefined,
      min_stock_count: body.min_stock_count ?? undefined,
      min_stock_kg: body.min_stock_kg ?? undefined,
      notes: body.notes ?? undefined,
    });
  }

  @Post('items/:id/deactivate')
  @RequirePermission('materials.edit')
  @HttpCode(200)
  async deactivate(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(versionSchema)) body: z.infer<typeof versionSchema>,
  ) {
    return this.items.setActive(contextOf(request), id, false, body.version);
  }

  @Post('items/:id/reactivate')
  @RequirePermission('materials.edit')
  @HttpCode(200)
  async reactivate(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(versionSchema)) body: z.infer<typeof versionSchema>,
  ) {
    return this.items.setActive(contextOf(request), id, true, body.version);
  }

  /** Delete sets `deleted_at`; rows are never physically removed (A-32). */
  @Delete('items/:id')
  @AdminOnly()
  @HttpCode(204)
  async remove(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(versionSchema)) body: z.infer<typeof versionSchema>,
  ) {
    await this.items.softDelete(contextOf(request), id, body.version);
  }

  @Get('items/:id/prices')
  @RequirePermission('materials.view')
  async prices(@Param('id') id: string) {
    return this.items.prices(id);
  }

  @Put('items/:id/prices/:month')
  @RequirePermission('materials.set_prices')
  async setPrices(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Param('month') month: string,
    @Body(zodBody(pricesSchema)) body: z.infer<typeof pricesSchema>,
  ) {
    return this.items.setMonthPrices(contextOf(request), id, normalizeMonth(month), {
      bought: body.bought ?? null,
      sale: body.sale ?? null,
      note: body.note ?? null,
      version: body.version ?? null,
    });
  }

  @Get('items/:id/movements')
  @RequirePermission('materials.view')
  async movements(@Param('id') id: string, @Query(zodBody(pageSchema)) query: z.infer<typeof pageSchema>) {
    return this.items.movements(id, query);
  }

  @Post('items/:id/opening-stock')
  @RequirePermission('materials.opening_stock')
  @HttpCode(201)
  async openingStock(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(movementSchema)) body: z.infer<typeof movementSchema>,
  ) {
    return this.items.recordMovement(contextOf(request), id, 'opening', {
      entry_date: body.entry_date,
      qty_count: body.qty_count ?? null,
      qty_kg: body.qty_kg ?? null,
      unit_cost: body.unit_cost ?? null,
      note: body.note,
    });
  }

  @Post('items/:id/stock-adjustments')
  @RequirePermission('materials.opening_stock')
  @HttpCode(201)
  async adjustStock(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(movementSchema)) body: z.infer<typeof movementSchema>,
  ) {
    return this.items.recordMovement(contextOf(request), id, 'adjustment', {
      entry_date: body.entry_date,
      qty_count: body.qty_count ?? null,
      qty_kg: body.qty_kg ?? null,
      unit_cost: body.unit_cost ?? null,
      note: body.note,
    });
  }

  @Get('items/:id/history')
  @RequirePermission('materials.view')
  async history(@Param('id') id: string, @Query(zodBody(historySchema)) query: z.infer<typeof historySchema>) {
    return this.items.historyOf(id, query);
  }
}

/** `2026-09` and `2026-09-18` both mean September; a month is stored as its first day. */
function normalizeMonth(value: string): string {
  return value.length === 7 ? `${value}-01` : value;
}

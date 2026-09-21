import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../common/decorators.js';
import { contextOf } from '../common/request-context.js';
import type { RequestWithContext } from '../common/request-context.js';
import { SensitiveFields } from '../common/sensitive-field.interceptor.js';
import { zodBody } from '../common/zod.pipe.js';
import { DamagesService } from './damages.service.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const kg = z.string().regex(/^\d{1,9}(\.\d{1,3})?$/);
const attribution = z.enum(['none', 'customer_order', 'us', 'company']);

const createSchema = z.object({
  item_id: z.string().uuid(),
  qty_count: z.number().int().positive().nullish(),
  qty_kg: kg.nullish(),
  damage_date: isoDate,
  reason: z.string().max(2000).nullish(),
  attribution: attribution.optional(),
  order_id: z.string().uuid().nullish(),
  company_id: z.string().uuid().nullish(),
  purchase_id: z.string().uuid().nullish(),
  is_returnable: z.boolean().optional(),
  notes: z.string().max(2000).nullish(),
  acting_user_id: z.string().uuid().nullish(),
});

const updateSchema = createSchema
  .omit({ item_id: true, damage_date: true })
  .partial()
  .extend({ damage_date: isoDate.optional(), version: z.number().int().positive() });

const voidSchema = z.object({
  reason: z.string().min(1).max(2000),
  version: z.number().int().positive().optional(),
});

const returnSchema = z.object({
  status: z.enum(['returned', 'written_off']),
  returned_at: isoDate.nullish(),
  note: z.string().max(2000).nullish(),
  credit: z
    .object({
      amount: z.number().int().positive(),
      currency: z.enum(['IQD', 'USD']),
      other_amount: z.number().int().positive().nullish(),
      note: z.string().max(2000).nullish(),
    })
    .nullish(),
});

const returnToStockSchema = z.object({ note: z.string().max(2000).nullish() });

const listSchema = z.object({
  item_id: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  attribution: attribution.optional(),
  return_status: z
    .enum(['not_returnable', 'pending', 'returned', 'returned_credited', 'written_off'])
    .optional(),
  returnable: z.enum(['true', 'false']).optional(),
  done_by: z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  order_id: z.string().uuid().optional(),
  purchase_id: z.string().uuid().optional(),
  include_void: z.enum(['true', 'false']).optional(),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().positive().optional(),
  page_size: z.coerce.number().int().positive().max(100).optional(),
});

const historySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

/**
 * Damaged items and returns (FR-801 to FR-807).
 *
 * Damage is not scoped: it belongs to the factory and the filters of FR-801 are what narrows
 * the list. What is withheld is the **value**, which is a bought price: `cost` carries every
 * amount on a record and in the period totals, and is stripped for a caller without
 * `fields.see_bought_price` while the material, the quantities and the dates stay readable
 * (FR-807, D-022).
 */
@Controller()
@SensitiveFields({ cost: 'fields.see_bought_price' })
export class DamagesController {
  constructor(private readonly damages: DamagesService) {}

  @Get('damages')
  @RequirePermission('damages.view')
  async list(@Query(zodBody(listSchema)) query: z.infer<typeof listSchema>) {
    return this.damages.list({
      ...query,
      returnable: query.returnable === 'true',
      include_void: query.include_void === 'true',
    });
  }

  @Post('damages')
  @RequirePermission('damages.create')
  @HttpCode(201)
  async create(@Req() request: RequestWithContext, @Body(zodBody(createSchema)) body: z.infer<typeof createSchema>) {
    return this.damages.create(contextOf(request), toCreateInput(body));
  }

  @Get('damages/:id')
  @RequirePermission('damages.view')
  async get(@Param('id') id: string) {
    return this.damages.get(id);
  }

  @Patch('damages/:id')
  @RequirePermission('damages.edit')
  async update(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    return this.damages.update(contextOf(request), id, {
      version: body.version,
      qty_count: body.qty_count === undefined ? undefined : (body.qty_count ?? null),
      qty_kg: body.qty_kg === undefined ? undefined : (body.qty_kg ?? null),
      damage_date: body.damage_date,
      reason: body.reason === undefined ? undefined : (body.reason ?? null),
      attribution: body.attribution,
      order_id: body.order_id === undefined ? undefined : (body.order_id ?? null),
      company_id: body.company_id === undefined ? undefined : (body.company_id ?? null),
      purchase_id: body.purchase_id === undefined ? undefined : (body.purchase_id ?? null),
      is_returnable: body.is_returnable,
      notes: body.notes === undefined ? undefined : (body.notes ?? null),
      acting_user_id: body.acting_user_id ?? null,
    });
  }

  @Post('damages/:id/void')
  @RequirePermission('damages.void')
  @HttpCode(200)
  async void(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(voidSchema)) body: z.infer<typeof voidSchema>,
  ) {
    return this.damages.void(contextOf(request), id, body);
  }

  /**
   * "Mark returned" / "Written off", with the supplier credit when one is sent (FR-803,
   * FR-805). The route asks for `damages.mark_returned`; the credit additionally needs
   * `companies.record_credit`, which the service checks with the record loaded — the credit is
   * optional, so it cannot be a second key on the route (the same shape as D-023's converse).
   */
  @Post('damages/:id/return')
  @RequirePermission('damages.mark_returned')
  @HttpCode(200)
  async markReturn(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(returnSchema)) body: z.infer<typeof returnSchema>,
  ) {
    return this.damages.markReturn(contextOf(request), id, {
      status: body.status,
      returned_at: body.returned_at ?? null,
      note: body.note ?? null,
      credit: body.credit
        ? {
            amount: body.credit.amount,
            currency: body.credit.currency,
            other_amount: body.credit.other_amount ?? null,
            note: body.credit.note ?? null,
          }
        : null,
    });
  }

  /** "Return to stock" for goods a customer brought back that turn out usable (FR-804). */
  @Post('damages/:id/return-to-stock')
  @RequirePermission('damages.edit')
  @HttpCode(200)
  async returnToStock(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(returnToStockSchema)) body: z.infer<typeof returnToStockSchema>,
  ) {
    return this.damages.returnToStock(contextOf(request), id, body);
  }

  @Get('damages/:id/history')
  @RequirePermission('damages.view')
  async history(@Param('id') id: string, @Query(zodBody(historySchema)) query: z.infer<typeof historySchema>) {
    return this.damages.historyOf(id, query);
  }
}

function toCreateInput(body: z.infer<typeof createSchema>) {
  return {
    item_id: body.item_id,
    qty_count: body.qty_count ?? null,
    qty_kg: body.qty_kg ?? null,
    damage_date: body.damage_date,
    reason: body.reason ?? null,
    attribution: body.attribution ?? 'none',
    order_id: body.order_id ?? null,
    company_id: body.company_id ?? null,
    purchase_id: body.purchase_id ?? null,
    is_returnable: body.is_returnable ?? false,
    notes: body.notes ?? null,
    acting_user_id: body.acting_user_id ?? null,
  };
}

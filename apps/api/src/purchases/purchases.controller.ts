import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../common/decorators.js';
import { contextOf } from '../common/request-context.js';
import type { RequestWithContext } from '../common/request-context.js';
import { SensitiveFields } from '../common/sensitive-field.interceptor.js';
import { zodBody } from '../common/zod.pipe.js';
import { PurchasesService } from './purchases.service.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const kg = z.string().regex(/^\d{1,9}(\.\d{1,3})?$/);
const money = z.object({
  amount: z.number().int(),
  currency: z.enum(['IQD', 'USD']),
  other_amount: z.number().int().nullish(),
});

const lineSchema = z.object({
  item_id: z.string().uuid(),
  qty_count: z.number().int().positive().nullish(),
  qty_kg: kg.nullish(),
  unit_price: money.nullish(),
  note: z.string().max(500).nullish(),
});

const createSchema = z.object({
  /** Null is legitimate: "No company (stock only)" (FR-407). */
  company_id: z.string().uuid().nullish(),
  purchase_date: isoDate,
  notes: z.string().max(2000).nullish(),
  rate_iqd_per_usd: z
    .string()
    .regex(/^\d+(\.\d{1,4})?$/)
    .nullish(),
  discount: money.nullish(),
  lines: z.array(lineSchema).min(1).max(200),
  acting_user_id: z.string().uuid().nullish(),
});

const replaceSchema = createSchema.extend({ version: z.number().int().positive() });

const voidSchema = z.object({
  reason: z.string().min(1).max(2000),
  version: z.number().int().positive().optional(),
});

const listSchema = z.object({
  company_id: z.string().uuid().optional(),
  company: z.literal('stock_only').optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  done_by: z.string().uuid().optional(),
  status: z.enum(['active', 'void']).optional(),
  q: z.string().max(200).optional(),
  include_undone: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().positive().optional(),
  page_size: z.coerce.number().int().positive().max(100).optional(),
});

const historySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

/**
 * Purchases — "add material" (FR-401 to FR-408).
 *
 * There is no scope rule: a purchase belongs to the factory, and companies are visible to
 * everyone with `companies.view` (FR-711, 2.6.4). What a purchase does carry is cost, so the
 * prices on it are stripped for callers without `fields.see_bought_price` (2.6.2) — which is
 * why `purchases.create` implies that flag in the catalogue.
 */
@Controller()
@SensitiveFields({
  cost: 'fields.see_bought_price',
  // The same flag hides the prices inside History's field-level diff (spec 2.4.4, 2.6.2).
  unit_price: 'fields.see_bought_price',
  line_total: 'fields.see_bought_price',
  purchase_total: 'fields.see_bought_price',
})
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Get('purchases')
  @RequirePermission('purchases.view')
  async list(@Query(zodBody(listSchema)) query: z.infer<typeof listSchema>) {
    return this.purchases.list({ ...query, include_undone: query.include_undone === 'true' });
  }

  /** The company's Purchases tab; the same list, filtered to one supplier (FR-709). */
  @Get('companies/:id/purchases')
  @RequirePermission('purchases.view')
  async ofCompany(
    @Param('id') id: string,
    @Query(zodBody(listSchema.omit({ company_id: true, company: true })))
    query: Omit<z.infer<typeof listSchema>, 'company_id' | 'company'>,
  ) {
    return this.purchases.list({
      ...query,
      company_id: id,
      include_undone: query.include_undone === 'true',
    });
  }

  @Post('purchases')
  @RequirePermission('purchases.create')
  @HttpCode(201)
  async create(@Req() request: RequestWithContext, @Body(zodBody(createSchema)) body: z.infer<typeof createSchema>) {
    return this.purchases.create(contextOf(request), toCreateInput(body));
  }

  @Get('purchases/:id')
  @RequirePermission('purchases.view')
  async get(@Param('id') id: string) {
    return this.purchases.get(id);
  }

  /**
   * A full replace. The route asks only for `purchases.view` because FR-405 gives the right to
   * the **creator** as well as to holders of `purchases.edit`; the service applies that rule
   * with the purchase loaded, together with the linked-money and period checks of 2.5.3.
   */
  @Put('purchases/:id')
  @RequirePermission('purchases.view')
  async replace(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(replaceSchema)) body: z.infer<typeof replaceSchema>,
  ) {
    return this.purchases.replace(contextOf(request), id, { ...toCreateInput(body), version: body.version });
  }

  @Post('purchases/:id/void')
  @RequirePermission('purchases.void')
  @HttpCode(200)
  async void(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(voidSchema)) body: z.infer<typeof voidSchema>,
  ) {
    return this.purchases.void(contextOf(request), id, body);
  }

  /**
   * The 8-second undo of the save toast (FR-405): a void with reason "undo", hidden from lists
   * by default and available to the creator without `purchases.void` — the same shape as the
   * order undo (D-017).
   */
  @Post('purchases/:id/undo')
  @RequirePermission('purchases.create')
  @HttpCode(200)
  async undo(@Req() request: RequestWithContext, @Param('id') id: string) {
    return this.purchases.void(contextOf(request), id, { reason: 'undo', undo: true });
  }

  @Get('purchases/:id/history')
  @RequirePermission('purchases.view')
  async history(@Param('id') id: string, @Query(zodBody(historySchema)) query: z.infer<typeof historySchema>) {
    return this.purchases.historyOf(id, query);
  }

  /** "We owe for this purchase" (FR-712); null throughout for a stock-only purchase. */
  @Get('purchases/:id/balance')
  @RequirePermission('purchases.view', 'fields.see_company_balances')
  async balance(@Param('id') id: string) {
    return this.purchases.balanceOf(id);
  }
}

function toCreateInput(body: z.infer<typeof createSchema>) {
  return {
    company_id: body.company_id ?? null,
    purchase_date: body.purchase_date,
    notes: body.notes ?? null,
    rate_iqd_per_usd: body.rate_iqd_per_usd ?? null,
    discount: body.discount ?? null,
    lines: body.lines.map((line) => ({
      item_id: line.item_id,
      qty_count: line.qty_count ?? null,
      qty_kg: line.qty_kg ?? null,
      unit_price: line.unit_price ?? null,
      note: line.note ?? null,
    })),
    acting_user_id: body.acting_user_id ?? null,
  };
}

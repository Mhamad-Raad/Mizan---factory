import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../common/decorators.js';
import { contextOf } from '../common/request-context.js';
import type { RequestWithContext } from '../common/request-context.js';
import { SensitiveFields } from '../common/sensitive-field.interceptor.js';
import { zodBody } from '../common/zod.pipe.js';
import { CompaniesService } from './companies.service.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.object({
  amount: z.number().int(),
  currency: z.enum(['IQD', 'USD']),
  other_amount: z.number().int().nullish(),
});
const method = z.enum(['cash', 'transfer', 'other']);

const listSchema = z.object({
  q: z.string().max(200).optional(),
  assigned_to: z.string().uuid().optional(),
  include_inactive: z.enum(['true', 'false']).optional(),
  sort: z.enum(['name', 'balance']).optional(),
  page: z.coerce.number().int().positive().optional(),
  page_size: z.coerce.number().int().positive().max(100).optional(),
});

const paymentSchema = money.extend({
  purchase_id: z.string().uuid().nullish(),
  entry_date: isoDate,
  settle_in_full: z.boolean().optional(),
  performed_by: z.string().uuid().nullish(),
  method: method.nullish(),
  split: z.array(money).min(2).max(4).nullish(),
  note: z.string().max(2000).nullish(),
});

const entrySchema = money.extend({
  entry_date: isoDate,
  note: z.string().min(1).max(2000),
  purchase_id: z.string().uuid().nullish(),
  damage_id: z.string().uuid().nullish(),
  performed_by: z.string().uuid().nullish(),
});

const adjustmentSchema = z
  .object({
    new_balance: z.number().int().nullish(),
    delta: z.number().int().nullish(),
    currency: z.enum(['IQD', 'USD']),
    other_amount: z.number().int().nullish(),
    entry_date: isoDate,
    note: z.string().min(3).max(2000),
    purchase_id: z.string().uuid().nullish(),
  })
  // FR-706: either the new balance or the change, never both — they would contradict.
  .refine((body) => (body.new_balance ?? null) === null || (body.delta ?? null) === null, {
    message: 'send either new_balance or delta',
    path: ['delta'],
  });

const reverseSchema = z.object({
  note: z.string().min(1).max(2000),
  entry_date: isoDate.optional(),
});

const ledgerSchema = z.object({
  raw: z.enum(['true', 'false']).optional(),
  money_only: z.enum(['true', 'false']).optional(),
  include_undone: z.enum(['true', 'false']).optional(),
  as_of: isoDate.optional(),
  // The filters of 2.9.3, and the bound that keeps a fifteen-year account off a phone's plan.
  type: z
    .enum([
      'purchase',
      'payment',
      'credit',
      'adjustment',
      'opening',
      'settlement_change',
      'reversal',
    ])
    .optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  done_by: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const statementSchema = z.object({ from: isoDate.optional(), to: isoDate.optional() });
const historySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

/**
 * Companies and supplier accounting (FR-701 to FR-712).
 *
 * There is no scope rule: everyone with `companies.view` sees every company (FR-711). What is
 * withheld is *money* — `balance` and the per-purchase breakdown are stripped from every
 * response for a caller without `fields.see_company_balances` (FR-704, spec 2.6.2).
 */
@Controller()
@SensitiveFields({ balance: 'fields.see_company_balances' })
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Get('companies')
  @RequirePermission('companies.view')
  async list(
    @Req() request: RequestWithContext,
    @Query(zodBody(listSchema)) query: z.infer<typeof listSchema>,
  ) {
    return this.companies.list(contextOf(request), {
      q: query.q,
      assigned_to: query.assigned_to,
      include_inactive: query.include_inactive === 'true',
      sort: query.sort,
      page: query.page,
      page_size: query.page_size,
    });
  }

  @Get('companies/:id')
  @RequirePermission('companies.view')
  async get(@Param('id') id: string) {
    return this.companies.get(id);
  }

  @Get('companies/:id/ledger')
  @RequirePermission('companies.view', 'fields.see_company_balances')
  async ledger(
    @Param('id') id: string,
    @Query(zodBody(ledgerSchema)) query: z.infer<typeof ledgerSchema>,
  ) {
    return this.companies.ledgerOf(id, {
      raw: query.raw === 'true',
      money_only: query.money_only === 'true',
      include_undone: query.include_undone === 'true',
      as_of: query.as_of,
      type: query.type,
      from: query.from,
      to: query.to,
      done_by: query.done_by,
      limit: query.limit,
    });
  }

  /** "How much we owe per purchase" with the oldest-first allocation (FR-704, FR-712). */
  @Get('companies/:id/purchase-breakdown')
  @RequirePermission('companies.view', 'fields.see_company_balances')
  async breakdown(
    @Param('id') id: string,
    @Query(zodBody(z.object({ limit: z.coerce.number().int().positive().max(200).optional() })))
    query: { limit?: number },
  ) {
    return this.companies.purchaseBreakdown(id, query);
  }

  @Post('companies/:id/payments')
  @RequirePermission('companies.record_payment')
  @HttpCode(201)
  async payment(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(paymentSchema)) body: z.infer<typeof paymentSchema>,
  ) {
    return this.companies.recordPayment(contextOf(request), id, {
      ...body,
      purchase_id: body.purchase_id ?? null,
      performed_by: body.performed_by ?? null,
      method: body.method ?? null,
      split: body.split ?? null,
      note: body.note ?? null,
      other_amount: body.other_amount ?? null,
    });
  }

  @Post('companies/:id/adjustments')
  @RequirePermission('companies.adjust_owed')
  @HttpCode(201)
  async adjustment(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(adjustmentSchema)) body: z.infer<typeof adjustmentSchema>,
  ) {
    return this.companies.recordAdjustment(contextOf(request), id, {
      new_balance: body.new_balance ?? null,
      delta: body.delta ?? null,
      currency: body.currency,
      other_amount: body.other_amount ?? null,
      entry_date: body.entry_date,
      note: body.note,
      purchase_id: body.purchase_id ?? null,
    });
  }

  @Post('companies/:id/credits')
  @RequirePermission('companies.record_credit')
  @HttpCode(201)
  async credit(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(entrySchema)) body: z.infer<typeof entrySchema>,
  ) {
    return this.companies.recordEntry(contextOf(request), id, 'credit', toEntryInput(body));
  }

  @Post('companies/:id/opening-balance')
  @RequirePermission('companies.opening_balance')
  @HttpCode(201)
  async openingBalance(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(entrySchema)) body: z.infer<typeof entrySchema>,
  ) {
    return this.companies.recordEntry(contextOf(request), id, 'opening', toEntryInput(body));
  }

  @Post('companies/:id/ledger/:entryId/reverse')
  @RequirePermission('companies.record_payment')
  @HttpCode(201)
  async reverse(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Param('entryId') entryId: string,
    @Body(zodBody(reverseSchema)) body: z.infer<typeof reverseSchema>,
  ) {
    return this.companies.reverseEntry(contextOf(request), id, entryId, body);
  }

  /** Proposed — not requested (FR-614). */
  @Get('companies/:id/ledger/:entryId/voucher')
  @RequirePermission('companies.view', 'fields.see_company_balances')
  async voucher(@Param('id') id: string, @Param('entryId') entryId: string) {
    return this.companies.voucher(id, entryId);
  }

  /** Proposed — not requested (FR-615). */
  @Get('companies/:id/statement')
  @RequirePermission('companies.view', 'fields.see_company_balances')
  async statement(
    @Param('id') id: string,
    @Query(zodBody(statementSchema)) query: z.infer<typeof statementSchema>,
  ) {
    return this.companies.statement(id, query);
  }

  @Get('companies/:id/history')
  @RequirePermission('companies.view')
  async history(
    @Param('id') id: string,
    @Query(zodBody(historySchema)) query: z.infer<typeof historySchema>,
  ) {
    return this.companies.historyOf(id, query);
  }
}

function toEntryInput(body: z.infer<typeof entrySchema>) {
  return {
    amount: body.amount,
    currency: body.currency,
    other_amount: body.other_amount ?? null,
    entry_date: body.entry_date,
    note: body.note,
    purchase_id: body.purchase_id ?? null,
    damage_id: body.damage_id ?? null,
    performed_by: body.performed_by ?? null,
  };
}

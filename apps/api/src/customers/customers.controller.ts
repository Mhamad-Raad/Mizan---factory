import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { AdminOnly, RequirePermission } from '../common/decorators.js';
import { contextOf } from '../common/request-context.js';
import type { RequestWithContext } from '../common/request-context.js';
import { SensitiveFields } from '../common/sensitive-field.interceptor.js';
import { zodBody } from '../common/zod.pipe.js';
import { CustomersService } from './customers.service.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.object({
  amount: z.number().int(),
  currency: z.enum(['IQD', 'USD']),
  other_amount: z.number().int().nullish(),
});
const method = z.enum(['cash', 'transfer', 'other']);
const rate = z.string().regex(/^\d+(\.\d{1,4})?$/);
const rateSchema = z.object({
  rate_iqd_per_usd: z.union([rate, z.number().positive()]),
  note: z.string().max(2000).nullish(),
});

const listSchema = z.object({
  q: z.string().max(200).optional(),
  assigned_to: z.string().uuid().optional(),
  balance: z.enum(['owes', 'settled', 'credit']).optional(),
  include_inactive: z.enum(['true', 'false']).optional(),
  sort: z.enum(['name', 'balance']).optional(),
  page: z.coerce.number().int().positive().optional(),
  page_size: z.coerce.number().int().positive().max(100).optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().max(40).nullish(),
  address: z.string().max(500).nullish(),
  notes: z.string().max(2000).nullish(),
  settlement_currency: z.enum(['IQD', 'USD']).optional(),
  assigned_user_id: z.string().uuid().nullish(),
  credit_limit: money.nullish(),
});

const updateSchema = createSchema.partial().extend({ version: z.number().int().positive() });
const statusSchema = z.object({ version: z.number().int().positive(), note: z.string().max(2000).nullish() });
const assignSchema = z.object({
  user_id: z.string().uuid().nullable(),
  note: z.string().max(2000).nullish(),
  version: z.number().int().positive().optional(),
});

const currencySchema = z.object({
  currency: z.enum(['IQD', 'USD']),
  note: z.string().min(1).max(2000),
  rebase_rate: z.string().regex(/^\d+(\.\d{1,4})?$/).nullish(),
  version: z.number().int().positive().optional(),
});

const paymentSchema = money.extend({
  order_id: z.string().uuid().nullish(),
  entry_date: isoDate,
  settle_in_full: z.boolean().optional(),
  allow_excess: z.boolean().optional(),
  performed_by: z.string().uuid().nullish(),
  method: method.nullish(),
  split: z.array(money).min(2).max(4).nullish(),
  note: z.string().max(2000).nullish(),
});

const entrySchema = money.extend({
  entry_date: isoDate,
  note: z.string().min(1).max(2000),
  order_id: z.string().uuid().nullish(),
  damage_id: z.string().uuid().nullish(),
  performed_by: z.string().uuid().nullish(),
  method: method.nullish(),
});

const reverseSchema = z.object({ note: z.string().min(1).max(2000), entry_date: isoDate.optional() });

const ledgerSchema = z.object({
  raw: z.enum(['true', 'false']).optional(),
  money_only: z.enum(['true', 'false']).optional(),
  include_undone: z.enum(['true', 'false']).optional(),
  as_of: isoDate.optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const statementSchema = z.object({ from: isoDate.optional(), to: isoDate.optional() });
const historySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

/**
 * Customers, their balances and the money movements against them (FR-501 to FR-507, FR-606).
 *
 * Scope (spec 2.6.4) is applied in the repository from the request context, so these handlers
 * never have to remember it; `balance` is stripped from every response for a caller without
 * `fields.see_customer_balances` (FR-503).
 */
@Controller()
@SensitiveFields({ balance: 'fields.see_customer_balances' })
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get('customers')
  @RequirePermission('customers.view')
  async list(@Req() request: RequestWithContext, @Query(zodBody(listSchema)) query: z.infer<typeof listSchema>) {
    return this.customers.list(contextOf(request), {
      q: query.q,
      assigned_to: query.assigned_to,
      balance: query.balance,
      include_inactive: query.include_inactive === 'true',
      sort: query.sort,
      page: query.page,
      page_size: query.page_size,
    });
  }

  /**
   * The duplicate warning of FR-501, asked before the form is submitted. It runs over every
   * customer, so it sits behind `customers.create` rather than `customers.view_all`.
   */
  @Get('customers/duplicates')
  @RequirePermission('customers.create')
  async duplicates(@Query(zodBody(z.object({ name: z.string().min(1).max(200) }))) query: { name: string }) {
    return this.customers.checkDuplicates(query.name);
  }

  @Post('customers')
  @RequirePermission('customers.create')
  @HttpCode(201)
  async create(@Req() request: RequestWithContext, @Body(zodBody(createSchema)) body: z.infer<typeof createSchema>) {
    return this.customers.create(contextOf(request), {
      name: body.name,
      phone: body.phone ?? null,
      address: body.address ?? null,
      notes: body.notes ?? null,
      settlement_currency: body.settlement_currency,
      assigned_user_id: body.assigned_user_id ?? null,
      credit_limit: body.credit_limit ?? null,
    });
  }

  @Get('customers/:id')
  @RequirePermission('customers.view')
  async get(@Req() request: RequestWithContext, @Param('id') id: string) {
    return this.customers.get(contextOf(request), id);
  }

  @Patch('customers/:id')
  @RequirePermission('customers.edit')
  async update(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    return this.customers.update(contextOf(request), id, {
      ...body,
      phone: body.phone ?? undefined,
      address: body.address ?? undefined,
      notes: body.notes ?? undefined,
      credit_limit: body.credit_limit ?? undefined,
    });
  }

  @Post('customers/:id/deactivate')
  @RequirePermission('customers.edit')
  @HttpCode(200)
  async deactivate(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(statusSchema)) body: z.infer<typeof statusSchema>,
  ) {
    return this.customers.setActive(contextOf(request), id, false, body);
  }

  @Post('customers/:id/reactivate')
  @RequirePermission('customers.edit')
  @HttpCode(200)
  async reactivate(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(statusSchema)) body: z.infer<typeof statusSchema>,
  ) {
    return this.customers.setActive(contextOf(request), id, true, body);
  }

  @Delete('customers/:id')
  @AdminOnly()
  @HttpCode(204)
  async remove(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(z.object({ version: z.number().int().positive() }))) body: { version: number },
  ) {
    await this.customers.softDelete(contextOf(request), id, body.version);
  }

  @Put('customers/:id/assignment')
  @RequirePermission('customers.assign')
  async assign(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(assignSchema)) body: z.infer<typeof assignSchema>,
  ) {
    return this.customers.assign(contextOf(request), id, body);
  }

  @Put('customers/:id/settlement-currency')
  @AdminOnly()
  async setSettlementCurrency(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(currencySchema)) body: z.infer<typeof currencySchema>,
  ) {
    return this.customers.setSettlementCurrency(contextOf(request), id, {
      currency: body.currency,
      note: body.note,
      rebase_rate: body.rebase_rate ?? null,
      version: body.version,
    });
  }

  @Get('customers/:id/rates')
  @RequirePermission('customers.view')
  async rates(@Req() request: RequestWithContext, @Param('id') id: string) {
    return this.customers.rateHistoryOf(contextOf(request), id);
  }

  @Post('customers/:id/rates')
  @RequirePermission('customers.set_rate')
  @HttpCode(201)
  async setRate(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(rateSchema)) body: z.infer<typeof rateSchema>,
  ) {
    return this.customers.setRate(contextOf(request), id, {
      rate_iqd_per_usd: String(body.rate_iqd_per_usd),
      note: body.note ?? null,
    });
  }

  @Get('customers/:id/ledger')
  @RequirePermission('customers.view', 'fields.see_customer_balances')
  async ledger(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Query(zodBody(ledgerSchema)) query: z.infer<typeof ledgerSchema>,
  ) {
    return this.customers.ledgerOf(contextOf(request), id, {
      raw: query.raw === 'true',
      money_only: query.money_only === 'true',
      include_undone: query.include_undone === 'true',
      as_of: query.as_of,
      limit: query.limit,
    });
  }

  @Post('customers/:id/payments')
  @RequirePermission('orders.record_payment')
  @HttpCode(201)
  async payment(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(paymentSchema)) body: z.infer<typeof paymentSchema>,
  ) {
    return this.customers.recordPayment(contextOf(request), id, {
      ...body,
      order_id: body.order_id ?? null,
      performed_by: body.performed_by ?? null,
      method: body.method ?? null,
      split: body.split ?? null,
      note: body.note ?? null,
      other_amount: body.other_amount ?? null,
    });
  }

  @Post('customers/:id/credits')
  @RequirePermission('orders.credit')
  @HttpCode(201)
  async credit(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(entrySchema)) body: z.infer<typeof entrySchema>,
  ) {
    return this.customers.recordEntry(contextOf(request), id, 'credit', toEntryInput(body));
  }

  @Post('customers/:id/refunds')
  @RequirePermission('orders.credit')
  @HttpCode(201)
  async refund(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(entrySchema)) body: z.infer<typeof entrySchema>,
  ) {
    return this.customers.recordEntry(contextOf(request), id, 'refund', toEntryInput(body));
  }

  @Post('customers/:id/adjustments')
  @RequirePermission('orders.credit')
  @HttpCode(201)
  async adjustment(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(entrySchema)) body: z.infer<typeof entrySchema>,
  ) {
    return this.customers.recordEntry(contextOf(request), id, 'adjustment', toEntryInput(body));
  }

  @Post('customers/:id/opening-balance')
  @RequirePermission('customers.opening_balance')
  @HttpCode(201)
  async openingBalance(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(entrySchema)) body: z.infer<typeof entrySchema>,
  ) {
    return this.customers.recordEntry(contextOf(request), id, 'opening', toEntryInput(body));
  }

  @Post('customers/:id/ledger/:entryId/reverse')
  @RequirePermission('orders.record_payment')
  @HttpCode(201)
  async reverse(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Param('entryId') entryId: string,
    @Body(zodBody(reverseSchema)) body: z.infer<typeof reverseSchema>,
  ) {
    return this.customers.reverseEntry(contextOf(request), id, entryId, body);
  }

  /** Proposed — not requested (FR-614): the figures for one printed voucher. */
  @Get('customers/:id/ledger/:entryId/voucher')
  @RequirePermission('customers.view', 'fields.see_customer_balances')
  async voucher(@Req() request: RequestWithContext, @Param('id') id: string, @Param('entryId') entryId: string) {
    return this.customers.voucher(contextOf(request), id, entryId);
  }

  /** Proposed — not requested (FR-615): the figures for an account statement. */
  @Get('customers/:id/statement')
  @RequirePermission('customers.view', 'fields.see_customer_balances')
  async statement(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Query(zodBody(statementSchema)) query: z.infer<typeof statementSchema>,
  ) {
    return this.customers.statement(contextOf(request), id, query);
  }

  @Get('customers/:id/history')
  @RequirePermission('customers.view')
  async history(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Query(zodBody(historySchema)) query: z.infer<typeof historySchema>,
  ) {
    return this.customers.historyOf(contextOf(request), id, query);
  }
}

function toEntryInput(body: z.infer<typeof entrySchema>) {
  return {
    amount: body.amount,
    currency: body.currency,
    other_amount: body.other_amount ?? null,
    entry_date: body.entry_date,
    note: body.note,
    order_id: body.order_id ?? null,
    damage_id: body.damage_id ?? null,
    performed_by: body.performed_by ?? null,
    method: body.method ?? null,
  };
}

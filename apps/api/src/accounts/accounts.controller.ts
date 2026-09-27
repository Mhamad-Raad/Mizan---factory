import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { isoDate, minorAmount } from '../common/schemas.js';
import { RequirePermission } from '../common/decorators.js';
import { pageFields } from '../common/paging.js';
import { contextOf } from '../common/request-context.js';
import type { RequestWithContext } from '../common/request-context.js';
import { zodBody } from '../common/zod.pipe.js';
import { PeriodService } from '../settings/period.service.js';
import { AccountsService } from './accounts.service.js';
import { ExpensesService } from './expenses.service.js';


const periodSchema = z.object({ from: isoDate.optional(), to: isoDate.optional() });
const listSchema = periodSchema.extend({ q: z.string().max(200).optional(), ...pageFields });
const expenseListSchema = listSchema.extend({ include_void: z.enum(['true', 'false']).optional() });

const expenseSchema = z.object({
  expense_date: isoDate,
  title: z.string().min(1).max(200),
  amount: z.object({
    amount: minorAmount.positive(),
    currency: z.enum(['IQD', 'USD']),
    other_amount: minorAmount.positive().nullish(),
  }),
  note: z.string().max(2000).nullish(),
});

const voidSchema = z.object({ reason: z.string().min(1).max(2000), version: z.number().int().positive().optional() });

/**
 * The accountant page (client review, D-062). Its whole subject is money, so every route carries
 * `accounts.view`, which brings the bought-price and profit flags with it (catalog).
 *
 * The period defaults to the first of this month through today — the accountant's usual
 * question — and both ends can be moved.
 */
@Controller()
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly expenses: ExpensesService,
    private readonly period: PeriodService,
  ) {}

  private range(query: { from?: string; to?: string }): { from: string; to: string } {
    const today = this.period.today();
    return { from: query.from ?? `${today.slice(0, 7)}-01`, to: query.to ?? today };
  }

  @Get('accounts/summary')
  @RequirePermission('accounts.view')
  async summary(@Query(zodBody(periodSchema)) query: z.infer<typeof periodSchema>) {
    const { from, to } = this.range(query);
    return this.accounts.summary(from, to);
  }

  @Get('accounts/sales')
  @RequirePermission('accounts.view')
  async sales(@Query(zodBody(listSchema)) query: z.infer<typeof listSchema>) {
    return this.accounts.sales({ ...query, ...this.range(query) });
  }

  @Get('accounts/materials')
  @RequirePermission('accounts.view')
  async materials(@Query(zodBody(listSchema)) query: z.infer<typeof listSchema>) {
    return this.accounts.materials({ ...query, ...this.range(query) });
  }

  @Get('expenses')
  @RequirePermission('accounts.view')
  async listExpenses(@Query(zodBody(expenseListSchema)) query: z.infer<typeof expenseListSchema>) {
    return this.expenses.list({ ...query, ...this.range(query), include_void: query.include_void === 'true' });
  }

  @Post('expenses')
  @RequirePermission('expenses.create')
  @HttpCode(201)
  async createExpense(@Req() request: RequestWithContext, @Body(zodBody(expenseSchema)) body: z.infer<typeof expenseSchema>) {
    return this.expenses.create(contextOf(request), body);
  }

  @Post('expenses/:id/void')
  @RequirePermission('expenses.void')
  @HttpCode(200)
  async voidExpense(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(voidSchema)) body: z.infer<typeof voidSchema>,
  ) {
    return this.expenses.void(contextOf(request), id, body);
  }
}

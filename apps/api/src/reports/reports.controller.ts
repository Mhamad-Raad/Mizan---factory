import { Controller, Get, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../common/decorators.js';
import { contextOf } from '../common/request-context.js';
import type { RequestWithContext } from '../common/request-context.js';
import { SensitiveFields } from '../common/sensitive-field.interceptor.js';
import { zodBody } from '../common/zod.pipe.js';
import { ReportsService } from './reports.service.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const baseSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  done_by: z.string().uuid().optional(),
  assigned_to: z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  item_id: z.string().uuid().optional(),
});

const salesSchema = baseSchema.extend({
  group_by: z.enum(['month', 'day', 'customer', 'item', 'employee', 'assigned']).optional(),
});
const purchasesSchema = baseSchema.extend({
  group_by: z.enum(['month', 'day', 'company', 'item', 'employee']).optional(),
});
const profitSchema = baseSchema.extend({
  group_by: z.enum(['month', 'day', 'customer', 'item', 'employee']).optional(),
});
const damageSchema = baseSchema.extend({
  group_by: z.enum(['month', 'day', 'item', 'attribution', 'return_status']).optional(),
});

/**
 * The reports (FR-1001 to FR-1013, spec 2.11).
 *
 * Every route carries `reports.view`, and those whose whole subject is money carry the field
 * flag as a second key rather than answering with the amounts stripped out — a Profit report
 * without margins, or a Receivables report without balances, is not a report (D-023). Where
 * the money is one column of several — a purchase's totals, a stock value, a damage value — the
 * amounts travel under `cost` and the interceptor removes that group, so the quantities, dates
 * and counts still arrive (D-022).
 */
@Controller('reports')
@SensitiveFields({ cost: 'fields.see_bought_price' })
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('sales')
  @RequirePermission('reports.view')
  async sales(@Req() request: RequestWithContext, @Query(zodBody(salesSchema)) query: z.infer<typeof salesSchema>) {
    return this.reports.sales(contextOf(request), query);
  }

  @Get('purchases')
  @RequirePermission('reports.view')
  async purchases(
    @Req() request: RequestWithContext,
    @Query(zodBody(purchasesSchema)) query: z.infer<typeof purchasesSchema>,
  ) {
    return this.reports.purchases(contextOf(request), query);
  }

  /** The margin report is the profit flag's whole reason to exist (FR-1005). */
  @Get('profit')
  @RequirePermission('reports.view', 'fields.see_profit')
  async profit(@Req() request: RequestWithContext, @Query(zodBody(profitSchema)) query: z.infer<typeof profitSchema>) {
    return this.reports.profit(contextOf(request), query);
  }

  @Get('stock')
  @RequirePermission('reports.view')
  async stock(@Req() request: RequestWithContext, @Query(zodBody(baseSchema)) query: z.infer<typeof baseSchema>) {
    return this.reports.stock(contextOf(request), query);
  }

  @Get('receivables')
  @RequirePermission('reports.view', 'fields.see_customer_balances')
  async receivables(
    @Req() request: RequestWithContext,
    @Query(zodBody(baseSchema)) query: z.infer<typeof baseSchema>,
  ) {
    return this.reports.receivables(contextOf(request), query);
  }

  @Get('payables')
  @RequirePermission('reports.view', 'fields.see_company_balances')
  async payables(@Req() request: RequestWithContext, @Query(zodBody(baseSchema)) query: z.infer<typeof baseSchema>) {
    return this.reports.payables(contextOf(request), query);
  }

  @Get('damage')
  @RequirePermission('reports.view')
  async damage(@Req() request: RequestWithContext, @Query(zodBody(damageSchema)) query: z.infer<typeof damageSchema>) {
    return this.reports.damage(contextOf(request), query);
  }

  @Get('employee-activity')
  @RequirePermission('reports.view')
  async employeeActivity(
    @Req() request: RequestWithContext,
    @Query(zodBody(baseSchema)) query: z.infer<typeof baseSchema>,
  ) {
    return this.reports.employeeActivity(contextOf(request), query);
  }

  /**
   * The daily cash-up (FR-1013, **Proposed — not requested**): what each employee should hand
   * over, per physical currency. Every figure comes from the entered-currency column of the
   * ledgers, never from a conversion.
   */
  @Get('cash-up')
  @RequirePermission('reports.view')
  async cashUp(@Req() request: RequestWithContext, @Query(zodBody(baseSchema)) query: z.infer<typeof baseSchema>) {
    return this.reports.cashUp(contextOf(request), query);
  }
}

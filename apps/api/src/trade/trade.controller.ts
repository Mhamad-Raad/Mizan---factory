import { Controller, Get, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { isoDate } from '../common/schemas.js';
import { RequireAnyPermission } from '../common/decorators.js';
import { contextOf } from '../common/request-context.js';
import type { RequestWithContext } from '../common/request-context.js';
import { SensitiveFields } from '../common/sensitive-field.interceptor.js';
import { zodBody } from '../common/zod.pipe.js';
import { pageFields } from '../common/paging.js';
import { TradeService } from './trade.service.js';

const listSchema = z.object({
  kind: z.enum(['sale', 'purchase']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().max(200).optional(),
  company_id: z.string().uuid().optional(),
  driver_id: z.string().uuid().optional(),
  done_by: z.string().uuid().optional(),
  status: z.enum(['unpaid', 'partially_paid', 'paid', 'owing', 'void']).optional(),
  payment_type: z.enum(['cash', 'borrowed']).optional(),
  totals: z.enum(['true', 'false']).optional(),
  ...pageFields,
});

/**
 * Buying & selling (D-089): sales and purchases on one list, for whoever may see either side —
 * the guard refuses a reader with neither, and the service shows each reader the sides they may.
 * The fields of both lists are stripped as their own routes strip them.
 */
@Controller()
@SensitiveFields({
  // A purchase's prices and totals, and an order's cost snapshot: the bought-price flag's.
  cost: 'fields.see_bought_price',
  // What each purchase still owes, and what we owe the companies: the company-balances flag's.
  payment: 'fields.see_company_balances',
  owed_by_us: 'fields.see_company_balances',
  // What the companies owe us: the customer-balances flag's.
  owed_to_us: 'fields.see_customer_balances',
  balance: 'fields.see_customer_balances',
})
export class TradeController {
  constructor(private readonly trade: TradeService) {}

  @Get('trade')
  @RequireAnyPermission('orders.view', 'purchases.view')
  async list(@Req() request: RequestWithContext, @Query(zodBody(listSchema)) query: z.infer<typeof listSchema>) {
    return this.trade.list(contextOf(request), { ...query, totals: query.totals !== 'false' });
  }
}

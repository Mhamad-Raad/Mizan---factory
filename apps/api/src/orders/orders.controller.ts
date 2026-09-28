import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { isoDate, minorAmount, rateString } from '../common/schemas.js';
import { RequirePermission } from '../common/decorators.js';
import { contextOf } from '../common/request-context.js';
import type { RequestWithContext } from '../common/request-context.js';
import { stripHistory } from '../history/history-fields.js';
import { SensitiveFields } from '../common/sensitive-field.interceptor.js';
import { zodBody } from '../common/zod.pipe.js';
import { OrdersService } from './orders.service.js';
import { cursorField, limitField, pageFields } from '../common/paging.js';

const kg = z.string().regex(/^\d{1,9}(\.\d{1,3})?$/);
const money = z.object({
  amount: minorAmount,
  currency: z.enum(['IQD', 'USD']),
  other_amount: minorAmount.nullish(),
});
/**
 * A price, a line total or a discount: never below zero. Refused here with the field named,
 * rather than by the table's CHECK as a 500 (security review, finding 16).
 */
const price = z.object({
  amount: minorAmount.nonnegative(),
  currency: z.enum(['IQD', 'USD']),
  other_amount: minorAmount.nonnegative().nullish(),
});

const lineSchema = z.object({
  item_id: z.string().uuid(),
  qty_count: z.number().int().positive().nullish(),
  qty_kg: kg.nullish(),
  unit_price: price.nullish(),
  note: z.string().max(500).nullish(),
});

const createSchema = z.object({
  customer_id: z.string().uuid(),
  order_date: isoDate,
  payment_type: z.enum(['cash', 'borrowed']),
  received_currency: z.enum(['IQD', 'USD']).nullish(),
  received_amount: z.number().int().positive().nullish(),
  notes: z.string().max(2000).nullish(),
  rate_iqd_per_usd: rateString.nullish(),
  discount: price.nullish(),
  lines: z.array(lineSchema).min(1).max(200),
  acting_user_id: z.string().uuid().nullish(),
});

const replaceSchema = createSchema.extend({ version: z.number().int().positive() });

const voidSchema = z.object({
  reason: z.string().min(1).max(2000),
  version: z.number().int().positive().optional(),
});

const paymentTypeSchema = z.object({
  to: z.enum(['cash', 'borrowed']),
  note: z.string().min(1).max(2000),
  entry_date: isoDate.optional(),
  received_currency: z.enum(['IQD', 'USD']).nullish(),
  received_amount: z.number().int().positive().nullish(),
});

const paymentSchema = money.extend({
  entry_date: isoDate,
  settle_in_full: z.boolean().optional(),
  allow_excess: z.boolean().optional(),
  performed_by: z.string().uuid().nullish(),
  method: z.enum(['cash', 'transfer', 'other']).nullish(),
  split: z.array(money).min(2).max(4).nullish(),
  note: z.string().max(2000).nullish(),
});

const listSchema = z.object({
  customer_id: z.string().uuid().optional(),
  item_id: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  done_by: z.string().uuid().optional(),
  payment_type: z.enum(['cash', 'borrowed']).optional(),
  status: z.enum(['unpaid', 'partially_paid', 'paid', 'void', 'owing']).optional(),
  q: z.string().max(200).optional(),
  include_undone: z.enum(['true', 'false']).optional(),
  /** `false` leaves out the figures over the whole filter (the dashboard's latest orders, D-075). */
  totals: z.enum(['true', 'false']).optional(),
  ...pageFields,
});

const historySchema = z.object({
  cursor: cursorField,
  limit: limitField,
});

/**
 * Orders (FR-601 to FR-613). Every order is visible to whoever may see orders (D-056), and
 * the cost snapshot on each line — a bought price — is stripped for callers without
 * `fields.see_bought_price` (FR-602, spec 2.6.2).
 */
@Controller()
@SensitiveFields({
  cost: 'fields.see_bought_price',
  // A payment's balance before and after, and the credit-limit warning's balance (review).
  balance_before: 'fields.see_customer_balances',
  balance_after: 'fields.see_customer_balances',
})
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get('orders')
  @RequirePermission('orders.view')
  // The totals' "still owed" is what customers owe: the balances flag keeps it (2.6.2).
  @SensitiveFields({
    cost: 'fields.see_bought_price',
    balance: 'fields.see_customer_balances',
    balance_before: 'fields.see_customer_balances',
    balance_after: 'fields.see_customer_balances',
  })
  async list(@Req() request: RequestWithContext, @Query(zodBody(listSchema)) query: z.infer<typeof listSchema>) {
    return this.orders.list(contextOf(request), {
      ...query,
      include_undone: query.include_undone === 'true',
      totals: query.totals !== 'false',
    });
  }

  /** The account's Orders tab; the same list, filtered to one account (FR-503). */
  @Get('customers/:id/orders')
  @RequirePermission('orders.view')
  // The same list, so the same rule: what the company still owes stays with the balances flag.
  @SensitiveFields({
    cost: 'fields.see_bought_price',
    balance: 'fields.see_customer_balances',
    balance_before: 'fields.see_customer_balances',
    balance_after: 'fields.see_customer_balances',
  })
  async ofCustomer(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Query(zodBody(listSchema.omit({ customer_id: true }))) query: Omit<z.infer<typeof listSchema>, 'customer_id'>,
  ) {
    return this.orders.list(contextOf(request), {
      ...query,
      customer_id: id,
      include_undone: query.include_undone === 'true',
      totals: query.totals !== 'false',
    });
  }

  @Post('orders')
  @RequirePermission('orders.create')
  @HttpCode(201)
  async create(@Req() request: RequestWithContext, @Body(zodBody(createSchema)) body: z.infer<typeof createSchema>) {
    return this.orders.create(contextOf(request), toCreateInput(body));
  }

  @Get('orders/:id')
  @RequirePermission('orders.view')
  async get(@Req() request: RequestWithContext, @Param('id') id: string) {
    return this.orders.get(contextOf(request), id);
  }

  /**
   * A full replace. The route asks only for `orders.view` because FR-610 gives the right to
   * the **creator** as well as to holders of `orders.edit`; the service applies that rule with
   * the order loaded, together with the payment and period checks of 2.5.3.
   */
  @Put('orders/:id')
  @RequirePermission('orders.view')
  async replace(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(replaceSchema)) body: z.infer<typeof replaceSchema>,
  ) {
    return this.orders.replace(contextOf(request), id, { ...toCreateInput(body), version: body.version });
  }

  @Post('orders/:id/void')
  @RequirePermission('orders.void')
  @HttpCode(200)
  async void(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(voidSchema)) body: z.infer<typeof voidSchema>,
  ) {
    return this.orders.void(contextOf(request), id, body);
  }

  /**
   * The 8-second undo of the save toast (FR-610): a void with reason "undo", hidden from lists
   * by default, available to the creator without `orders.void` — which is why it is its own
   * route rather than a flag on the void (D-017).
   */
  @Post('orders/:id/undo')
  @RequirePermission('orders.create')
  @HttpCode(200)
  async undo(@Req() request: RequestWithContext, @Param('id') id: string) {
    return this.orders.void(contextOf(request), id, { reason: 'undo', undo: true });
  }

  @Post('orders/:id/payment-type')
  @RequirePermission('orders.change_payment_type')
  @HttpCode(200)
  async changePaymentType(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(paymentTypeSchema)) body: z.infer<typeof paymentTypeSchema>,
  ) {
    return this.orders.changePaymentType(contextOf(request), id, {
      to: body.to,
      note: body.note,
      entry_date: body.entry_date,
      received_currency: body.received_currency ?? null,
      received_amount: body.received_amount ?? null,
    });
  }

  @Post('orders/:id/payments')
  @RequirePermission('orders.record_payment')
  @HttpCode(201)
  async payment(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(paymentSchema)) body: z.infer<typeof paymentSchema>,
  ) {
    return this.orders.recordPayment(contextOf(request), id, {
      amount: body.amount,
      currency: body.currency,
      other_amount: body.other_amount ?? null,
      entry_date: body.entry_date,
      settle_in_full: body.settle_in_full,
      allow_excess: body.allow_excess,
      performed_by: body.performed_by ?? null,
      method: body.method ?? null,
      split: body.split ?? null,
      note: body.note ?? null,
    });
  }

  @Get('orders/:id/history')
  @RequirePermission('orders.view')
  // A payment's History row carries the customer's balance before and after it (2.6.2).
  @SensitiveFields({
    cost: 'fields.see_bought_price',
    balance: 'fields.see_customer_balances',
    balance_before: 'fields.see_customer_balances',
    balance_after: 'fields.see_customer_balances',
  })
  async history(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Query(zodBody(historySchema)) query: z.infer<typeof historySchema>,
  ) {
    const context = contextOf(request);
    const page = await this.orders.historyOf(context, id, query);
    // The damages reported from the order and other rows naming it follow their own kind's
    // rules; the payments against the order itself stay, as the order shows them anyway.
    return { ...page, items: stripHistory(context, page.items, { ownOrderId: id }) };
  }

  /** Proposed — not requested (FR-613): the figures the client renders as a receipt. */
  @Get('orders/:id/receipt')
  @RequirePermission('orders.view')
  async receipt(@Req() request: RequestWithContext, @Param('id') id: string) {
    return this.orders.receipt(contextOf(request), id);
  }
}

function toCreateInput(body: z.infer<typeof createSchema>) {
  return {
    customer_id: body.customer_id,
    order_date: body.order_date,
    payment_type: body.payment_type,
    received_currency: body.received_currency ?? null,
    received_amount: body.received_amount ?? null,
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

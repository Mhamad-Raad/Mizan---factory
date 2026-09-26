import { Injectable } from '@nestjs/common';
import {
  Decimal,
  completePair,
  computeLineTotals,
  convert,
  costSnapshotOf,
  defaultLinePrice,
  documentTotals,
  firstOfMonth,
  formatRate,
  impliedRate,
  selectMonthPrice,
  withinTolerance,
} from '@mizan/money';
import type { Currency, Measure, MoneyPair, Rate, RateSource } from '@mizan/money';
import { orderStatus } from '@mizan/ledger';
import type { LedgerEntry } from '@mizan/ledger';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/errors.js';
import { can } from '../common/request-context.js';
import type { RequestContext } from '../common/request-context.js';
import { CustomersRepository } from '../customers/customers.repository.js';
import type { CustomerRow } from '../customers/customer.types.js';
import { CustomersService } from '../customers/customers.service.js';
import type { PaymentInput, WriteResultDto } from '../customers/customers.service.js';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';
import { HistoryRepository } from '../history/history.repository.js';
import { ItemsRepository } from '../items/items.repository.js';
import { CustomerLedgerService, ORDER_DOCUMENT_TYPES } from '../ledger/customer-ledger.service.js';
import type { LedgerCustomer } from '../ledger/customer-ledger.service.js';
import { RatesService } from '../rates/rates.service.js';
import { PeriodService } from '../settings/period.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { StockService } from '../stock/stock.service.js';
import { OrdersRepository } from './orders.repository.js';
import type { NewOrderLine, OrderFilters, OrderListRow, OrderScope } from './orders.repository.js';
import type { OrderDto, OrderLineDto, OrderLineRow, PaymentType } from './order.types.js';

/** How long the creator may undo an order from the save toast (FR-610). */
const UNDO_WINDOW_MS = 8_000;

export interface LineInput {
  item_id: string;
  qty_count?: number | null;
  qty_kg?: string | null;
  /** Omitted: the month price applies. Given: an override, logged and marked (FR-609). */
  unit_price?: { amount: number; currency: Currency; other_amount?: number | null } | null;
  note?: string | null;
}

export interface CreateOrderInput {
  customer_id: string;
  order_date: string;
  payment_type: PaymentType;
  /** Required for a cash order: the currency the customer physically handed over (FR-604). */
  received_currency?: Currency | null;
  /** What was handed over, when it differs from the exact total (a rounded note, say). */
  received_amount?: number | null;
  notes?: string | null;
  /** "Rate for this order" (2.3.3); the global rate when absent. */
  rate_iqd_per_usd?: string | null;
  /** Proposed — not requested (FR-616). */
  discount?: { amount: number; currency: Currency; other_amount?: number | null } | null;
  lines: LineInput[];
  acting_user_id?: string | null;
}

interface PreparedLine extends NewOrderLine {
  item_name: string;
  price_from_month: string | null;
}

/**
 * Orders: the factory's daily activity (FR-601 to FR-612).
 *
 * Saving an order writes the order, its lines with their cost snapshots, one stock movement
 * per line and the customer's ledger entry (plus its cash settlement) in **one** transaction.
 * An edit reverses everything live and writes the new version; a void reverses the document
 * entries and leaves payments standing as credit. Nothing is ever recomputed from a later
 * rate, and no total is ever a conversion of the other total.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly database: Database,
    private readonly orders: OrdersRepository,
    private readonly items: ItemsRepository,
    private readonly customers: CustomersRepository,
    private readonly customersService: CustomersService,
    private readonly ledger: CustomerLedgerService,
    private readonly stock: StockService,
    private readonly rates: RatesService,
    private readonly period: PeriodService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly history: HistoryRepository,
  ) {}

  scopeOf(context: RequestContext): OrderScope {
    return { userId: context.userId, viewAll: can(context, 'customers.view_all') };
  }

  async list(
    context: RequestContext,
    filters: OrderFilters,
  ): Promise<{ items: OrderDto[]; total: number }> {
    const { rows, total } = await this.orders.list(filters, this.scopeOf(context));
    return { items: rows.map((row) => toOrderDto(row, [])), total };
  }

  async get(context: RequestContext, id: string): Promise<OrderDto> {
    const row = await this.requireOrder(context, id);
    const lines = await this.orders.linesOf(id);
    return toOrderDto(row, lines);
  }

  private async requireOrder(context: RequestContext, id: string): Promise<OrderListRow> {
    const row = await this.orders.findById(id, this.scopeOf(context));
    // Out of scope answers 404, not 403: a refusal would confirm the order exists (2.6.4).
    if (!row) throw ApiError.notFound();
    return row;
  }

  async create(context: RequestContext, input: CreateOrderInput): Promise<OrderDto> {
    this.period.assertNotFuture(input.order_date, 'order_date');
    if (input.lines.length === 0) {
      throw ApiError.validation([
        {
          path: 'lines',
          code: 'REQUIRED',
          message_key: 'errors:field.required',
          params: { field: 'lines' },
        },
      ]);
    }

    const customer = await this.customers.findById(
      input.customer_id,
      this.customersService.scopeOf(context),
    );
    if (!customer) throw ApiError.notFound();
    // A business we only buy from is not somebody an order can be written to (D-054).
    if (!customer.is_customer) {
      throw ApiError.validation([
        { path: 'customer_id', code: 'NOT_A_CUSTOMER', message_key: 'errors:not_a_customer', params: {} },
      ]);
    }
    if (!customer.is_active) {
      throw ApiError.validation([
        {
          path: 'customer_id',
          code: 'INACTIVE',
          message_key: 'errors:customer_inactive',
          params: {},
        },
      ]);
    }
    // The walk-in customer is a till, not a debtor: it takes cash orders only (FR-501, A-33).
    if (customer.is_system && input.payment_type === 'borrowed') {
      throw ApiError.validation([
        {
          path: 'payment_type',
          code: 'SYSTEM_CUSTOMER_CASH_ONLY',
          message_key: 'errors:walk_in_cash_only',
          params: {},
        },
      ]);
    }
    if (input.payment_type === 'cash' && !input.received_currency) {
      throw ApiError.validation([
        {
          path: 'received_currency',
          code: 'REQUIRED',
          message_key: 'errors:field.required',
          params: { field: 'received_currency' },
        },
      ]);
    }

    const { rate, rateSource } = await this.rateFor(input.rate_iqd_per_usd, customer.id);
    const actingUserId = await this.actingUser(context, input.acting_user_id);

    const created = await this.database.transaction(async (tx) => {
      const locked = await this.ledger.lockOwner(tx, customer.id);
      if (!locked) throw ApiError.notFound();

      const lines = await this.prepareLines(tx, input.lines, input.order_date, rate, rateSource);
      const discount = this.discountPair(input.discount, rate, rateSource, lines);
      const totals = documentTotals(lines, {
        discount_iqd: discount.amount_iqd,
        discount_usd_cents: discount.amount_usd_cents,
      });

      const warnings = await this.stock.assertSellable(
        tx,
        lines.map((line) => ({
          item_id: line.item_id,
          item_name: line.item_name,
          priced_measure: line.priced_measure,
          quantity: pricedQuantityOf(line),
        })),
      );

      const order = await this.orders.createOrder(
        {
          customer_id: customer.id,
          order_date: input.order_date,
          acting_user_id: actingUserId,
          payment_type: input.payment_type,
          notes: input.notes?.trim() || null,
          rate_iqd_per_usd: rate,
          rate_source: rateSource,
          discount_iqd: discount.amount_iqd,
          discount_usd_cents: discount.amount_usd_cents,
          created_by: context.userId,
        },
        tx,
      );
      await this.orders.updateOrder(
        order.id,
        order.version,
        { total_iqd: totals.total_iqd, total_usd_cents: totals.total_usd_cents },
        context.userId,
        tx,
      );

      const insertedLines = await this.orders.insertLines(order.id, lines, context.userId, tx);
      await this.writeSaleMovements(tx, context, order.id, input.order_date, insertedLines, lines);

      const creditWarning = await this.writeDocumentEntries(context, tx, locked, {
        orderId: order.id,
        orderDate: input.order_date,
        paymentType: input.payment_type,
        totals,
        rate,
        rateSource,
        receivedCurrency: input.received_currency ?? null,
        receivedAmount: input.received_amount ?? null,
        customer,
      });

      await this.audit.record(
        context,
        {
          action: 'create',
          entity_type: 'order',
          entity_id: order.id,
          entity_label: `Order #${order.number}`,
          changes: {
            customer_id: { old: null, new: customer.id },
            order_date: { old: null, new: input.order_date },
            payment_type: { old: null, new: input.payment_type },
            rate_iqd_per_usd: { old: null, new: rate },
            lines: { old: null, new: lines.map(lineSummary) },
            total: {
              old: null,
              new: { iqd: totals.total_iqd, usd_cents: totals.total_usd_cents },
            },
          },
          note: input.notes?.trim() || null,
          related: {
            order_id: order.id,
            customer_id: customer.id,
            assigned_user_id: customer.assigned_user_id,
          },
        },
        tx,
      );

      return { id: order.id, warnings, creditWarning };
    });

    const dto = await this.get(context, created.id);
    return {
      ...dto,
      stock_warnings: created.warnings,
      credit_limit_warning: created.creditWarning,
    };
  }

  /**
   * A full replace within the rules of FR-610 and 2.5.3: reverse every live movement and
   * document entry, write the new version, and log a field-by-field diff. A line whose item
   * and month are unchanged keeps its cost snapshot, so the Profit report of a corrected order
   * still reads the cost that was true when it was sold (A-42).
   */
  async replace(
    context: RequestContext,
    id: string,
    input: CreateOrderInput & { version: number },
  ): Promise<OrderDto> {
    this.period.assertNotFuture(input.order_date, 'order_date');

    const existing = await this.requireOrder(context, id);
    if (existing.status === 'void') throw new ApiError('DOCUMENT_VOID', { order_id: id });
    await this.assertMayEdit(context, existing);

    const { rate, rateSource } = await this.rateFor(input.rate_iqd_per_usd, existing.customer_id);
    const actingUserId = await this.actingUser(
      context,
      input.acting_user_id ?? existing.acting_user_id,
    );

    await this.database.transaction(async (tx) => {
      const order = await this.orders.lock(id, tx);
      if (!order) throw ApiError.notFound();
      if (order.version !== input.version) throw await this.versionConflict(context, id);

      // An edit is a full replace of the *same* order: moving it to another customer would
      // move a debt between two balances, which is a void and a new order, not an edit.
      if (input.customer_id !== order.customer_id) {
        throw ApiError.validation([
          {
            path: 'customer_id',
            code: 'IMMUTABLE',
            message_key: 'errors:order_customer_immutable',
            params: {},
          },
        ]);
      }

      const customerRow = await this.customers.findByIdUnscoped(order.customer_id, tx);
      if (!customerRow) throw ApiError.notFound();
      const locked = await this.ledger.lockOwner(tx, order.customer_id);
      if (!locked) throw ApiError.notFound();

      const oldLines = await this.orders.linesOf(id, tx);
      const oldMonth = firstOfMonth(order.order_date);
      const newMonth = firstOfMonth(input.order_date);

      // Step 2 of 2.5.3: reverse everything live that belongs to this document.
      await this.stock.reverseLiveForRef(
        tx,
        { ref_type: 'order_line', ref_ids: oldLines.map((line) => line.id) },
        { created_by: context.userId, note: 'order edited', entry_date: input.order_date },
      );
      await this.ledger.reverseLiveForDocument(context, tx, locked, id, {
        note: 'order edited',
        entry_date: input.order_date,
        types: ORDER_DOCUMENT_TYPES,
        related: { order_id: id, customer_id: order.customer_id },
      });

      const lines = await this.prepareLines(tx, input.lines, input.order_date, rate, rateSource, {
        previous: oldLines,
        monthUnchanged: oldMonth === newMonth,
      });
      const discount = this.discountPair(input.discount, rate, rateSource, lines);
      const totals = documentTotals(lines, {
        discount_iqd: discount.amount_iqd,
        discount_usd_cents: discount.amount_usd_cents,
      });

      await this.stock.assertSellable(
        tx,
        lines.map((line) => ({
          item_id: line.item_id,
          item_name: line.item_name,
          priced_measure: line.priced_measure,
          quantity: pricedQuantityOf(line),
        })),
      );

      await this.orders.softDeleteLines(id, tx);
      const insertedLines = await this.orders.insertLines(id, lines, context.userId, tx);
      await this.writeSaleMovements(tx, context, id, input.order_date, insertedLines, lines);

      const updated = await this.orders.updateOrder(
        id,
        input.version,
        {
          order_date: input.order_date,
          payment_type: input.payment_type,
          notes: input.notes?.trim() || null,
          rate_iqd_per_usd: rate,
          rate_source: rateSource,
          discount_iqd: discount.amount_iqd,
          discount_usd_cents: discount.amount_usd_cents,
          total_iqd: totals.total_iqd,
          total_usd_cents: totals.total_usd_cents,
          acting_user_id: actingUserId,
        },
        context.userId,
        tx,
      );
      if (!updated) throw await this.versionConflict(context, id);

      await this.writeDocumentEntries(context, tx, locked, {
        orderId: id,
        orderDate: input.order_date,
        paymentType: input.payment_type,
        totals,
        rate,
        rateSource,
        receivedCurrency: input.received_currency ?? null,
        receivedAmount: input.received_amount ?? null,
        customer: customerRow,
      });

      await this.audit.record(
        context,
        {
          action: 'update',
          entity_type: 'order',
          entity_id: id,
          entity_label: `Order #${order.number}`,
          changes: {
            order_date: { old: order.order_date, new: input.order_date },
            payment_type: { old: order.payment_type, new: input.payment_type },
            rate_iqd_per_usd: { old: order.rate_iqd_per_usd, new: rate },
            lines: { old: oldLines.map(storedLineSummary), new: lines.map(lineSummary) },
            total: {
              old: { iqd: Number(order.total_iqd), usd_cents: Number(order.total_usd_cents) },
              new: { iqd: totals.total_iqd, usd_cents: totals.total_usd_cents },
            },
          },
          note: input.notes?.trim() || null,
          related: { order_id: id, customer_id: order.customer_id },
        },
        tx,
      );
    });

    return this.get(context, id);
  }

  /**
   * Void (FR-610): the document entries and every live movement are reversed, the order is
   * marked void with its reason, and payments already received **stay** in the ledger as
   * credit — the money did arrive, and the screen offers "Record refund" instead of pretending
   * otherwise.
   */
  async void(
    context: RequestContext,
    id: string,
    input: { reason: string; version?: number; undo?: boolean },
  ): Promise<OrderDto> {
    const existing = await this.requireOrder(context, id);
    if (existing.status === 'void') throw new ApiError('DOCUMENT_VOID', { order_id: id });

    if (input.undo) {
      // The 8-second undo of FR-610: the creator's own order, straight after saving it, and
      // no `orders.void` key needed — it is the toast action, not an accounting decision.
      const age = Date.now() - existing.created_at.getTime();
      if (existing.created_by !== context.userId || age > UNDO_WINDOW_MS) {
        throw ApiError.permissionDenied('orders.void');
      }
    } else if (!can(context, 'orders.void')) {
      throw ApiError.permissionDenied('orders.void');
    }

    await this.database.transaction(async (tx) => {
      const order = await this.orders.lock(id, tx);
      if (!order) throw ApiError.notFound();
      if (order.status === 'void') throw new ApiError('DOCUMENT_VOID', { order_id: id });

      const locked = await this.ledger.lockOwner(tx, order.customer_id);
      if (!locked) throw ApiError.notFound();

      const lines = await this.orders.linesOf(id, tx);
      await this.stock.reverseLiveForRef(
        tx,
        { ref_type: 'order_line', ref_ids: lines.map((line) => line.id) },
        { created_by: context.userId, note: input.reason, entry_date: order.order_date },
      );
      await this.ledger.reverseLiveForDocument(context, tx, locked, id, {
        note: input.reason,
        entry_date: order.order_date,
        types: ORDER_DOCUMENT_TYPES,
        related: { order_id: id, customer_id: order.customer_id },
      });

      const updated = await this.orders.updateOrder(
        id,
        input.version ?? order.version,
        {
          status: 'void',
          void_reason: input.reason,
          voided_by: context.userId,
          voided_at: new Date(),
        },
        context.userId,
        tx,
      );
      if (!updated) throw await this.versionConflict(context, id);

      await this.audit.record(
        context,
        {
          action: 'void',
          entity_type: 'order',
          entity_id: id,
          entity_label: `Order #${order.number}`,
          changes: { status: { old: 'active', new: 'void' } },
          note: input.reason,
          related: { order_id: id, customer_id: order.customer_id },
        },
        tx,
      );
    });

    return this.get(context, id);
  }

  /**
   * Switching an order between cash and borrowed (FR-605). Borrowed → cash settles what is
   * still owed, dated today, in the currency the customer actually handed over; cash →
   * borrowed reverses the settlement so the order is owed again. Both need a note, and both
   * land in the order's payment-type history.
   */
  async changePaymentType(
    context: RequestContext,
    id: string,
    input: {
      to: PaymentType;
      note: string;
      entry_date?: string;
      received_currency?: Currency | null;
      received_amount?: number | null;
    },
  ): Promise<OrderDto> {
    const existing = await this.requireOrder(context, id);
    if (existing.status === 'void') throw new ApiError('DOCUMENT_VOID', { order_id: id });
    if (!input.note?.trim()) {
      throw ApiError.validation([
        {
          path: 'note',
          code: 'REQUIRED',
          message_key: 'errors:field.required',
          params: { field: 'note' },
        },
      ]);
    }
    if (existing.payment_type === input.to) {
      throw ApiError.validation([
        { path: 'to', code: 'UNCHANGED', message_key: 'errors:field.required', params: {} },
      ]);
    }
    if (input.to === 'cash' && !input.received_currency) {
      throw ApiError.validation([
        {
          path: 'received_currency',
          code: 'REQUIRED',
          message_key: 'errors:field.required',
          params: { field: 'received_currency' },
        },
      ]);
    }

    const entryDate = input.entry_date ?? this.period.today();
    this.period.assertNotFuture(entryDate, 'entry_date');

    await this.database.transaction(async (tx) => {
      const order = await this.orders.lock(id, tx);
      if (!order) throw ApiError.notFound();
      const locked = await this.ledger.lockOwner(tx, order.customer_id);
      if (!locked) throw ApiError.notFound();

      let ledgerEntryId: string | null = null;

      if (input.to === 'cash') {
        const entries = await this.ledger.entriesFor(tx, order.customer_id);
        const remaining = remainingOf(entries, id, locked.settlement_currency);
        if (remaining <= 0) {
          throw ApiError.validation([
            { path: 'to', code: 'NOTHING_OWED', message_key: 'errors:nothing_owed', params: {} },
          ]);
        }

        const money = await this.settlementPair({
          remaining,
          settlementCurrency: locked.settlement_currency,
          receivedCurrency: input.received_currency as Currency,
          receivedAmount: input.received_amount ?? null,
          rate: order.rate_iqd_per_usd,
          rateSource: order.rate_source,
          otherSideFallback: null,
        });

        const result = await this.ledger.write(
          context,
          tx,
          locked,
          {
            entry_type: 'cash_settlement',
            money,
            entry_date: entryDate,
            note: input.note,
            performed_by_user_id: context.userId,
            refs: { order_id: id },
            method: 'cash',
            assign_voucher_number: true,
          },
          { audit_note: input.note, related: { order_id: id, customer_id: order.customer_id } },
        );
        ledgerEntryId = result.entry.id;
      } else {
        const entries = await this.ledger.entriesFor(tx, order.customer_id);
        const settlement = entries.find(
          (entry) =>
            entry.entry_type === 'cash_settlement' &&
            entry.refs.order_id === id &&
            !entries.some((other) => other.reverses_entry_id === entry.id),
        );
        if (!settlement) {
          throw ApiError.validation([
            { path: 'to', code: 'NO_SETTLEMENT', message_key: 'errors:no_settlement', params: {} },
          ]);
        }
        const result = await this.ledger.reverse(context, tx, locked, settlement.id, {
          note: input.note,
          entry_date: entryDate,
          related: { order_id: id, customer_id: order.customer_id },
        });
        ledgerEntryId = result.entry.id;
      }

      const updated = await this.orders.updateOrder(
        id,
        order.version,
        { payment_type: input.to },
        context.userId,
        tx,
      );
      if (!updated) throw await this.versionConflict(context, id);

      await this.orders.recordPaymentTypeChange(
        {
          order_id: id,
          from_type: order.payment_type,
          to_type: input.to,
          note: input.note,
          ledger_entry_id: ledgerEntryId,
          changed_by: context.userId,
        },
        tx,
      );

      await this.audit.record(
        context,
        {
          action: 'status_change',
          entity_type: 'order',
          entity_id: id,
          entity_label: `Order #${order.number}`,
          changes: { payment_type: { old: order.payment_type, new: input.to } },
          note: input.note,
          related: { order_id: id, customer_id: order.customer_id, ledger_entry_id: ledgerEntryId },
        },
        tx,
      );
    });

    return this.get(context, id);
  }

  /** A payment against this order: the customer-side writer, with the order linked (FR-606). */
  async recordPayment(
    context: RequestContext,
    id: string,
    input: Omit<PaymentInput, 'order_id'>,
  ): Promise<WriteResultDto[]> {
    const order = await this.requireOrder(context, id);
    if (order.status === 'void') throw new ApiError('DOCUMENT_VOID', { order_id: id });
    // The order's own scope rule already authorised this caller — an employee may pay off an
    // order they entered even after the customer was reassigned to somebody else (2.6.4), so
    // the customer-level check is not applied a second time here.
    return this.customersService.recordPayment(
      context,
      order.customer_id,
      { ...input, order_id: id },
      { authorisedByOrder: true },
    );
  }

  async historyOf(
    context: RequestContext,
    id: string,
    options: { cursor?: string; limit?: number },
  ) {
    const order = await this.requireOrder(context, id);
    const [audit, paymentTypes, entries] = await Promise.all([
      this.history.list({ about_order: id, ...options }),
      this.orders.paymentTypeHistory(id),
      this.ledger.entriesFor(this.database, order.customer_id),
    ]);

    return {
      ...audit,
      payment_type_changes: paymentTypes.map((row) => ({
        id: row.id,
        from_type: row.from_type,
        to_type: row.to_type,
        note: row.note,
        changed_at: row.changed_at.toISOString(),
        changed_by_name: row.changed_by_name,
      })),
      ledger_entries: entries
        .filter((entry) => entry.refs.order_id === id)
        .map((entry) => ({
          id: entry.id,
          entry_type: entry.entry_type,
          entry_date: entry.entry_date,
          amount_iqd: entry.amount_iqd,
          amount_usd_cents: entry.amount_usd_cents,
          entered_currency: entry.entered_currency,
          rate_iqd_per_usd: entry.rate_iqd_per_usd,
          note: entry.note,
          voucher_number: entry.voucher_number ?? null,
          reverses_entry_id: entry.reverses_entry_id,
        })),
    };
  }

  /**
   * The order receipt (FR-613, Proposed — not requested): the stored values the screen shows,
   * plus what the customer owes after this order, for the client to render and share (D-014).
   */
  async receipt(context: RequestContext, id: string) {
    const order = await this.requireOrder(context, id);
    const lines = await this.orders.linesOf(id);
    const customer = await this.customers.findByIdUnscoped(order.customer_id);
    const balance = customer ? await this.customers.balanceOf(order.customer_id) : 0;

    return {
      order: toOrderDto(order, lines),
      customer: {
        id: order.customer_id,
        name: order.customer_name,
        is_system: order.customer_is_system,
        phone: customer?.phone ?? null,
        settlement_currency: order.settlement_currency,
      },
      balance_after: can(context, 'fields.see_customer_balances') ? balance : null,
      printed_at: new Date().toISOString(),
    };
  }

  // ───────────────────────────── the pieces the writes share ─────────────────────────────

  /**
   * The rate for this document (2.3.3): the one typed for this deal, else the business's own
   * rate when it has one (`company`, D-054), else the global rate — snapshotted on the order so a
   * later rate change never moves it.
   */
  private async rateFor(
    typed?: string | null,
    customerId?: string | null,
  ): Promise<{ rate: Rate; rateSource: RateSource }> {
    if (typed) {
      const rate = formatRate(typed);
      if (Number(rate) <= 0) {
        throw ApiError.validation([
          {
            path: 'rate_iqd_per_usd',
            code: 'INVALID',
            message_key: 'errors:field.required',
            params: {},
          },
        ]);
      }
      return { rate, rateSource: 'manual' };
    }
    if (customerId) {
      const own = await this.customers.currentRate(customerId);
      if (own) return { rate: formatRate(own.rate), rateSource: 'company' };
    }
    return { rate: await this.rates.requireCurrent(), rateSource: 'global' };
  }

  /** Only an admin may record an order as done by somebody else (spec 2.7). */
  private async actingUser(context: RequestContext, requested?: string | null): Promise<string> {
    if (!requested || requested === context.userId) return context.userId;
    if (context.role !== 'admin') throw ApiError.permissionDenied('admin');
    const { rowCount } = await this.database.query(
      'SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL AND is_active = true',
      [requested],
    );
    if (!rowCount) {
      throw ApiError.validation([
        {
          path: 'acting_user_id',
          code: 'NOT_FOUND',
          message_key: 'errors:field.required',
          params: {},
        },
      ]);
    }
    return requested;
  }

  /**
   * Who may edit (FR-610): the creator, an admin, or a holder of `orders.edit`.
   */
  private async assertMayEdit(context: RequestContext, order: OrderListRow): Promise<void> {
    const mayEdit =
      context.role === 'admin' ||
      order.created_by === context.userId ||
      can(context, 'orders.edit');
    if (!mayEdit) throw ApiError.permissionDenied('orders.edit');
  }

  /**
   * Every line: the priced measure, the price (defaulted from the month list or typed), the
   * totals by the entered-currency rule, and the cost snapshot for the Profit report.
   */
  private async prepareLines(
    tx: Db,
    inputs: readonly LineInput[],
    orderDate: string,
    rate: Rate,
    rateSource: RateSource,
    carryOver?: { previous: readonly OrderLineRow[]; monthUnchanged: boolean },
  ): Promise<PreparedLine[]> {
    const month = firstOfMonth(orderDate);
    const prepared: PreparedLine[] = [];

    for (const [index, input] of inputs.entries()) {
      const item = await this.items.findById(input.item_id, tx);
      if (!item) {
        throw ApiError.validation([
          {
            path: `lines.${index}.item_id`,
            code: 'NOT_FOUND',
            message_key: 'errors:field.required',
            params: {},
          },
        ]);
      }
      if (!item.is_active) {
        throw ApiError.validation([
          {
            path: `lines.${index}.item_id`,
            code: 'INACTIVE',
            message_key: 'errors:material_inactive',
            params: { item: item.name },
          },
        ]);
      }

      const pricedMeasure: Measure = item.pricing_unit === 'per_piece' ? 'count' : 'kg';
      const qtyCount = input.qty_count ?? null;
      const qtyKg = input.qty_kg ?? null;
      const pricedQuantity = pricedMeasure === 'count' ? qtyCount : qtyKg;
      if (pricedQuantity === null || Number(pricedQuantity) <= 0) {
        throw ApiError.validation([
          {
            path: `lines.${index}.${pricedMeasure === 'count' ? 'qty_count' : 'qty_kg'}`,
            code: 'REQUIRED',
            message_key: 'errors:field.required',
            params: { field: pricedMeasure },
          },
        ]);
      }

      const prices = await this.items.pricesUpTo(item.id, month, tx);
      const saleSelection = selectMonthPrice(prices, 'sale', orderDate);

      let unitPriceIqd: number;
      let unitPriceUsdCents: number;
      let enteredCurrency: Currency;
      let priceSource: 'month' | 'override';
      let monthPriceId: string | null;
      let priceFromMonth: string | null;
      let bothTyped = false;

      if (input.unit_price) {
        const pair = completePair({
          amount: input.unit_price.amount,
          currency: input.unit_price.currency,
          rate,
          rate_source: rateSource,
          other_amount: input.unit_price.other_amount ?? undefined,
        });
        unitPriceIqd = pair.amount_iqd;
        unitPriceUsdCents = pair.amount_usd_cents;
        enteredCurrency = input.unit_price.currency;
        priceSource = 'override';
        monthPriceId = saleSelection.row?.id ?? null;
        priceFromMonth = null;
        bothTyped =
          input.unit_price.other_amount !== undefined && input.unit_price.other_amount !== null;
      } else {
        const defaulted = defaultLinePrice(saleSelection, rate);
        if (!defaulted) {
          // Only when *no* month has a price is the field empty and the document warned
          // about; a carried-forward price is quiet by design (FR-306).
          throw ApiError.validation([
            {
              path: `lines.${index}.unit_price`,
              code: 'PRICE_REQUIRED',
              message_key: 'errors:price_required',
              params: { item: item.name },
            },
          ]);
        }
        unitPriceIqd = defaulted.unit_price_iqd;
        unitPriceUsdCents = defaulted.unit_price_usd_cents;
        enteredCurrency = defaulted.price_entered_currency;
        priceSource = 'month';
        monthPriceId = defaulted.month_price_id;
        priceFromMonth = defaulted.carried_forward ? defaulted.from_month : null;
      }

      const totals = computeLineTotals({
        priced_measure: pricedMeasure,
        qty_count: qtyCount,
        qty_kg: qtyKg,
        unit_price_iqd: unitPriceIqd,
        unit_price_usd_cents: unitPriceUsdCents,
        price_entered_currency: enteredCurrency,
        both_prices_typed: bothTyped,
        document_rate: rate,
        document_rate_source: rateSource,
      });

      // The cost snapshot: kept from the line it replaces when the material and the month are
      // unchanged, re-taken otherwise (2.2.3 `order_lines`, 2.5.3 step 3).
      const previous = carryOver?.previous.find((line) => line.item_id === item.id);
      const cost =
        previous && carryOver?.monthUnchanged
          ? {
              cost_unit_iqd:
                previous.cost_unit_iqd === null ? null : Number(previous.cost_unit_iqd),
              cost_unit_usd_cents:
                previous.cost_unit_usd_cents === null ? null : Number(previous.cost_unit_usd_cents),
              cost_month_price_id: previous.cost_month_price_id,
              cost_source: previous.cost_source,
            }
          : costSnapshotOf(selectMonthPrice(prices, 'bought', orderDate));

      prepared.push({
        line_no: index + 1,
        item_id: item.id,
        item_name: item.name,
        qty_count: qtyCount,
        qty_kg: qtyKg,
        priced_measure: pricedMeasure,
        unit_price_iqd: unitPriceIqd,
        unit_price_usd_cents: unitPriceUsdCents,
        price_entered_currency: enteredCurrency,
        price_source: priceSource,
        month_price_id: monthPriceId,
        rate_iqd_per_usd: totals.rate_iqd_per_usd,
        rate_source: totals.rate_source,
        line_total_iqd: totals.line_total_iqd,
        line_total_usd_cents: totals.line_total_usd_cents,
        cost_unit_iqd: cost.cost_unit_iqd,
        cost_unit_usd_cents: cost.cost_unit_usd_cents,
        cost_month_price_id: cost.cost_month_price_id,
        cost_source: cost.cost_source,
        note: input.note?.trim() || null,
        price_from_month: priceFromMonth,
      });
    }

    return prepared;
  }

  /** Proposed — not requested (FR-616): a pair at the document rate, never above the lines. */
  private discountPair(
    input: CreateOrderInput['discount'],
    rate: Rate,
    rateSource: RateSource,
    lines: readonly NewOrderLine[],
  ): MoneyPair {
    if (!input || input.amount === 0) {
      return {
        amount_iqd: 0,
        amount_usd_cents: 0,
        entered_currency: null,
        rate_iqd_per_usd: rate,
        rate_source: rateSource,
      };
    }
    const pair = completePair({
      amount: Math.abs(input.amount),
      currency: input.currency,
      rate,
      rate_source: rateSource,
      other_amount:
        input.other_amount === undefined || input.other_amount === null
          ? undefined
          : Math.abs(input.other_amount),
    });

    const gross = documentTotals(lines);
    if (pair.amount_iqd > gross.total_iqd || pair.amount_usd_cents > gross.total_usd_cents) {
      throw ApiError.validation([
        {
          path: 'discount',
          code: 'DISCOUNT_TOO_LARGE',
          message_key: 'errors:discount_too_large',
          params: { total_iqd: gross.total_iqd, total_usd_cents: gross.total_usd_cents },
        },
      ]);
    }
    return pair;
  }

  /** One `sale_out` movement per line, referencing the line it came from (FR-608). */
  private async writeSaleMovements(
    tx: Db,
    context: RequestContext,
    orderId: string,
    entryDate: string,
    inserted: readonly OrderLineRow[],
    prepared: readonly PreparedLine[],
  ): Promise<void> {
    for (const [index, line] of inserted.entries()) {
      const source = prepared[index] as PreparedLine;
      await this.stock.append(tx, {
        item_id: source.item_id,
        movement_type: 'sale_out',
        // A measure the line did not carry stays null: it is "not recorded", not "zero".
        qty_count: source.qty_count === null ? null : -source.qty_count,
        qty_kg: source.qty_kg === null ? null : new Decimal(source.qty_kg).negated().toFixed(3),
        entry_date: entryDate,
        ref_type: 'order_line',
        ref_id: line.id,
        note: null,
        created_by: context.userId,
      });
    }
    void orderId;
  }

  /**
   * The customer-side entries of an order (A-24, FR-612): the receivable always, and for a
   * cash order an immediate settlement carrying the currency actually handed over.
   */
  private async writeDocumentEntries(
    context: RequestContext,
    tx: Db,
    customer: LedgerCustomer,
    input: {
      orderId: string;
      orderDate: string;
      paymentType: PaymentType;
      totals: { total_iqd: number; total_usd_cents: number };
      rate: Rate;
      rateSource: RateSource;
      receivedCurrency: Currency | null;
      receivedAmount: number | null;
      customer: CustomerRow;
    },
  ): Promise<OrderDto['credit_limit_warning']> {
    const settlementAmount =
      customer.settlement_currency === 'IQD'
        ? input.totals.total_iqd
        : input.totals.total_usd_cents;

    // The entry copies the order's two totals exactly as stored — never a conversion of one
    // of them — together with the order's rate snapshot (FR-612, 2.3.4).
    const orderEntry = await this.ledger.write(
      context,
      tx,
      customer,
      {
        entry_type: 'order',
        money: {
          amount_iqd: input.totals.total_iqd,
          amount_usd_cents: input.totals.total_usd_cents,
          entered_currency: null,
          rate_iqd_per_usd: input.rate,
          rate_source: input.rateSource,
        },
        entry_date: input.orderDate,
        performed_by_user_id: context.userId,
        refs: { order_id: input.orderId },
      },
      { related: { order_id: input.orderId, customer_id: customer.id } },
    );

    let warning: OrderDto['credit_limit_warning'] = null;
    if (input.paymentType === 'cash') {
      const money = await this.settlementPair({
        remaining: settlementAmount,
        settlementCurrency: customer.settlement_currency,
        receivedCurrency: input.receivedCurrency as Currency,
        receivedAmount: input.receivedAmount,
        rate: input.rate,
        rateSource: input.rateSource,
        // Same currency and no rounded amount handed over: the settlement is the exact
        // negation of the order entry, so the order closes at zero in *both* columns.
        otherSideFallback:
          customer.settlement_currency === 'IQD'
            ? input.totals.total_usd_cents
            : input.totals.total_iqd,
      });

      await this.ledger.write(
        context,
        tx,
        customer,
        {
          entry_type: 'cash_settlement',
          money,
          entry_date: input.orderDate,
          performed_by_user_id: context.userId,
          refs: { order_id: input.orderId },
          method: 'cash',
          assign_voucher_number: true,
        },
        { related: { order_id: input.orderId, customer_id: customer.id } },
      );
    } else if (input.customer.credit_limit_iqd !== null) {
      // Proposed — not requested (FR-616): a warning on the response, never a refusal.
      const limit =
        customer.settlement_currency === 'IQD'
          ? Number(input.customer.credit_limit_iqd)
          : Number(input.customer.credit_limit_usd_cents);
      if (orderEntry.balance.after > limit) {
        warning = {
          limit,
          balance_after: orderEntry.balance.after,
          currency: customer.settlement_currency,
        };
      }
    }

    return warning;
  }

  /**
   * The pair a cash settlement stores (FR-604, 2.3.6).
   *
   * The settlement side is always the exact amount owed, so the order lands on Paid. The other
   * side is what the customer physically handed over: given, it is stored with the implied
   * rate as `manual` and checked against the settlement tolerance — a bigger gap is not a rate
   * but a discount or a credit, and the form is told so.
   */
  private async settlementPair(input: {
    remaining: number;
    settlementCurrency: Currency;
    receivedCurrency: Currency;
    receivedAmount: number | null;
    rate: Rate;
    rateSource: RateSource;
    otherSideFallback: number | null;
  }): Promise<MoneyPair> {
    const settlementSide = -input.remaining;

    if (input.receivedCurrency === input.settlementCurrency) {
      // Paid in the settlement currency: the settlement is the exact negation of what is
      // owed, in *both* columns, so the order closes at zero and no junk lands in the other
      // one. A different amount handed over in the same currency is not a rate difference —
      // it is a discount (FR-616) or a part payment, and the form is told so rather than
      // having cents quietly recorded as dinars.
      if (input.receivedAmount !== null && input.receivedAmount !== input.remaining) {
        throw new ApiError('RECEIVED_AMOUNT_OUT_OF_TOLERANCE', {
          expected: input.remaining,
          received: input.receivedAmount,
          currency: input.receivedCurrency,
          reason: 'same_currency',
        });
      }
      const other =
        input.otherSideFallback ?? convert(input.remaining, input.settlementCurrency, input.rate);
      return {
        amount_iqd: input.settlementCurrency === 'IQD' ? settlementSide : -other,
        amount_usd_cents: input.settlementCurrency === 'IQD' ? -other : settlementSide,
        entered_currency: input.receivedCurrency,
        rate_iqd_per_usd: input.rate,
        rate_source: input.rateSource,
      };
    }

    // Received in the other currency: the settlement side is the exact amount owed and the
    // other side is what was physically handed over, stored as a manual-rate pair and bounded
    // by the settlement tolerance (2.3.6).
    const expected = convert(input.remaining, input.settlementCurrency, input.rate);
    const received = input.receivedAmount ?? expected;
    const tolerance = {
      settle_tolerance_iqd: await this.settings.get('settle_tolerance_iqd'),
      settle_tolerance_usd_cents: await this.settings.get('settle_tolerance_usd_cents'),
    };
    if (!withinTolerance(expected - received, input.receivedCurrency, tolerance)) {
      throw new ApiError('RECEIVED_AMOUNT_OUT_OF_TOLERANCE', {
        expected,
        received,
        currency: input.receivedCurrency,
      });
    }

    const amountIqd = input.settlementCurrency === 'IQD' ? settlementSide : -received;
    const amountUsd = input.settlementCurrency === 'IQD' ? -received : settlementSide;
    return {
      amount_iqd: amountIqd,
      amount_usd_cents: amountUsd,
      entered_currency: input.receivedCurrency,
      rate_iqd_per_usd: amountUsd === 0 ? input.rate : impliedRate(amountIqd, amountUsd),
      rate_source: 'manual',
    };
  }

  private async versionConflict(context: RequestContext, id: string): Promise<ApiError> {
    const current = await this.orders.findById(id, this.scopeOf(context));
    return new ApiError('VERSION_CONFLICT', { entity: 'order', version: current?.version ?? null });
  }
}

function pricedQuantityOf(
  line: Pick<NewOrderLine, 'priced_measure' | 'qty_count' | 'qty_kg'>,
): string {
  return line.priced_measure === 'count' ? String(line.qty_count ?? 0) : String(line.qty_kg ?? '0');
}

function remainingOf(entries: readonly LedgerEntry[], orderId: string, currency: Currency): number {
  return entries
    .filter((entry) => entry.refs.order_id === orderId)
    .reduce(
      (total, entry) => total + (currency === 'IQD' ? entry.amount_iqd : entry.amount_usd_cents),
      0,
    );
}

function lineSummary(line: PreparedLine) {
  return {
    item_id: line.item_id,
    item: line.item_name,
    qty_count: line.qty_count,
    qty_kg: line.qty_kg,
    unit_price: { iqd: line.unit_price_iqd, usd_cents: line.unit_price_usd_cents },
    line_total: { iqd: line.line_total_iqd, usd_cents: line.line_total_usd_cents },
    price_source: line.price_source,
  };
}

function storedLineSummary(line: OrderLineRow) {
  return {
    item_id: line.item_id,
    item: line.item_name ?? null,
    qty_count: line.qty_count,
    qty_kg: line.qty_kg,
    unit_price: { iqd: Number(line.unit_price_iqd), usd_cents: Number(line.unit_price_usd_cents) },
    line_total: { iqd: Number(line.line_total_iqd), usd_cents: Number(line.line_total_usd_cents) },
    price_source: line.price_source,
  };
}

function toOrderLineDto(line: OrderLineRow, orderMonth: string): OrderLineDto {
  return {
    id: line.id,
    line_no: line.line_no,
    item_id: line.item_id,
    item_name: line.item_name ?? '',
    qty_count: line.qty_count,
    qty_kg: line.qty_kg,
    priced_measure: line.priced_measure,
    unit_price_iqd: Number(line.unit_price_iqd),
    unit_price_usd_cents: Number(line.unit_price_usd_cents),
    price_entered_currency: line.price_entered_currency,
    price_source: line.price_source,
    month_price_id: line.month_price_id,
    // Set only when the price was carried forward from an earlier month, which is what the
    // line's quiet marker says (FR-306).
    price_from_month:
      line.price_source === 'month' && line.price_month && line.price_month !== orderMonth
        ? line.price_month
        : null,
    line_total_iqd: Number(line.line_total_iqd),
    line_total_usd_cents: Number(line.line_total_usd_cents),
    rate_iqd_per_usd: line.rate_iqd_per_usd,
    rate_source: line.rate_source,
    note: line.note,
    cost:
      line.cost_unit_iqd === null ||
      line.cost_unit_usd_cents === null ||
      line.cost_source === 'none'
        ? null
        : {
            unit_iqd: Number(line.cost_unit_iqd),
            unit_usd_cents: Number(line.cost_unit_usd_cents),
            month_price_id: line.cost_month_price_id,
            source: line.cost_source,
          },
  };
}

function toOrderDto(row: OrderListRow, lines: readonly OrderLineRow[]): OrderDto {
  const remaining = Number(row.remaining ?? 0);
  const total =
    row.settlement_currency === 'IQD' ? Number(row.total_iqd) : Number(row.total_usd_cents);

  return {
    id: row.id,
    number: Number(row.number),
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    customer_is_system: row.customer_is_system,
    settlement_currency: row.settlement_currency,
    order_date: row.order_date,
    payment_type: row.payment_type,
    acting_user_id: row.acting_user_id,
    acting_user_name: row.acting_user_name,
    notes: row.notes,
    rate_iqd_per_usd: row.rate_iqd_per_usd,
    rate_source: row.rate_source,
    discount_iqd: Number(row.discount_iqd),
    discount_usd_cents: Number(row.discount_usd_cents),
    total_iqd: Number(row.total_iqd),
    total_usd_cents: Number(row.total_usd_cents),
    // The view derives the status; this repeats the kernel's rule for the rows a list joined
    // without it, and the two agree by construction (2.4.3).
    status:
      (row.derived_status as OrderDto['status']) ??
      orderStatus({ voided: row.status === 'void', total, remaining }),
    doc_status: row.status,
    void_reason: row.void_reason,
    voided_by_name: row.voided_by_name,
    voided_at: row.voided_at?.toISOString() ?? null,
    remaining,
    received_currency: row.received_currency,
    lines: lines.map((line) => toOrderLineDto(line, firstOfMonth(row.order_date))),
    version: row.version,
    created_at: row.created_at.toISOString(),
  };
}

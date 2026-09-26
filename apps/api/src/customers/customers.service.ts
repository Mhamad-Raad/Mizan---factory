import { Injectable } from '@nestjs/common';
import { amountIn, completePair, convert, formatRate, settleInFull } from '@mizan/money';
import type { Currency, MoneyPair, Rate } from '@mizan/money';
import { balanceAsOf, balanceOf } from '@mizan/ledger';
import type { LedgerEntry, LedgerGroup } from '@mizan/ledger';
import { AuditService, diffOf } from '../audit/audit.service.js';
import { ApiError } from '../common/errors.js';
import { can } from '../common/request-context.js';
import type { RequestContext } from '../common/request-context.js';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';
import { HistoryRepository } from '../history/history.repository.js';
import { CustomerLedgerService } from '../ledger/customer-ledger.service.js';
import type { LedgerCustomer } from '../ledger/customer-ledger.service.js';
import { RatesService } from '../rates/rates.service.js';
import { PeriodService } from '../settings/period.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { CompaniesService } from '../companies/companies.service.js';
import { CustomersRepository } from './customers.repository.js';
import type { CustomerFilters, CustomerScope } from './customers.repository.js';
import type {
  BalanceDto,
  CustomerDto,
  CustomerRateInfo,
  CustomerRow,
  LedgerGroupDto,
} from './customer.types.js';

export interface MoneyInput {
  amount: number;
  currency: Currency;
  /** The calculated side, when the user overwrote it — stored as a manual rate (2.3.2). */
  other_amount?: number | null;
}

export interface CreateCustomerInput {
  name: string;
  contact_name?: string | null;
  /** The sides of the business this record takes part in (D-054); a customer by default. */
  is_customer?: boolean;
  is_supplier?: boolean;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
  settlement_currency?: Currency;
  assigned_user_id?: string | null;
  /** Proposed — not requested (FR-616). */
  credit_limit?: MoneyInput | null;
}

export interface PaymentInput extends MoneyInput {
  order_id?: string | null;
  entry_date: string;
  /** Writes the exact remaining balance with what was handed over as a manual pair (FR-606). */
  settle_in_full?: boolean;
  /** Confirms "record the excess as customer credit" when more than the remainder arrives. */
  allow_excess?: boolean;
  performed_by?: string | null;
  /** Proposed — not requested (FR-617). */
  method?: 'cash' | 'transfer' | 'other' | null;
  /** Proposed — not requested (FR-617): one payment part IQD, part USD, one note. */
  split?: MoneyInput[] | null;
  note?: string | null;
}

export interface LedgerEntryInput extends MoneyInput {
  entry_date: string;
  note: string;
  order_id?: string | null;
  damage_id?: string | null;
  performed_by?: string | null;
  method?: 'cash' | 'transfer' | 'other' | null;
}

export interface WriteResultDto {
  entry_id: string;
  entry_type: string;
  amount_iqd: number;
  amount_usd_cents: number;
  voucher_number: number | null;
  balance_before: number;
  balance_after: number;
  currency: Currency;
  /** Present when the entry was linked to an order (FR-607). */
  order?: { id: string; remaining: number; status: string };
}

/**
 * Customers, their balances and every money movement on the customer side (FR-501 to FR-507,
 * FR-606, FR-612).
 *
 * Two invariants hold for every method here: the balance is a sum over `customer_ledger`
 * computed inside the transaction that writes to it, and the customer row is locked first, so
 * the before/after values History records are the ones that actually happened (spec 2.9.5).
 */
/**
 * How many rows one statement may carry (the system-wide review).
 *
 * A statement is a document somebody prints or sends on WhatsApp, and five hundred rows is
 * already forty pages. Without a cap the endpoint returned every row of the account: for a
 * ten-year account of 20,000 entries that is **15.8 MB of JSON** — five minutes of download on
 * the 400 kbps reference connection of NFR-03, and more than a 2 GB tablet will render. The
 * opening and closing balances are sums over the whole range and stay exact when the rows
 * between them are capped, so a capped statement still reconciles; it simply says so.
 */
const STATEMENT_ITEM_CAP = 500;

@Injectable()
export class CustomersService {
  constructor(
    private readonly database: Database,
    private readonly customers: CustomersRepository,
    private readonly ledger: CustomerLedgerService,
    private readonly rates: RatesService,
    private readonly period: PeriodService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly history: HistoryRepository,
    private readonly suppliers: CompaniesService,
  ) {}

  scopeOf(context: RequestContext): CustomerScope {
    return {
      userId: context.userId,
      viewAll: can(context, 'customers.view_all'),
      seesSuppliers: can(context, 'companies.view'),
    };
  }

  /**
   * Which balances this caller may read (FR-503, FR-704). The net figure needs both: from the
   * net and one side anybody could work out the side they may not see.
   */
  private sightOf(context: RequestContext): { selling: boolean; buying: boolean } {
    return {
      selling: can(context, 'fields.see_customer_balances'),
      buying: can(context, 'fields.see_company_balances'),
    };
  }

  /**
   * A record takes part in the selling side, the buying side or both, and each side keeps the
   * permission it always had: creating or editing a customer needs `customers.<action>`, a
   * supplier `companies.<action>`, and a record that is both needs both (D-054).
   */
  private requireSides(
    context: RequestContext,
    sides: { is_customer: boolean; is_supplier: boolean },
    action: 'create' | 'edit' | 'assign',
  ): void {
    const missing =
      (sides.is_customer && !can(context, `customers.${action}`)) ||
      (sides.is_supplier && !can(context, `companies.${action}`));
    if (missing) {
      throw ApiError.permissionDenied(
        sides.is_supplier && !can(context, `companies.${action}`)
          ? `companies.${action}`
          : `customers.${action}`,
      );
    }
    if (!sides.is_customer && !sides.is_supplier) {
      throw ApiError.validation([
        { path: 'is_customer', code: 'NO_SIDE', message_key: 'errors:customer_no_side', params: {} },
      ]);
    }
  }

  /**
   * The rate every calculated amount for this business is filled at — its orders, its payments
   * and credits, and its purchases on the buying side: its own rate, else the global one
   * (2.3.3, D-054). The own rate is stored as `company`, the source label for "this party's rate".
   */
  async rateFor(id: string, tx?: Db): Promise<{ rate: Rate; source: 'company' | 'global' }> {
    const own = await this.customers.currentRate(id, tx);
    if (own) return { rate: formatRate(own.rate), source: 'company' };
    return { rate: await this.rates.requireCurrent(tx), source: 'global' };
  }

  async list(
    context: RequestContext,
    filters: CustomerFilters,
  ): Promise<{ items: CustomerDto[]; total: number }> {
    const { rows, total } = await this.customers.list(filters, this.scopeOf(context));
    const sight = this.sightOf(context);
    // The list values balances at the global rate; a customer's own rate is applied on the
    // detail, where a single per-row lookup is not thousands of them.
    const globalRate = await this.rates.current();
    const rateInfo: CustomerRateInfo | null = globalRate
      ? { rate_iqd_per_usd: globalRate.rate_iqd_per_usd, since: null, is_customer_rate: false }
      : null;
    return {
      items: rows.map((row) =>
        toCustomerDto(row, {
          assigned_user_name: row.assigned_user_name,
          balance: Number(row.balance),
          payable: Number(row.payable),
          rate: rateInfo,
          sight,
        }),
      ),
      total,
    };
  }

  async get(context: RequestContext, id: string): Promise<CustomerDto> {
    const row = await this.requireCustomer(context, id);
    return this.detailOf(row, this.sightOf(context));
  }

  private async detailOf(
    row: CustomerRow,
    sight: { selling: boolean; buying: boolean },
    tx?: Db,
  ): Promise<CustomerDto> {
    const db = tx ?? this.database;
    const [balance, payable, customerRate, globalRate, assignee] = await Promise.all([
      this.customers.balanceOf(row.id, db),
      this.customers.payableOf(row.id, db),
      this.customers.currentRate(row.id, db),
      this.rates.current(db),
      this.assigneeName(db, row.assigned_user_id),
    ]);
    // The customer's own rate is authoritative; a customer with none falls back to the global.
    const rateInfo: CustomerRateInfo | null = customerRate
      ? {
          rate_iqd_per_usd: formatRate(customerRate.rate),
          since: customerRate.since.toISOString(),
          is_customer_rate: true,
        }
      : globalRate
        ? { rate_iqd_per_usd: globalRate.rate_iqd_per_usd, since: null, is_customer_rate: false }
        : null;
    return toCustomerDto(row, { assigned_user_name: assignee, balance, payable, rate: rateInfo, sight });
  }

  private async assigneeName(db: Db, userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const { rows } = await db.query<{ display_name: string }>(
      'SELECT display_name FROM users WHERE id = $1',
      [userId],
    );
    return rows[0]?.display_name ?? null;
  }

  /** 404 rather than 403 when the customer is out of the caller's scope (spec 2.6.4). */
  private async requireCustomer(context: RequestContext, id: string): Promise<CustomerRow> {
    const row = await this.customers.findById(id, this.scopeOf(context));
    if (!row) throw ApiError.notFound();
    return row;
  }

  /**
   * The duplicate check of FR-501, run over every customer whatever the caller may see. When
   * the twin belongs to someone else the answer is not "open it" — the employee cannot — but
   * "ask your admin to assign it to you", which is what stops the directory fragmenting.
   */
  async checkDuplicates(name: string): Promise<{
    duplicates: {
      id: string;
      name: string;
      assigned_user_name: string | null;
      assigned_to_me: boolean;
    }[];
  }> {
    const rows = await this.customers.findDuplicates(name);
    return {
      duplicates: rows.map((row) => ({
        id: row.id,
        name: row.name,
        assigned_user_name: row.assigned_user_name,
        assigned_to_me: false,
      })),
    };
  }

  async create(context: RequestContext, input: CreateCustomerInput): Promise<CustomerDto> {
    const name = input.name.trim();
    const scope = this.scopeOf(context);
    const sides = { is_customer: input.is_customer ?? true, is_supplier: input.is_supplier ?? false };
    this.requireSides(context, sides, 'create');

    // A customer created by someone who sees only their own is assigned to them, or they
    // could not use the record they just made (FR-501).
    const assignedTo = can(context, 'customers.assign')
      ? (input.assigned_user_id ?? (scope.viewAll ? null : context.userId))
      : scope.viewAll
        ? null
        : context.userId;

    const defaultCurrency = await this.settings.get('default_customer_currency');
    const rate = input.credit_limit ? await this.rates.requireCurrent() : null;

    const created = await this.database.transaction(async (tx) => {
      const limit =
        input.credit_limit && rate
          ? completePair({ ...input.credit_limit, rate, rate_source: 'global' })
          : null;

      const row = await this.customers.create(
        {
          name,
          contact_name: input.contact_name?.trim() || null,
          ...sides,
          phone: input.phone?.trim() || null,
          address: input.address?.trim() || null,
          notes: input.notes?.trim() || null,
          settlement_currency: input.settlement_currency ?? defaultCurrency,
          assigned_user_id: assignedTo,
          credit_limit_iqd: limit?.amount_iqd ?? null,
          credit_limit_usd_cents: limit?.amount_usd_cents ?? null,
          created_by: context.userId,
        },
        tx,
      );

      await this.audit.record(
        context,
        {
          action: 'create',
          entity_type: 'customer',
          entity_id: row.id,
          entity_label: `Customer: ${row.name}`,
          changes: {
            name: { old: null, new: row.name },
            is_customer: { old: null, new: row.is_customer },
            is_supplier: { old: null, new: row.is_supplier },
            phone: { old: null, new: row.phone },
            settlement_currency: { old: null, new: row.settlement_currency },
            assigned_user_id: { old: null, new: row.assigned_user_id },
          },
          related: { customer_id: row.id, assigned_user_id: row.assigned_user_id },
        },
        tx,
      );
      return row;
    });

    return this.detailOf(created, this.sightOf(context));
  }

  async update(
    context: RequestContext,
    id: string,
    input: Partial<CreateCustomerInput> & { version: number },
  ): Promise<CustomerDto> {
    await this.requireCustomer(context, id);
    const rate = input.credit_limit ? await this.rates.requireCurrent() : null;

    const updated = await this.database.transaction(async (tx) => {
      const before = await this.customers.lock(id, tx);
      if (!before) throw ApiError.notFound();
      if (before.is_system) {
        throw ApiError.validation([
          {
            path: 'id',
            code: 'SYSTEM_CUSTOMER',
            message_key: 'errors:system_customer',
            params: {},
          },
        ]);
      }

      const sides = {
        is_customer: input.is_customer ?? before.is_customer,
        is_supplier: input.is_supplier ?? before.is_supplier,
      };
      this.requireSides(context, sides, 'edit');
      await this.assertSidesStillFree(before, sides, tx);

      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.contact_name !== undefined) patch.contact_name = input.contact_name?.trim() || null;
      if (sides.is_customer !== before.is_customer) patch.is_customer = sides.is_customer;
      if (sides.is_supplier !== before.is_supplier) patch.is_supplier = sides.is_supplier;
      if (input.phone !== undefined) patch.phone = input.phone?.trim() || null;
      if (input.address !== undefined) patch.address = input.address?.trim() || null;
      if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
      if (input.credit_limit !== undefined) {
        const limit =
          input.credit_limit && rate
            ? completePair({ ...input.credit_limit, rate, rate_source: 'global' })
            : null;
        patch.credit_limit_iqd = limit?.amount_iqd ?? null;
        patch.credit_limit_usd_cents = limit?.amount_usd_cents ?? null;
      }

      const row = await this.customers.update(id, input.version, patch, context.userId, tx);
      if (!row) throw await this.versionConflict(id);

      const changes = diffOf({ ...before } as Record<string, unknown>, patch, [
        'name',
        'contact_name',
        'is_customer',
        'is_supplier',
        'phone',
        'address',
        'notes',
        'credit_limit_iqd',
        'credit_limit_usd_cents',
      ]);
      if (Object.keys(changes).length > 0) {
        await this.audit.record(
          context,
          {
            action: 'update',
            entity_type: 'customer',
            entity_id: id,
            entity_label: `Customer: ${row.name}`,
            changes,
            related: { customer_id: id },
          },
          tx,
        );
      }
      return row;
    });

    return this.detailOf(updated, this.sightOf(context));
  }

  /**
   * Deactivating a customer who still owes money is allowed, with a note: the debt does not
   * disappear because the relationship ended, and it stays visible in Receivables (FR-507).
   */
  async setActive(
    context: RequestContext,
    id: string,
    isActive: boolean,
    input: { version: number; note?: string | null },
  ): Promise<CustomerDto> {
    await this.requireCustomer(context, id);

    const updated = await this.database.transaction(async (tx) => {
      const before = await this.customers.lock(id, tx);
      if (!before) throw ApiError.notFound();
      this.requireSides(context, before, 'edit');
      if (before.is_system) {
        throw ApiError.validation([
          {
            path: 'id',
            code: 'SYSTEM_CUSTOMER',
            message_key: 'errors:system_customer',
            params: {},
          },
        ]);
      }
      if (before.is_active === isActive) return before;

      const balance = await this.customers.balanceOf(id, tx);
      if (!isActive && balance !== 0 && !input.note?.trim()) {
        throw ApiError.validation([
          {
            path: 'note',
            code: 'NOTE_REQUIRED',
            message_key: 'errors:note_required_balance',
            params: { balance, currency: before.settlement_currency },
          },
        ]);
      }

      const row = await this.customers.update(
        id,
        input.version,
        { is_active: isActive },
        context.userId,
        tx,
      );
      if (!row) throw await this.versionConflict(id);

      await this.audit.record(
        context,
        {
          action: 'status_change',
          entity_type: 'customer',
          entity_id: id,
          entity_label: `Customer: ${row.name}`,
          changes: {
            is_active: { old: before.is_active, new: isActive },
            balance: { old: { amount: balance, currency: before.settlement_currency }, new: null },
          },
          note: input.note?.trim() || null,
          related: { customer_id: id },
        },
        tx,
      );
      return row;
    });

    return this.detailOf(updated, this.sightOf(context));
  }

  async softDelete(context: RequestContext, id: string, version: number): Promise<void> {
    await this.database.transaction(async (tx) => {
      const before = await this.customers.lock(id, tx);
      if (!before) throw ApiError.notFound();
      if (before.is_system || (await this.customers.isReferenced(id, tx))) {
        throw ApiError.validation([
          { path: 'id', code: 'REFERENCED', message_key: 'errors:record_referenced', params: {} },
        ]);
      }

      const row = await this.customers.softDelete(id, version, context.userId, tx);
      if (!row) throw await this.versionConflict(id);

      await this.audit.record(
        context,
        {
          action: 'delete',
          entity_type: 'customer',
          entity_id: id,
          entity_label: `Customer: ${before.name}`,
          changes: { snapshot: { old: { ...before }, new: null } },
          related: { customer_id: id },
        },
        tx,
      );
    });
  }

  /** Assignment: who sees the customer and whose list they appear on (FR-502, A-15). */
  async assign(
    context: RequestContext,
    id: string,
    input: { user_id: string | null; note?: string | null; version?: number },
  ): Promise<CustomerDto> {
    const updated = await this.database.transaction(async (tx) => {
      const before = await this.customers.lock(id, tx);
      if (!before) throw ApiError.notFound();
      this.requireSides(context, before, 'assign');
      if (before.is_system) {
        throw ApiError.validation([
          {
            path: 'id',
            code: 'SYSTEM_CUSTOMER',
            message_key: 'errors:system_customer',
            params: {},
          },
        ]);
      }
      if (input.user_id) {
        const { rowCount } = await tx.query(
          'SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL AND is_active = true',
          [input.user_id],
        );
        if (!rowCount) {
          throw ApiError.validation([
            {
              path: 'user_id',
              code: 'NOT_FOUND',
              message_key: 'errors:field.required',
              params: {},
            },
          ]);
        }
      }

      const row = await this.customers.update(
        id,
        input.version ?? before.version,
        { assigned_user_id: input.user_id },
        context.userId,
        tx,
      );
      if (!row) throw await this.versionConflict(id);

      await this.audit.record(
        context,
        {
          action: 'assignment_change',
          entity_type: 'customer',
          entity_id: id,
          entity_label: `Customer: ${row.name}`,
          changes: { assigned_user_id: { old: before.assigned_user_id, new: input.user_id } },
          note: input.note?.trim() || null,
          related: { customer_id: id, assigned_user_id: input.user_id },
        },
        tx,
      );
      return row;
    });

    return this.detailOf(updated, this.sightOf(context));
  }

  /**
   * Changing the settlement currency (spec 2.3.5, FR-503).
   *
   * It never invents a balance: the switch always writes one `settlement_change` row carrying
   * a zero in the old currency and, in the new one, the delta between what the relationship is
   * worth at the agreed rate and what the new column already sums to. Without that row the new
   * column would be a sum at mixed historical rates — a phantom balance.
   */
  async setSettlementCurrency(
    context: RequestContext,
    id: string,
    input: { currency: Currency; note: string; rebase_rate?: string | null; version?: number },
  ): Promise<CustomerDto> {
    const updated = await this.database.transaction(async (tx) => {
      const before = await this.customers.lock(id, tx);
      if (!before) throw ApiError.notFound();
      if (before.settlement_currency === input.currency) {
        throw ApiError.validation([
          { path: 'currency', code: 'UNCHANGED', message_key: 'errors:field.required', params: {} },
        ]);
      }

      const customer: LedgerCustomer = {
        id: before.id,
        name: before.name,
        settlement_currency: before.settlement_currency,
      };
      const entries = await this.ledger.entriesFor(tx, id);
      const balanceOld = balanceOf(entries, before.settlement_currency);
      const sumNewColumn = balanceOf(entries, input.currency);

      const payableOld = before.is_supplier ? await this.customers.payableOf(id, tx) : 0;
      if ((balanceOld !== 0 || payableOld !== 0) && !input.rebase_rate) {
        throw new ApiError('REBASE_RATE_REQUIRED', {
          balance: balanceOld - payableOld,
          currency: before.settlement_currency,
        });
      }

      const rate = input.rebase_rate ?? (await this.rateFor(id, tx)).rate;
      const worthInNewCurrency =
        balanceOld === 0 ? 0 : convert(balanceOld, before.settlement_currency, rate);
      const delta = worthInNewCurrency - sumNewColumn;

      const money: MoneyPair = {
        amount_iqd: input.currency === 'IQD' ? delta : 0,
        amount_usd_cents: input.currency === 'USD' ? delta : 0,
        // The row is a marker, not a conversion of one amount into another, so it carries no
        // entered currency; the agreed rate is stored as `manual` (2.3.5).
        entered_currency: null,
        rate_iqd_per_usd: rate,
        rate_source: 'manual',
      };

      const result = await this.ledger.write(
        context,
        tx,
        customer,
        {
          entry_type: 'settlement_change',
          money,
          entry_date: this.period.today(),
          note: input.note,
          performed_by_user_id: context.userId,
        },
        { audit_note: input.note },
      );

      // One settlement currency per business (D-054): the buying side's ledger is re-based in the
      // same transaction and at the same agreed rate, or the net figure would subtract a balance
      // in dollars from one in dinars.
      const supplierSide = before.is_supplier
        ? await this.suppliers.rebaseBook(context, tx, before, input.currency, rate, input.note)
        : null;

      const row = await this.customers.update(
        id,
        input.version ?? before.version,
        { settlement_currency: input.currency },
        context.userId,
        tx,
      );
      if (!row) throw await this.versionConflict(id);

      await this.audit.record(
        context,
        {
          action: 'update',
          entity_type: 'customer',
          entity_id: id,
          entity_label: `Customer: ${row.name}`,
          changes: {
            settlement_currency: { old: before.settlement_currency, new: input.currency },
            balance: {
              old: { amount: balanceOld, currency: before.settlement_currency },
              new: { amount: sumNewColumn + delta, currency: input.currency, rate },
            },
            ...(supplierSide ? { payable: supplierSide } : {}),
          },
          note: input.note,
          related: { customer_id: id, ledger_entry_id: result.entry.id },
        },
        tx,
      );
      return row;
    });

    return this.detailOf(updated, this.sightOf(context));
  }

  /** The Ledger tab (FR-503): grouped rows in posting order with their running balance. */
  async ledgerOf(
    context: RequestContext,
    id: string,
    options: {
      raw?: boolean;
      money_only?: boolean;
      as_of?: string;
      include_undone?: boolean;
      /** The bound the I2 review added on both ledgers: a long account is not a page. */
      limit?: number;
    },
  ): Promise<{
    customer: { id: string; name: string; settlement_currency: Currency; is_system: boolean };
    balance: number;
    balance_as_of: number | null;
    items: LedgerGroupDto[];
    total: number;
    has_more: boolean;
  }> {
    const row = await this.requireCustomer(context, id);
    // The walk-in customer has no ledger at all: its net is always zero and its orders are
    // listed under Orders (2.4.5, A-33).
    if (row.is_system) throw ApiError.notFound();

    const customer: LedgerCustomer = {
      id: row.id,
      name: row.name,
      settlement_currency: row.settlement_currency,
    };
    const { groups, entries } = await this.ledger.groupsFor(this.database, customer, options);

    const visible = options.include_undone
      ? groups
      : groups.filter((group) => !group.hidden_by_default);
    // Newest first on screen; the running balance was computed in posting order (2.4.1), over
    // the whole ledger, so the page returned still carries the figures History recorded.
    const newestFirst = [...visible].reverse();
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const page = newestFirst.slice(0, limit);
    const names = await this.userNames(
      page.flatMap((group) => group.rows.map((line) => line.entry)),
    );

    return {
      customer: {
        id: row.id,
        name: row.name,
        settlement_currency: row.settlement_currency,
        is_system: row.is_system,
      },
      balance: balanceOf(entries, row.settlement_currency),
      balance_as_of: options.as_of
        ? balanceAsOf(entries, row.settlement_currency, options.as_of)
        : null,
      items: page.map((group) => toGroupDto(group, names)),
      total: visible.length,
      has_more: newestFirst.length > page.length,
    };
  }

  /**
   * A credit that names a damage record (FR-506 from damage, FR-806) must name **this**
   * customer's damage: the record is attributed to one of their orders. Anything else is a
   * mis-typed id, and the alternative to refusing it is a credit on the wrong account.
   */
  private async assertDamageOfCustomer(
    tx: Db,
    damageId: string,
    customerId: string,
  ): Promise<void> {
    const { rows } = await tx.query<{
      status: string;
      attribution: string;
      customer_id: string | null;
    }>(
      `SELECT d.status::text AS status, d.attribution::text AS attribution, o.customer_id
         FROM damages d
         LEFT JOIN orders o ON o.id = d.order_id
        WHERE d.id = $1 AND d.deleted_at IS NULL`,
      [damageId],
    );
    const row = rows[0];
    if (!row || row.attribution !== 'customer_order' || row.customer_id !== customerId) {
      throw ApiError.validation([
        { path: 'damage_id', code: 'NOT_FOUND', message_key: 'errors:field.required', params: {} },
      ]);
    }
    if (row.status === 'void') throw new ApiError('DOCUMENT_VOID', { damage_id: damageId });
  }

  private async userNames(entries: readonly LedgerEntry[]): Promise<Map<string, string>> {
    const ids = [
      ...new Set(entries.flatMap((entry) => [entry.performed_by_user_id, entry.created_by])),
    ].filter((id): id is string => Boolean(id));
    if (ids.length === 0) return new Map();
    const { rows } = await this.database.query<{ id: string; display_name: string }>(
      'SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])',
      [ids],
    );
    return new Map(rows.map((row) => [row.id, row.display_name]));
  }

  /**
   * A payment received from a customer (FR-606). Four shapes arrive at this one method:
   *
   *  · an ordinary amount in either currency, the other side calculated at today's rate;
   *  · "settle in full", which writes the exact remainder with what was handed over as a
   *    manual-rate pair, so no five-dinar residue keeps an order "partially paid";
   *  · a split part-IQD/part-USD payment, stored as two rows sharing one note (FR-617);
   *  · more than is owed, which is refused until the user confirms the excess as credit.
   */
  async recordPayment(
    context: RequestContext,
    id: string,
    input: PaymentInput,
    options: { authorisedByOrder?: boolean } = {},
  ): Promise<WriteResultDto[]> {
    this.period.assertNotFuture(input.entry_date, 'entry_date');
    // The orders module passes `authorisedByOrder` when the order's own scope rule already
    // let this caller through (2.6.4): an employee keeps paying off an order they entered
    // even after its customer was reassigned.
    if (!options.authorisedByOrder) await this.requireCustomer(context, id);

    const { rate, source: rateSource } = await this.rateFor(id);
    const tolerance = {
      settle_tolerance_iqd: await this.settings.get('settle_tolerance_iqd'),
      settle_tolerance_usd_cents: await this.settings.get('settle_tolerance_usd_cents'),
    };

    return this.database.transaction(async (tx) => {
      const customer = await this.lockFor(tx, id);
      const order = input.order_id ? await this.orderFor(tx, input.order_id, customer.id) : null;
      const performedBy = input.performed_by ?? context.userId;
      const results: WriteResultDto[] = [];

      if (input.split && input.split.length > 0) {
        // Proposed — not requested (FR-617): two rows, one note, so the cash-up sees both
        // currencies exactly as they were handed over.
        for (const part of input.split) {
          const money = completePair({
            amount: -Math.abs(part.amount),
            currency: part.currency,
            rate,
            rate_source: rateSource,
            other_amount:
              part.other_amount === undefined || part.other_amount === null
                ? undefined
                : -Math.abs(part.other_amount),
          });
          results.push(
            await this.writeMoneyRow(context, tx, customer, {
              entry_type: 'payment',
              money,
              entry_date: input.entry_date,
              note: input.note ?? null,
              order_id: input.order_id ?? null,
              performed_by_user_id: performedBy,
              method: input.method ?? 'cash',
              voucher: true,
            }),
          );
        }
        return this.withOrderStatus(tx, results, input.order_id ?? null, customer);
      }

      if (input.settle_in_full) {
        const remaining = order
          ? order.remaining
          : balanceOf(await this.ledger.entriesFor(tx, customer.id), customer.settlement_currency);
        if (remaining <= 0) {
          throw ApiError.validation([
            {
              path: 'settle_in_full',
              code: 'NOTHING_OWED',
              message_key: 'errors:nothing_owed',
              params: {},
            },
          ]);
        }

        let settlement;
        try {
          settlement = settleInFull({
            remaining,
            settlement_currency: customer.settlement_currency,
            received_currency: input.currency,
            received_amount: Math.abs(input.amount),
            rate,
            rate_source: rateSource,
            tolerance,
          });
        } catch {
          // A difference bigger than the tolerance is not a rate: it is a discount or a
          // credit, and the form says so rather than quietly inventing one (FR-606).
          throw new ApiError('RECEIVED_AMOUNT_OUT_OF_TOLERANCE', {
            remaining,
            settlement_currency: customer.settlement_currency,
            received_currency: input.currency,
            received_amount: Math.abs(input.amount),
          });
        }

        results.push(
          await this.writeMoneyRow(context, tx, customer, {
            entry_type: 'payment',
            // The entered currency is what the customer physically handed over, which is what
            // the daily cash-up counts (FR-604, FR-1013) — even though the settlement side
            // carries the exact remainder.
            money: { ...settlement.entry, entered_currency: input.currency },
            entry_date: input.entry_date,
            note: input.note ?? null,
            order_id: input.order_id ?? null,
            performed_by_user_id: performedBy,
            method: input.method ?? 'cash',
            voucher: true,
          }),
        );

        if (settlement.kind === 'payment_with_residue' && !pairIsEmpty(settlement.residue)) {
          results.push(
            await this.writeMoneyRow(context, tx, customer, {
              entry_type: 'credit',
              money: settlement.residue,
              entry_date: input.entry_date,
              note: 'settlement tolerance',
              order_id: input.order_id ?? null,
              performed_by_user_id: performedBy,
              method: null,
              voucher: false,
            }),
          );
        }

        return this.withOrderStatus(tx, results, input.order_id ?? null, customer);
      }

      const received = Math.abs(input.amount);
      if (order) {
        const receivedInSettlement =
          input.currency === customer.settlement_currency
            ? received
            : convert(received, input.currency, rate);
        if (receivedInSettlement > order.remaining && !input.allow_excess) {
          throw ApiError.validation([
            {
              path: 'amount',
              code: 'EXCEEDS_REMAINING',
              message_key: 'errors:payment_exceeds_remaining',
              params: { remaining: order.remaining, currency: customer.settlement_currency },
            },
          ]);
        }
      }

      const money = completePair({
        amount: -received,
        currency: input.currency,
        rate,
        rate_source: rateSource,
        other_amount:
          input.other_amount === undefined || input.other_amount === null
            ? undefined
            : -Math.abs(input.other_amount),
      });

      results.push(
        await this.writeMoneyRow(context, tx, customer, {
          entry_type: 'payment',
          money,
          entry_date: input.entry_date,
          note: input.note ?? null,
          order_id: input.order_id ?? null,
          performed_by_user_id: performedBy,
          method: input.method ?? 'cash',
          voucher: true,
        }),
      );

      return this.withOrderStatus(tx, results, input.order_id ?? null, customer);
    });
  }

  /**
   * Credit (reduces what the customer owes), refund (money handed back, so they owe it again),
   * adjustment (a signed correction) and the opening balance at go-live. All four require a
   * note, and none of them is ever edited: a mistake is reversed (FR-504, FR-506).
   */
  async recordEntry(
    context: RequestContext,
    id: string,
    kind: 'credit' | 'refund' | 'adjustment' | 'opening',
    input: LedgerEntryInput,
  ): Promise<WriteResultDto> {
    this.period.assertNotFuture(input.entry_date, 'entry_date');
    await this.requireCustomer(context, id);
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

    const { rate, source: rateSource } = await this.rateFor(id);

    return this.database.transaction(async (tx) => {
      const customer = await this.lockFor(tx, id);
      if (input.order_id) await this.orderFor(tx, input.order_id, customer.id);
      if (input.damage_id) await this.assertDamageOfCustomer(tx, input.damage_id, customer.id);

      // Signs follow the ledger's convention: positive increases what the customer owes.
      const magnitude = Math.abs(input.amount);
      const signed = kind === 'credit' ? -magnitude : kind === 'refund' ? magnitude : input.amount;

      const money = completePair({
        amount: signed,
        currency: input.currency,
        rate,
        rate_source: rateSource,
        other_amount:
          input.other_amount === undefined || input.other_amount === null
            ? undefined
            : signed < 0
              ? -Math.abs(input.other_amount)
              : Math.abs(input.other_amount),
      });

      const result = await this.writeMoneyRow(context, tx, customer, {
        entry_type: kind,
        money,
        entry_date: input.entry_date,
        note: input.note,
        order_id: input.order_id ?? null,
        damage_id: input.damage_id ?? null,
        performed_by_user_id: input.performed_by ?? context.userId,
        method: kind === 'refund' ? (input.method ?? 'cash') : null,
        // A refund is money leaving the till, so it gets a voucher like a payment (FR-614).
        voucher: kind === 'refund',
      });

      const [withStatus] = await this.withOrderStatus(
        tx,
        [result],
        input.order_id ?? null,
        customer,
      );
      return withStatus as WriteResultDto;
    });
  }

  /**
   * Reversing a money row (2.4.1 rule 3). Correcting one's own payment on the same day needs
   * only `orders.record_payment`; anything older, or somebody else's, is an admin's call
   * (FR-606) — because by then the figure has been read in a report or handed to a customer.
   */
  async reverseEntry(
    context: RequestContext,
    id: string,
    entryId: string,
    input: { note: string; entry_date?: string },
  ): Promise<WriteResultDto> {
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
    await this.requireCustomer(context, id);

    return this.database.transaction(async (tx) => {
      const customer = await this.lockFor(tx, id);
      const entries = await this.ledger.entriesFor(tx, id);
      const target = entries.find((entry) => entry.id === entryId);
      if (!target) throw ApiError.notFound();

      const ownSameDay =
        target.created_by === context.userId && target.entry_date === this.period.today();
      if (!ownSameDay && context.role !== 'admin') {
        throw ApiError.permissionDenied('admin');
      }

      const result = await this.ledger.reverse(context, tx, customer, entryId, {
        note: input.note,
        entry_date: input.entry_date,
        related: { customer_id: id },
      });

      const orderId = (target.refs.order_id as string | null) ?? null;
      const [withStatus] = await this.withOrderStatus(
        tx,
        [toWriteResult(result)],
        orderId,
        customer,
      );
      return withStatus as WriteResultDto;
    });
  }

  async historyOf(
    context: RequestContext,
    id: string,
    options: { cursor?: string; limit?: number },
  ) {
    await this.requireCustomer(context, id);
    return this.history.list({ about_party: id, ...options });
  }

  /**
   * The account statement (FR-615, Proposed — not requested): opening balance, the entries of
   * the range in posting order, and the closing balance. The API returns the figures; the
   * client renders and shares the page, so there is no server-side PDF stack to maintain
   * (D-014).
   */
  async statement(
    context: RequestContext,
    id: string,
    range: { from?: string; to?: string },
  ): Promise<{
    customer: { id: string; name: string; settlement_currency: Currency; phone: string | null };
    from: string | null;
    to: string | null;
    opening_balance: number;
    closing_balance: number;
    items: LedgerGroupDto[];
    /** Every row in the range, even when only the most recent `STATEMENT_ITEM_CAP` are sent. */
    item_count: number;
    has_more: boolean;
  }> {
    const row = await this.requireCustomer(context, id);
    if (row.is_system) throw ApiError.notFound();

    const customer: LedgerCustomer = {
      id: row.id,
      name: row.name,
      settlement_currency: row.settlement_currency,
    };
    const { groups, entries } = await this.ledger.groupsFor(this.database, customer);
    const names = await this.userNames(entries);

    const opening = range.from
      ? entries
          .filter((entry) => entry.entry_date < (range.from as string))
          .reduce((total, entry) => total + amountIn(entry, row.settlement_currency), 0)
      : 0;

    const inRange = groups.filter((group) => {
      const date = group.anchor.entry.entry_date;
      if (range.from && date < range.from) return false;
      if (range.to && date > range.to) return false;
      return !group.hidden_by_default;
    });

    const closing = range.to
      ? balanceAsOf(entries, row.settlement_currency, range.to)
      : balanceOf(entries, row.settlement_currency);

    return {
      customer: {
        id: row.id,
        name: row.name,
        settlement_currency: row.settlement_currency,
        phone: row.phone,
      },
      from: range.from ?? null,
      to: range.to ?? null,
      opening_balance: opening,
      closing_balance: closing,
      // The most recent rows, because a statement is read from its end: the older ones are
      // already in the opening balance, which is exact either way.
      items: inRange.slice(-STATEMENT_ITEM_CAP).map((group) => toGroupDto(group, names)),
      item_count: inRange.length,
      has_more: inRange.length > STATEMENT_ITEM_CAP,
    };
  }

  /**
   * One payment voucher (FR-614, Proposed — not requested). A reversed row's voucher says
   * "cancelled" rather than disappearing, because the paper copy is already in a drawer.
   */
  async voucher(
    context: RequestContext,
    id: string,
    entryId: string,
  ): Promise<{
    voucher_number: number | null;
    entry_type: string;
    entry_date: string;
    amount_iqd: number;
    amount_usd_cents: number;
    entered_currency: Currency | null;
    rate_iqd_per_usd: Rate;
    method: string | null;
    note: string | null;
    performed_by_name: string | null;
    balance_after: number;
    is_cancelled: boolean;
    customer: { id: string; name: string; settlement_currency: Currency; phone: string | null };
  }> {
    const row = await this.requireCustomer(context, id);
    const customer: LedgerCustomer = {
      id: row.id,
      name: row.name,
      settlement_currency: row.settlement_currency,
    };
    const { groups, entries } = await this.ledger.groupsFor(this.database, customer, { raw: true });
    const group = groups.find((candidate) => candidate.anchor.entry.id === entryId);
    if (!group) throw ApiError.notFound();

    const entry = group.anchor.entry;
    const names = await this.userNames(entries);
    return {
      voucher_number: entry.voucher_number ?? null,
      entry_type: entry.entry_type,
      entry_date: entry.entry_date,
      amount_iqd: entry.amount_iqd,
      amount_usd_cents: entry.amount_usd_cents,
      entered_currency: entry.entered_currency,
      rate_iqd_per_usd: entry.rate_iqd_per_usd,
      method: entry.method ?? null,
      note: entry.note,
      performed_by_name: entry.performed_by_user_id
        ? (names.get(entry.performed_by_user_id) ?? null)
        : null,
      balance_after: group.anchor.balance_after,
      is_cancelled: entries.some((candidate) => candidate.reverses_entry_id === entry.id),
      customer: {
        id: row.id,
        name: row.name,
        settlement_currency: row.settlement_currency,
        phone: row.phone,
      },
    };
  }

  /** Locks the customer for a money write, which is where every balance figure starts (2.9.5). */
  private async lockFor(tx: Db, id: string): Promise<LedgerCustomer> {
    const customer = await this.ledger.lockOwner(tx, id);
    if (!customer) throw ApiError.notFound();
    return customer;
  }

  /** The order a payment names, and what is still owed on it (FR-607). */
  private async orderFor(
    tx: Db,
    orderId: string,
    customerId: string,
  ): Promise<{ id: string; remaining: number; total: number; status: string }> {
    const { rows } = await tx.query<{
      order_id: string;
      remaining: string;
      total: string;
      status: string;
      customer_id: string;
      doc_status: string;
    }>(
      `SELECT b.order_id, b.remaining::text AS remaining, b.total::text AS total, b.status,
              b.customer_id, o.status::text AS doc_status
         FROM order_balances b
         JOIN orders o ON o.id = b.order_id
        WHERE b.order_id = $1`,
      [orderId],
    );
    const row = rows[0];
    if (!row || row.customer_id !== customerId) throw ApiError.notFound();
    if (row.doc_status === 'void') {
      throw new ApiError('DOCUMENT_VOID', { order_id: orderId });
    }
    return {
      id: row.order_id,
      remaining: Number(row.remaining),
      total: Number(row.total),
      status: row.status,
    };
  }

  private async writeMoneyRow(
    context: RequestContext,
    tx: Db,
    customer: LedgerCustomer,
    input: {
      entry_type: string;
      money: MoneyPair;
      entry_date: string;
      note: string | null;
      order_id?: string | null;
      damage_id?: string | null;
      performed_by_user_id: string;
      method: string | null;
      voucher: boolean;
    },
  ): Promise<WriteResultDto> {
    const result = await this.ledger.write(
      context,
      tx,
      customer,
      {
        entry_type: input.entry_type,
        money: input.money,
        entry_date: input.entry_date,
        note: input.note,
        performed_by_user_id: input.performed_by_user_id,
        refs: { order_id: input.order_id ?? null, damage_id: input.damage_id ?? null },
        method: input.method,
        assign_voucher_number: input.voucher,
      },
      { audit_note: input.note, related: { customer_id: customer.id } },
    );
    return toWriteResult(result);
  }

  /**
   * Adds the order's new remaining and status to the results of a write (FR-607).
   *
   * It reads the status without refusing a voided order: reversing a payment that belongs to
   * an order which was voided afterwards is exactly what an admin does when the money is
   * handed back, and the answer should carry that order's state, not an error.
   */
  private async withOrderStatus(
    tx: Db,
    results: WriteResultDto[],
    orderId: string | null,
    customer: LedgerCustomer,
  ): Promise<WriteResultDto[]> {
    if (!orderId) return results;
    const order = await this.orderStatusOf(tx, orderId, customer.id);
    if (!order) return results;
    return results.map((result) => ({
      ...result,
      order: { id: order.id, remaining: order.remaining, status: order.status },
    }));
  }

  /** The order's derived state, whether it is active or void (2.4.3). */
  private async orderStatusOf(
    tx: Db,
    orderId: string,
    customerId: string,
  ): Promise<{ id: string; remaining: number; total: number; status: string } | null> {
    const { rows } = await tx.query<{
      order_id: string;
      remaining: string;
      total: string;
      status: string;
      customer_id: string;
    }>(
      `SELECT order_id, remaining::text AS remaining, total::text AS total, status, customer_id
         FROM order_balances WHERE order_id = $1`,
      [orderId],
    );
    const row = rows[0];
    if (!row || row.customer_id !== customerId) return null;
    return {
      id: row.order_id,
      remaining: Number(row.remaining),
      total: Number(row.total),
      status: row.status,
    };
  }

  private async versionConflict(id: string): Promise<ApiError> {
    const current = await this.customers.findByIdUnscoped(id);
    return new ApiError('VERSION_CONFLICT', {
      entity: 'customer',
      version: current?.version ?? null,
    });
  }

  // ─────────────────────────────── rates ───────────────────────────────

  /** The customer's rate history — the current rate and every rate before it. */
  async rateHistoryOf(context: RequestContext, id: string) {
    await this.requireCustomer(context, id);
    const [current, history] = await Promise.all([
      this.customers.currentRate(id),
      this.customers.rateHistory(id),
    ]);
    return {
      current: current
        ? { rate_iqd_per_usd: formatRate(current.rate), since: current.since.toISOString() }
        : null,
      items: history.map((row) => ({
        id: row.id,
        rate_iqd_per_usd: formatRate(row.rate_iqd_per_usd),
        effective_from: row.effective_from.toISOString(),
        note: row.note,
        created_by_name: row.created_by_name,
      })),
    };
  }

  /**
   * A side may be switched off only while nothing on it names the record: a customer with orders
   * or selling-side entries stays a customer, a supplier with purchases, buying-side entries or
   * damage returns stays a supplier. Otherwise the record would own documents it no longer shows.
   */
  private async assertSidesStillFree(
    before: CustomerRow,
    sides: { is_customer: boolean; is_supplier: boolean },
    tx: Db,
  ): Promise<void> {
    const checks: { off: boolean; path: string; sql: string }[] = [
      {
        off: before.is_customer && !sides.is_customer,
        path: 'is_customer',
        sql: `SELECT EXISTS (SELECT 1 FROM orders WHERE customer_id = $1)
                  OR EXISTS (SELECT 1 FROM customer_ledger WHERE customer_id = $1) AS used`,
      },
      {
        off: before.is_supplier && !sides.is_supplier,
        path: 'is_supplier',
        sql: `SELECT EXISTS (SELECT 1 FROM purchases WHERE company_id = $1)
                  OR EXISTS (SELECT 1 FROM company_ledger WHERE company_id = $1)
                  OR EXISTS (SELECT 1 FROM damages WHERE company_id = $1) AS used`,
      },
    ];
    for (const check of checks) {
      if (!check.off) continue;
      const { rows } = await tx.query<{ used: boolean }>(check.sql, [before.id]);
      if (rows[0]?.used) {
        throw ApiError.validation([
          { path: check.path, code: 'SIDE_IN_USE', message_key: 'errors:customer_side_in_use', params: {} },
        ]);
      }
    }
  }

  /** Give the business its own IQD-per-USD rate (append-only — never edited, D-054). */
  async setRate(
    context: RequestContext,
    id: string,
    input: { rate_iqd_per_usd: string; note?: string | null },
  ): Promise<{ rate_iqd_per_usd: Rate; since: string }> {
    const row = await this.requireCustomer(context, id);
    // One rate per business (D-054): either side's permission may set it, for a record on that side.
    const mayRate =
      (row.is_customer && can(context, 'customers.set_rate')) ||
      (row.is_supplier && can(context, 'companies.set_rate'));
    if (!mayRate) {
      throw ApiError.permissionDenied(row.is_customer ? 'customers.set_rate' : 'companies.set_rate');
    }
    const rate = formatRate(input.rate_iqd_per_usd);
    if (Number(rate) <= 0) {
      throw ApiError.validation([
        { path: 'rate_iqd_per_usd', code: 'INVALID', message_key: 'errors:field.required', params: {} },
      ]);
    }

    const previous = await this.customers.currentRate(id);
    return this.database.transaction(async (tx) => {
      await this.customers.insertRate(
        { customer_id: id, rate, note: input.note?.trim() || null, created_by: context.userId },
        tx,
      );
      await this.audit.record(
        context,
        {
          action: 'rate_change',
          entity_type: 'customer',
          entity_id: id,
          entity_label: `Customer: ${row.name}`,
          changes: {
            rate_iqd_per_usd: { old: previous ? formatRate(previous.rate) : null, new: rate },
          },
          note: input.note?.trim() || null,
          related: { customer_id: id },
        },
        tx,
      );
      return { rate_iqd_per_usd: rate, since: new Date().toISOString() };
    });
  }
}

function pairIsEmpty(pair: MoneyPair): boolean {
  return pair.amount_iqd === 0 && pair.amount_usd_cents === 0;
}

function toWriteResult(result: {
  entry: LedgerEntry;
  balance: { before: number; after: number; currency: Currency };
}): WriteResultDto {
  return {
    entry_id: result.entry.id,
    entry_type: result.entry.entry_type,
    amount_iqd: result.entry.amount_iqd,
    amount_usd_cents: result.entry.amount_usd_cents,
    voucher_number: result.entry.voucher_number ?? null,
    balance_before: result.balance.before,
    balance_after: result.balance.after,
    currency: result.balance.currency,
  };
}

function toGroupDto(group: LedgerGroup, names: Map<string, string>): LedgerGroupDto {
  const entry = group.anchor.entry;
  return {
    kind: group.kind,
    entry_id: entry.id,
    entry_type: entry.entry_type,
    entry_date: entry.entry_date,
    amount_iqd: group.amount_iqd,
    amount_usd_cents: group.amount_usd_cents,
    entered_currency: entry.entered_currency,
    rate_iqd_per_usd: entry.rate_iqd_per_usd,
    rate_source: entry.rate_source,
    balance_after: group.anchor.balance_after,
    note: entry.note,
    order_id: group.order_id,
    performed_by_user_id: entry.performed_by_user_id,
    performed_by_name: entry.performed_by_user_id
      ? (names.get(entry.performed_by_user_id) ?? null)
      : null,
    voucher_number: entry.voucher_number ?? null,
    method: entry.method ?? null,
    received_currency: group.received_currency,
    hidden_by_default: group.hidden_by_default,
    created_at: entry.created_at.toISOString(),
    rows: group.rows.map((row) => ({
      id: row.entry.id,
      entry_type: row.entry.entry_type,
      entry_date: row.entry.entry_date,
      amount_iqd: row.entry.amount_iqd,
      amount_usd_cents: row.entry.amount_usd_cents,
      note: row.entry.note,
      balance_after: row.balance_after,
      created_at: row.entry.created_at.toISOString(),
      performed_by_name: row.entry.performed_by_user_id
        ? (names.get(row.entry.performed_by_user_id) ?? null)
        : null,
    })),
  };
}

function toCustomerDto(
  row: CustomerRow,
  extra: {
    assigned_user_name: string | null;
    balance: number;
    payable: number;
    rate: CustomerRateInfo | null;
    sight: { selling: boolean; buying: boolean };
  },
): CustomerDto {
  const rateValue = extra.rate?.rate_iqd_per_usd ?? null;
  // The settlement currency carries the fact; the other side is a conversion at the business's
  // own rate (or the global one), which the client renders with "≈".
  const asBalance = (amount: number): BalanceDto | null =>
    rateValue === null
      ? null
      : {
          amount_iqd: row.settlement_currency === 'IQD' ? amount : convert(amount, 'USD', rateValue),
          amount_usd_cents:
            row.settlement_currency === 'USD' ? amount : convert(amount, 'IQD', rateValue),
          currency: row.settlement_currency,
          rate_iqd_per_usd: rateValue,
          kind: 'derived',
        };
  const balance = asBalance(extra.balance);

  return {
    rate: extra.rate,
    id: row.id,
    name: row.name,
    contact_name: row.contact_name,
    is_customer: row.is_customer,
    is_supplier: row.is_supplier,
    phone: row.phone,
    address: row.address,
    notes: row.notes,
    settlement_currency: row.settlement_currency,
    assigned_user_id: row.assigned_user_id,
    assigned_user_name: extra.assigned_user_name,
    is_system: row.is_system,
    credit_limit:
      row.credit_limit_iqd === null || row.credit_limit_usd_cents === null
        ? null
        : {
            amount_iqd: Number(row.credit_limit_iqd),
            amount_usd_cents: Number(row.credit_limit_usd_cents),
          },
    is_active: row.is_active,
    balance,
    payable: row.is_supplier && extra.sight.buying ? asBalance(extra.payable) : null,
    net:
      extra.sight.selling && extra.sight.buying ? asBalance(extra.balance - extra.payable) : null,
    version: row.version,
  };
}

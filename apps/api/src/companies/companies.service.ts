import { Injectable } from '@nestjs/common';
import { completePair, convert, formatRate, settleInFull } from '@mizan/money';
import type { Currency, MoneyPair, Rate, RateSource } from '@mizan/money';
import { allocateOldestFirst, balanceAsOf, balanceOf } from '@mizan/ledger';
import { normalizeForSearch } from '@mizan/text';
import type { AllocationResult, LedgerEntry, LedgerGroup } from '@mizan/ledger';
import { AuditService, diffOf } from '../audit/audit.service.js';
import { ApiError } from '../common/errors.js';
import { can } from '../common/request-context.js';
import type { RequestContext } from '../common/request-context.js';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';
import { HistoryRepository } from '../history/history.repository.js';
import { CompanyLedgerService } from '../ledger/company-ledger.service.js';
import type { LedgerAccount } from '../ledger/account-ledger.service.js';
import { RatesService } from '../rates/rates.service.js';
import { PeriodService } from '../settings/period.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { CompaniesRepository } from './companies.repository.js';
import type { CompanyFilters, CompanyListRow, CompanyRow } from './companies.repository.js';

export interface MoneyInput {
  amount: number;
  currency: Currency;
  /** The calculated side, when the user overwrote it — stored as a manual rate (2.3.2). */
  other_amount?: number | null;
}

export interface CreateCompanyInput {
  name: string;
  contact_name?: string | null;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
  settlement_currency?: Currency;
  assigned_user_id?: string | null;
}

export interface CompanyPaymentInput extends MoneyInput {
  purchase_id?: string | null;
  entry_date: string;
  /** Writes the exact remaining balance with what was paid as a manual pair (FR-705). */
  settle_in_full?: boolean;
  performed_by?: string | null;
  /** Proposed — not requested (FR-617). */
  method?: 'cash' | 'transfer' | 'other' | null;
  split?: MoneyInput[] | null;
  note?: string | null;
}

export interface CompanyEntryInput extends MoneyInput {
  entry_date: string;
  note: string;
  purchase_id?: string | null;
  damage_id?: string | null;
  performed_by?: string | null;
  method?: 'cash' | 'transfer' | 'other' | null;
}

/** FR-706 lets the accountant type either the new balance or the change; one becomes the other. */
export interface AdjustmentInput {
  new_balance?: number | null;
  delta?: number | null;
  currency: Currency;
  other_amount?: number | null;
  entry_date: string;
  note: string;
  purchase_id?: string | null;
}

export interface CompanyBalanceDto {
  amount_iqd: number;
  amount_usd_cents: number;
  currency: Currency;
  rate_iqd_per_usd: Rate;
  kind: 'derived';
}

export interface CompanyDto {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  settlement_currency: Currency;
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  is_active: boolean;
  /** The company's own rate, with "since", or null when it falls back to the global one. */
  rate: { rate_iqd_per_usd: Rate; since: string; is_company_rate: boolean } | null;
  /** Stripped for a caller without `fields.see_company_balances` (FR-704). */
  balance: CompanyBalanceDto | null;
  version: number;
}

export interface CompanyWriteResultDto {
  entry_id: string;
  entry_type: string;
  amount_iqd: number;
  amount_usd_cents: number;
  voucher_number: number | null;
  balance_before: number;
  balance_after: number;
  currency: Currency;
}

/**
 * Companies and supplier accounting (FR-701 to FR-712).
 *
 * The money rules are the customer side's, with one difference that runs through everything:
 * a company keeps **its own** rate, so every calculated amount here is filled at that rate and
 * not at the global one (2.3.3) — and a rate change never touches a stored entry.
 */
@Injectable()
export class CompaniesService {
  constructor(
    private readonly database: Database,
    private readonly companies: CompaniesRepository,
    private readonly ledger: CompanyLedgerService,
    private readonly rates: RatesService,
    private readonly period: PeriodService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly history: HistoryRepository,
  ) {}

  async list(context: RequestContext, filters: CompanyFilters): Promise<{ items: CompanyDto[]; total: number }> {
    const { rows, total } = await this.companies.list(filters);
    const globalRate = await this.rates.current();
    return {
      items: rows.map((row) => toCompanyDtoFromListRow(row, globalRate?.rate_iqd_per_usd ?? null)),
      total,
    };
  }

  async get(id: string): Promise<CompanyDto> {
    const row = await this.requireCompany(id);
    return this.detailOf(row);
  }

  private async requireCompany(id: string, tx?: Db): Promise<CompanyRow> {
    const row = await this.companies.findById(id, tx);
    if (!row) throw ApiError.notFound();
    return row;
  }

  private async detailOf(row: CompanyRow, tx?: Db): Promise<CompanyDto> {
    const db = tx ?? this.database;
    const [balance, companyRate, globalRate, assignee] = await Promise.all([
      this.companies.balanceOf(row.id, db),
      this.companies.currentRate(row.id, db),
      this.rates.current(db),
      this.assigneeName(db, row.assigned_user_id),
    ]);

    const rate = companyRate
      ? { rate_iqd_per_usd: formatRate(companyRate.rate), since: companyRate.since.toISOString(), is_company_rate: true }
      : globalRate
        ? {
            rate_iqd_per_usd: globalRate.rate_iqd_per_usd,
            since: globalRate.effective_from,
            is_company_rate: false,
          }
        : null;

    return {
      id: row.id,
      name: row.name,
      contact_name: row.contact_name,
      phone: row.phone,
      address: row.address,
      notes: row.notes,
      settlement_currency: row.settlement_currency,
      assigned_user_id: row.assigned_user_id,
      assigned_user_name: assignee,
      is_active: row.is_active,
      rate,
      balance: rate ? toBalance(balance, row.settlement_currency, rate.rate_iqd_per_usd) : null,
      version: row.version,
    };
  }

  private async assigneeName(db: Db, userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const { rows } = await db.query<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [
      userId,
    ]);
    return rows[0]?.display_name ?? null;
  }

  /**
   * The rate every calculated amount for this company is filled at: the company's own rate,
   * else the global one, and the interface says which (2.3.3, FR-703).
   */
  async rateFor(id: string, tx?: Db): Promise<{ rate: Rate; source: RateSource }> {
    const own = await this.companies.currentRate(id, tx);
    if (own) return { rate: formatRate(own.rate), source: 'company' };
    return { rate: await this.rates.requireCurrent(tx), source: 'global' };
  }

  async create(context: RequestContext, input: CreateCompanyInput): Promise<CompanyDto> {
    const name = input.name.trim();
    const existing = await this.companies.findByNormalizedName(normalizeForSearch(name));
    if (existing) {
      // Unlike a customer, a company name is unique: two rows for one supplier would split the
      // account it exists to keep (FR-701).
      throw ApiError.validation([
        {
          path: 'name',
          code: 'DUPLICATE_NAME',
          message_key: 'errors:duplicate_company',
          params: { name: existing.name, id: existing.id },
        },
      ]);
    }

    const created = await this.database.transaction(async (tx) => {
      const row = await this.companies.create(
        {
          name,
          contact_name: input.contact_name?.trim() || null,
          phone: input.phone?.trim() || null,
          address: input.address?.trim() || null,
          notes: input.notes?.trim() || null,
          settlement_currency: input.settlement_currency ?? 'IQD',
          assigned_user_id: input.assigned_user_id ?? null,
          created_by: context.userId,
        },
        tx,
      );

      await this.audit.record(
        context,
        {
          action: 'create',
          entity_type: 'company',
          entity_id: row.id,
          entity_label: `Company: ${row.name}`,
          changes: {
            name: { old: null, new: row.name },
            settlement_currency: { old: null, new: row.settlement_currency },
            assigned_user_id: { old: null, new: row.assigned_user_id },
          },
          related: { company_id: row.id, assigned_user_id: row.assigned_user_id },
        },
        tx,
      );
      return row;
    });

    return this.detailOf(created);
  }

  async update(
    context: RequestContext,
    id: string,
    input: Partial<CreateCompanyInput> & { version: number },
  ): Promise<CompanyDto> {
    const updated = await this.database.transaction(async (tx) => {
      const before = await this.companies.lock(id, tx);
      if (!before) throw ApiError.notFound();

      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (normalizeForSearch(name) !== before.name_normalized) {
          const clash = await this.companies.findByNormalizedName(normalizeForSearch(name), tx);
          if (clash && clash.id !== id) {
            throw ApiError.validation([
              {
                path: 'name',
                code: 'DUPLICATE_NAME',
                message_key: 'errors:duplicate_company',
                params: { name: clash.name, id: clash.id },
              },
            ]);
          }
        }
        patch.name = name;
      }
      if (input.contact_name !== undefined) patch.contact_name = input.contact_name?.trim() || null;
      if (input.phone !== undefined) patch.phone = input.phone?.trim() || null;
      if (input.address !== undefined) patch.address = input.address?.trim() || null;
      if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;

      const row = await this.companies.update(id, input.version, patch, context.userId, tx);
      if (!row) throw await this.versionConflict(id);

      const changes = diffOf({ ...before } as Record<string, unknown>, patch, [
        'name',
        'contact_name',
        'phone',
        'address',
        'notes',
      ]);
      if (Object.keys(changes).length > 0) {
        await this.audit.record(
          context,
          {
            action: 'update',
            entity_type: 'company',
            entity_id: id,
            entity_label: `Company: ${row.name}`,
            changes,
            related: { company_id: id },
          },
          tx,
        );
      }
      return row;
    });

    return this.detailOf(updated);
  }

  /**
   * A company that still owes (or is owed) money may be deactivated, with a note: the debt
   * does not disappear because the relationship ended, and Payables keeps showing it (FR-710).
   */
  async setActive(
    context: RequestContext,
    id: string,
    isActive: boolean,
    input: { version: number; note?: string | null },
  ): Promise<CompanyDto> {
    const updated = await this.database.transaction(async (tx) => {
      const before = await this.companies.lock(id, tx);
      if (!before) throw ApiError.notFound();
      if (before.is_active === isActive) return before;

      const balance = await this.companies.balanceOf(id, tx);
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

      const row = await this.companies.update(id, input.version, { is_active: isActive }, context.userId, tx);
      if (!row) throw await this.versionConflict(id);

      await this.audit.record(
        context,
        {
          action: 'status_change',
          entity_type: 'company',
          entity_id: id,
          entity_label: `Company: ${row.name}`,
          changes: {
            is_active: { old: before.is_active, new: isActive },
            balance: { old: { amount: balance, currency: before.settlement_currency }, new: null },
          },
          note: input.note?.trim() || null,
          related: { company_id: id },
        },
        tx,
      );
      return row;
    });

    return this.detailOf(updated);
  }

  async softDelete(context: RequestContext, id: string, version: number): Promise<void> {
    await this.database.transaction(async (tx) => {
      const before = await this.companies.lock(id, tx);
      if (!before) throw ApiError.notFound();
      if (await this.companies.isReferenced(id, tx)) {
        throw ApiError.validation([
          { path: 'id', code: 'REFERENCED', message_key: 'errors:record_referenced', params: {} },
        ]);
      }

      const row = await this.companies.softDelete(id, version, context.userId, tx);
      if (!row) throw await this.versionConflict(id);

      await this.audit.record(
        context,
        {
          action: 'delete',
          entity_type: 'company',
          entity_id: id,
          entity_label: `Company: ${before.name}`,
          changes: { snapshot: { old: { ...before }, new: null } },
          related: { company_id: id },
        },
        tx,
      );
    });
  }

  /** Assignment is for filtering and reporting only; it scopes nothing (FR-711). */
  async assign(
    context: RequestContext,
    id: string,
    input: { user_id: string | null; note?: string | null; version?: number },
  ): Promise<CompanyDto> {
    const updated = await this.database.transaction(async (tx) => {
      const before = await this.companies.lock(id, tx);
      if (!before) throw ApiError.notFound();
      if (input.user_id) {
        const { rowCount } = await tx.query(
          'SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL AND is_active = true',
          [input.user_id],
        );
        if (!rowCount) {
          throw ApiError.validation([
            { path: 'user_id', code: 'NOT_FOUND', message_key: 'errors:field.required', params: {} },
          ]);
        }
      }

      const row = await this.companies.update(
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
          entity_type: 'company',
          entity_id: id,
          entity_label: `Company: ${row.name}`,
          changes: { assigned_user_id: { old: before.assigned_user_id, new: input.user_id } },
          note: input.note?.trim() || null,
          related: { company_id: id, assigned_user_id: input.user_id },
        },
        tx,
      );
      return row;
    });

    return this.detailOf(updated);
  }

  // ─────────────────────────────── the rate (FR-703) ───────────────────────────────

  async rateHistoryOf(id: string) {
    await this.requireCompany(id);
    const [current, history] = await Promise.all([
      this.companies.currentRate(id),
      this.companies.rateHistory(id),
    ]);
    return {
      current: current ? { rate_iqd_per_usd: formatRate(current.rate), since: current.since.toISOString() } : null,
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
   * A new rate takes effect immediately for new documents and never touches a stored one
   * (FR-703). A change beyond ±`rate_guard_percent` asks for confirmation: 13,100 instead of
   * 1,310 would quietly value every later purchase at a tenth of its worth.
   */
  async setRate(
    context: RequestContext,
    id: string,
    input: { rate_iqd_per_usd: string; note?: string | null; confirm?: boolean },
  ): Promise<{ rate_iqd_per_usd: Rate; since: string }> {
    const company = await this.requireCompany(id);
    const rate = formatRate(input.rate_iqd_per_usd);
    if (Number(rate) <= 0) {
      throw ApiError.validation([
        { path: 'rate_iqd_per_usd', code: 'INVALID', message_key: 'errors:field.required', params: {} },
      ]);
    }

    const previous = await this.companies.currentRate(id);
    if (previous && !input.confirm) {
      const guard = await this.settings.get('rate_guard_percent');
      const before = Number(formatRate(previous.rate));
      const change = Math.abs(Number(rate) - before) / before;
      if (change * 100 > guard) {
        throw new ApiError('RATE_GUARD', {
          previous: formatRate(previous.rate),
          next: rate,
          percent: Math.round(change * 100),
        });
      }
    }

    await this.database.transaction(async (tx) => {
      await this.companies.insertRate(
        { company_id: id, rate, note: input.note?.trim() || null, created_by: context.userId },
        tx,
      );
      await this.audit.record(
        context,
        {
          action: 'rate_change',
          entity_type: 'company',
          entity_id: id,
          entity_label: `Company: ${company.name}`,
          changes: {
            rate_iqd_per_usd: { old: previous ? formatRate(previous.rate) : null, new: rate },
          },
          note: input.note?.trim() || null,
          related: { company_id: id },
        },
        tx,
      );
    });

    const current = (await this.companies.currentRate(id)) as { rate: string; since: Date };
    return { rate_iqd_per_usd: formatRate(current.rate), since: current.since.toISOString() };
  }

  // ──────────────────────────── the accounting tab (FR-704) ────────────────────────────

  /**
   * The accounting tab (FR-704) with the filters of 2.9.3 — type, date range, who did it — and
   * a bound on how many rows come back.
   *
   * The running balance is still computed over the **whole** ledger in posting order, because
   * that is what makes it the same number History recorded (2.4.1 rule 5); the filters and the
   * limit decide only what is returned. Without the bound a supplier of fifteen years answers
   * this route with 1.7 MB of JSON to a phone, which is what the I2 review measured.
   */
  async ledgerOf(
    id: string,
    options: {
      raw?: boolean;
      money_only?: boolean;
      as_of?: string;
      include_undone?: boolean;
      type?: string;
      from?: string;
      to?: string;
      done_by?: string;
      limit?: number;
    },
  ): Promise<{
    company: { id: string; name: string; settlement_currency: Currency };
    balance: number;
    balance_as_of: number | null;
    items: LedgerGroupDto[];
    /** How many groups the filters matched, and whether the answer was cut at the limit. */
    total: number;
    has_more: boolean;
  }> {
    const row = await this.requireCompany(id);
    const account = toAccount(row);
    const { groups, entries } = await this.ledger.groupsFor(this.database, account, options);

    const matching = groups.filter((group) => {
      if (!options.include_undone && group.hidden_by_default) return false;
      const entry = group.anchor.entry;
      if (options.type && entry.entry_type !== options.type) return false;
      if (options.from && entry.entry_date < options.from) return false;
      if (options.to && entry.entry_date > options.to) return false;
      if (options.done_by && entry.performed_by_user_id !== options.done_by) return false;
      return true;
    });

    // Newest first on screen; the running balance was computed in posting order (2.4.1).
    const newestFirst = [...matching].reverse();
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const page = newestFirst.slice(0, limit);
    const names = await this.userNames(page.flatMap((group) => group.rows.map((line) => line.entry)));

    return {
      company: { id: row.id, name: row.name, settlement_currency: row.settlement_currency },
      balance: balanceOf(entries, row.settlement_currency),
      balance_as_of: options.as_of ? balanceAsOf(entries, row.settlement_currency, options.as_of) : null,
      items: page.map((group) => toGroupDto(group, names)),
      total: matching.length,
      has_more: newestFirst.length > page.length,
    };
  }

  /**
   * "How much we owe per purchase" (FR-712): explicit links first, then the oldest-first share
   * of everything unlinked, and the identity `Σ remaining + General = balance` — which the
   * kernel's property test pins (D-020).
   */
  async purchaseBreakdown(
    id: string,
    options: { limit?: number } = {},
  ): Promise<{
    settlement_currency: Currency;
    allocation: AllocationResult;
    purchases: { id: string; number: number; purchase_date: string; status: string }[];
    /** Active purchases the allocation leaves at nothing owing; they are not sent row by row. */
    settled_count: number;
    /** How many still owe something, and their total — so the identity is checkable as sent. */
    owing_count: number;
    owing_total: number;
  }> {
    const row = await this.requireCompany(id);
    const [entries, purchases] = await Promise.all([
      this.ledger.entriesFor(this.database, id),
      this.companies.purchasesForAllocation(id),
    ]);

    const allocation = allocateOldestFirst(
      entries,
      purchases.map((purchase) => ({
        id: purchase.id,
        total:
          row.settlement_currency === 'IQD' ? Number(purchase.total_iqd) : Number(purchase.total_usd_cents),
        purchase_date: purchase.purchase_date,
        voided: purchase.status === 'void',
        number: Number(purchase.number),
      })),
      row.settlement_currency,
    );

    // Only what is still owed travels, oldest first — which is the order the money goes out
    // in — and at most a page of it. A supplier of fifteen years whose payments lag has
    // hundreds of purchases with something left on them, and sending them all was a third of
    // a megabyte to a phone (measured in the I2 review). `owing_total` keeps the identity
    // checkable from the response even when the rows are cut: owing_total + general = balance.
    const owing = allocation.purchases.filter((purchase) => purchase.remaining !== 0);
    const owingTotal = owing.reduce((total, purchase) => total + purchase.remaining, 0);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const page = owing.slice(0, limit);
    const pageIds = new Set(page.map((purchase) => purchase.purchase_id));

    return {
      settlement_currency: row.settlement_currency,
      allocation: { ...allocation, purchases: page },
      purchases: purchases
        .filter((purchase) => pageIds.has(purchase.id))
        .map((purchase) => ({
          id: purchase.id,
          number: Number(purchase.number),
          purchase_date: purchase.purchase_date,
          status: purchase.status,
        })),
      settled_count: allocation.purchases.length - owing.length,
      owing_count: owing.length,
      owing_total: owingTotal,
    };
  }

  private async userNames(entries: readonly LedgerEntry[]): Promise<Map<string, string>> {
    const ids = [...new Set(entries.flatMap((entry) => [entry.performed_by_user_id, entry.created_by]))].filter(
      (id): id is string => Boolean(id),
    );
    if (ids.length === 0) return new Map();
    const { rows } = await this.database.query<{ id: string; display_name: string }>(
      'SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])',
      [ids],
    );
    return new Map(rows.map((row) => [row.id, row.display_name]));
  }

  // ──────────────────────────────── money (FR-705 to FR-708) ────────────────────────────────

  /**
   * A payment to a company (FR-705): typed in either currency, the other filled at the
   * company's rate and overridable, optionally linked to a purchase, and "settle in full" for
   * the last instalment so the account lands on zero rather than on five dinars of residue.
   */
  async recordPayment(
    context: RequestContext,
    id: string,
    input: CompanyPaymentInput,
  ): Promise<CompanyWriteResultDto[]> {
    this.period.assertNotFuture(input.entry_date, 'entry_date');
    await this.period.assertNotLocked(input.entry_date);
    await this.requireCompany(id);

    const { rate, source } = await this.rateFor(id);
    const tolerance = {
      settle_tolerance_iqd: await this.settings.get('settle_tolerance_iqd'),
      settle_tolerance_usd_cents: await this.settings.get('settle_tolerance_usd_cents'),
    };

    return this.database.transaction(async (tx) => {
      const account = await this.lockFor(tx, id);
      if (input.purchase_id) await this.assertPurchaseOfCompany(tx, input.purchase_id, id);
      const performedBy = input.performed_by ?? context.userId;
      const results: CompanyWriteResultDto[] = [];

      if (input.split && input.split.length > 0) {
        // Proposed — not requested (FR-617): two rows, one note.
        for (const part of input.split) {
          results.push(
            await this.writeMoneyRow(context, tx, account, {
              entry_type: 'payment',
              money: completePair({
                amount: -Math.abs(part.amount),
                currency: part.currency,
                rate,
                rate_source: source,
                other_amount:
                  part.other_amount === undefined || part.other_amount === null
                    ? undefined
                    : -Math.abs(part.other_amount),
              }),
              entry_date: input.entry_date,
              note: input.note ?? null,
              purchase_id: input.purchase_id ?? null,
              performed_by_user_id: performedBy,
              method: input.method ?? 'cash',
              voucher: true,
            }),
          );
        }
        return results;
      }

      if (input.settle_in_full) {
        const remaining = input.purchase_id
          ? await this.purchaseRemaining(tx, input.purchase_id)
          : balanceOf(await this.ledger.entriesFor(tx, id), account.settlement_currency);
        if (remaining <= 0) {
          throw ApiError.validation([
            { path: 'settle_in_full', code: 'NOTHING_OWED', message_key: 'errors:nothing_owed', params: {} },
          ]);
        }

        let settlement;
        try {
          settlement = settleInFull({
            remaining,
            settlement_currency: account.settlement_currency,
            received_currency: input.currency,
            received_amount: Math.abs(input.amount),
            rate,
            rate_source: source,
            tolerance,
          });
        } catch {
          throw new ApiError('RECEIVED_AMOUNT_OUT_OF_TOLERANCE', {
            remaining,
            settlement_currency: account.settlement_currency,
            received_currency: input.currency,
            received_amount: Math.abs(input.amount),
          });
        }

        results.push(
          await this.writeMoneyRow(context, tx, account, {
            entry_type: 'payment',
            // The entered currency is the one the money physically left in, which is what the
            // cash-up counts (FR-1013), even though the settlement side is the exact remainder.
            money: { ...settlement.entry, entered_currency: input.currency },
            entry_date: input.entry_date,
            note: input.note ?? null,
            purchase_id: input.purchase_id ?? null,
            performed_by_user_id: performedBy,
            method: input.method ?? 'cash',
            voucher: true,
          }),
        );

        if (settlement.kind === 'payment_with_residue' && !pairIsEmpty(settlement.residue)) {
          // On the supplier side the residue is an **adjustment**, not a credit: the company
          // side has no credit note for a rounding difference (FR-705, 2.3.6).
          results.push(
            await this.writeMoneyRow(context, tx, account, {
              entry_type: 'adjustment',
              money: settlement.residue,
              entry_date: input.entry_date,
              note: 'settlement tolerance',
              purchase_id: input.purchase_id ?? null,
              performed_by_user_id: performedBy,
              method: null,
              voucher: false,
            }),
          );
        }

        return results;
      }

      results.push(
        await this.writeMoneyRow(context, tx, account, {
          entry_type: 'payment',
          money: completePair({
            amount: -Math.abs(input.amount),
            currency: input.currency,
            rate,
            rate_source: source,
            other_amount:
              input.other_amount === undefined || input.other_amount === null
                ? undefined
                : -Math.abs(input.other_amount),
          }),
          entry_date: input.entry_date,
          note: input.note ?? null,
          purchase_id: input.purchase_id ?? null,
          performed_by_user_id: performedBy,
          method: input.method ?? 'cash',
          voucher: true,
        }),
      );

      return results;
    });
  }

  /**
   * "Change how much you owe, with notes, with history" (FR-706) — the sentence specification
   * 2.4.2 maps onto three records. The accountant types either the new balance or the change;
   * whichever it is, the entry is the delta and History shows old → new.
   */
  async recordAdjustment(
    context: RequestContext,
    id: string,
    input: AdjustmentInput,
  ): Promise<CompanyWriteResultDto> {
    this.period.assertNotFuture(input.entry_date, 'entry_date');
    await this.period.assertNotLocked(input.entry_date);
    if (!input.note?.trim() || input.note.trim().length < 3) {
      throw ApiError.validation([
        { path: 'note', code: 'REQUIRED', message_key: 'errors:note_required_adjustment', params: {} },
      ]);
    }
    if ((input.new_balance ?? null) === null && (input.delta ?? null) === null) {
      throw ApiError.validation([
        { path: 'delta', code: 'REQUIRED', message_key: 'errors:field.required', params: {} },
      ]);
    }
    await this.requireCompany(id);

    const { rate, source } = await this.rateFor(id);

    return this.database.transaction(async (tx) => {
      const account = await this.lockFor(tx, id);
      if (input.purchase_id) await this.assertPurchaseOfCompany(tx, input.purchase_id, id);

      const balance = balanceOf(await this.ledger.entriesFor(tx, id), account.settlement_currency);
      // A new balance typed in the settlement currency becomes the delta that reaches it; a
      // delta typed in either currency is itself.
      const delta =
        input.new_balance !== null && input.new_balance !== undefined
          ? (input.currency === account.settlement_currency
              ? input.new_balance
              : convert(input.new_balance, input.currency, rate)) - balance
          : (input.delta as number);
      const currency =
        input.new_balance !== null && input.new_balance !== undefined
          ? account.settlement_currency
          : input.currency;

      if (delta === 0) {
        throw ApiError.validation([
          { path: 'delta', code: 'UNCHANGED', message_key: 'errors:adjustment_unchanged', params: {} },
        ]);
      }

      const money = completePair({
        amount: delta,
        currency,
        rate,
        rate_source: source,
        other_amount:
          input.other_amount === undefined || input.other_amount === null
            ? undefined
            : delta < 0
              ? -Math.abs(input.other_amount)
              : Math.abs(input.other_amount),
      });

      return this.writeMoneyRow(context, tx, account, {
        entry_type: 'adjustment',
        money,
        entry_date: input.entry_date,
        note: input.note.trim(),
        purchase_id: input.purchase_id ?? null,
        performed_by_user_id: context.userId,
        method: null,
        voucher: false,
      });
    });
  }

  /**
   * A credit (FR-707) reduces what we owe — goods went back — and an opening balance (FR-708)
   * is what we already owed at go-live. Both require a note, and neither is ever edited.
   */
  async recordEntry(
    context: RequestContext,
    id: string,
    kind: 'credit' | 'opening',
    input: CompanyEntryInput,
  ): Promise<CompanyWriteResultDto> {
    this.period.assertNotFuture(input.entry_date, 'entry_date');
    await this.period.assertNotLocked(input.entry_date);
    if (!input.note?.trim()) {
      throw ApiError.validation([
        { path: 'note', code: 'REQUIRED', message_key: 'errors:field.required', params: { field: 'note' } },
      ]);
    }
    await this.requireCompany(id);

    const { rate, source } = await this.rateFor(id);

    return this.database.transaction(async (tx) => {
      const account = await this.lockFor(tx, id);
      if (input.purchase_id) await this.assertPurchaseOfCompany(tx, input.purchase_id, id);
      if (input.damage_id) await this.assertDamageOfCompany(tx, input.damage_id, id);

      const signed = kind === 'credit' ? -Math.abs(input.amount) : input.amount;
      const money = completePair({
        amount: signed,
        currency: input.currency,
        rate,
        rate_source: source,
        other_amount:
          input.other_amount === undefined || input.other_amount === null
            ? undefined
            : signed < 0
              ? -Math.abs(input.other_amount)
              : Math.abs(input.other_amount),
      });

      return this.writeMoneyRow(context, tx, account, {
        entry_type: kind,
        money,
        entry_date: input.entry_date,
        note: input.note.trim(),
        purchase_id: input.purchase_id ?? null,
        damage_id: input.damage_id ?? null,
        performed_by_user_id: input.performed_by ?? context.userId,
        method: null,
        voucher: false,
      });
    });
  }

  /**
   * Reversing a money row (2.4.1 rule 3): one's own payment on the same day needs only
   * `companies.record_payment`; anything older, or somebody else's, is an admin's call, because
   * by then the figure has been read in a report or handed to a supplier.
   */
  async reverseEntry(
    context: RequestContext,
    id: string,
    entryId: string,
    input: { note: string; entry_date?: string },
  ): Promise<CompanyWriteResultDto> {
    if (!input.note?.trim()) {
      throw ApiError.validation([
        { path: 'note', code: 'REQUIRED', message_key: 'errors:field.required', params: { field: 'note' } },
      ]);
    }
    await this.requireCompany(id);

    return this.database.transaction(async (tx) => {
      const account = await this.lockFor(tx, id);
      const entries = await this.ledger.entriesFor(tx, id);
      const target = entries.find((entry) => entry.id === entryId);
      if (!target) throw ApiError.notFound();

      await this.period.assertNotLocked(target.entry_date);

      const ownSameDay = target.created_by === context.userId && target.entry_date === this.period.today();
      if (!ownSameDay && context.role !== 'admin') throw ApiError.permissionDenied('admin');

      const result = await this.ledger.reverse(context, tx, account, entryId, {
        note: input.note,
        entry_date: input.entry_date,
        related: { company_id: id },
      });
      return toWriteResult(result);
    });
  }

  /**
   * Changing the settlement currency (2.3.5, FR-702): always one re-basing entry, so the new
   * column is never a sum at mixed historical rates.
   */
  async setSettlementCurrency(
    context: RequestContext,
    id: string,
    input: { currency: Currency; note: string; rebase_rate?: string | null; version?: number },
  ): Promise<CompanyDto> {
    const updated = await this.database.transaction(async (tx) => {
      const before = await this.companies.lock(id, tx);
      if (!before) throw ApiError.notFound();
      if (before.settlement_currency === input.currency) {
        throw ApiError.validation([
          { path: 'currency', code: 'UNCHANGED', message_key: 'errors:field.required', params: {} },
        ]);
      }

      const account = toAccount(before);
      const entries = await this.ledger.entriesFor(tx, id);
      const balanceOld = balanceOf(entries, before.settlement_currency);
      const sumNewColumn = balanceOf(entries, input.currency);

      if (balanceOld !== 0 && !input.rebase_rate) {
        throw new ApiError('REBASE_RATE_REQUIRED', {
          balance: balanceOld,
          currency: before.settlement_currency,
        });
      }

      const rate = input.rebase_rate ?? (await this.rateFor(id, tx)).rate;
      const worthInNewCurrency = balanceOld === 0 ? 0 : convert(balanceOld, before.settlement_currency, rate);
      const delta = worthInNewCurrency - sumNewColumn;

      const money: MoneyPair = {
        amount_iqd: input.currency === 'IQD' ? delta : 0,
        amount_usd_cents: input.currency === 'USD' ? delta : 0,
        entered_currency: null,
        rate_iqd_per_usd: formatRate(rate),
        rate_source: 'manual',
      };

      const result = await this.ledger.write(
        context,
        tx,
        account,
        {
          entry_type: 'settlement_change',
          money,
          entry_date: this.period.today(),
          note: input.note,
          performed_by_user_id: context.userId,
        },
        { audit_note: input.note },
      );

      const row = await this.companies.update(
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
          entity_type: 'company',
          entity_id: id,
          entity_label: `Company: ${row.name}`,
          changes: {
            settlement_currency: { old: before.settlement_currency, new: input.currency },
            balance: {
              old: { amount: balanceOld, currency: before.settlement_currency },
              new: { amount: sumNewColumn + delta, currency: input.currency, rate: formatRate(rate) },
            },
          },
          note: input.note,
          related: { company_id: id, ledger_entry_id: result.entry.id },
        },
        tx,
      );
      return row;
    });

    return this.detailOf(updated);
  }

  async historyOf(id: string, options: { cursor?: string; limit?: number }) {
    await this.requireCompany(id);
    return this.history.list({ entity_type: 'company', entity_id: id, ...options });
  }

  /**
   * The statement figures (FR-615, Proposed — not requested); the client renders it (D-014).
   *
   * A statement is a document for a period, so when no period is given it covers the last
   * three months rather than the whole account — and it echoes the range it used, so the
   * screen can say what the supplier is being handed (D-025).
   */
  async statement(
    id: string,
    range: { from?: string; to?: string },
  ): Promise<{
    company: { id: string; name: string; settlement_currency: Currency; phone: string | null };
    from: string | null;
    to: string | null;
    opening_balance: number;
    closing_balance: number;
    items: LedgerGroupDto[];
  }> {
    const row = await this.requireCompany(id);
    const account = toAccount(row);
    const { groups, entries } = await this.ledger.groupsFor(this.database, account);
    const names = await this.userNames(entries);

    range = { from: range.from ?? this.period.monthsAgo(3), to: range.to };
    const opening = range.from
      ? entries
          .filter((entry) => entry.entry_date < (range.from as string))
          .reduce(
            (total, entry) =>
              total + (row.settlement_currency === 'IQD' ? entry.amount_iqd : entry.amount_usd_cents),
            0,
          )
      : 0;

    const inRange = groups.filter((group) => {
      const date = group.anchor.entry.entry_date;
      if (range.from && date < range.from) return false;
      if (range.to && date > range.to) return false;
      return !group.hidden_by_default;
    });

    return {
      company: {
        id: row.id,
        name: row.name,
        settlement_currency: row.settlement_currency,
        phone: row.phone,
      },
      from: range.from ?? null,
      to: range.to ?? null,
      opening_balance: opening,
      closing_balance: range.to
        ? balanceAsOf(entries, row.settlement_currency, range.to)
        : balanceOf(entries, row.settlement_currency),
      items: inRange.map((group) => toGroupDto(group, names)),
    };
  }

  /** One payment voucher (FR-614, Proposed — not requested). */
  async voucher(id: string, entryId: string) {
    const row = await this.requireCompany(id);
    const account = toAccount(row);
    const { groups, entries } = await this.ledger.groupsFor(this.database, account, { raw: true });
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
      performed_by_name: entry.performed_by_user_id ? names.get(entry.performed_by_user_id) ?? null : null,
      balance_after: group.anchor.balance_after,
      is_cancelled: entries.some((candidate) => candidate.reverses_entry_id === entry.id),
      company: {
        id: row.id,
        name: row.name,
        settlement_currency: row.settlement_currency,
        phone: row.phone,
      },
    };
  }

  // ───────────────────────────────── the pieces they share ─────────────────────────────────

  private async lockFor(tx: Db, id: string): Promise<LedgerAccount> {
    const account = await this.ledger.lockOwner(tx, id);
    if (!account) throw ApiError.notFound();
    return account;
  }

  private async assertPurchaseOfCompany(tx: Db, purchaseId: string, companyId: string): Promise<void> {
    const { rows } = await tx.query<{ company_id: string | null; status: string }>(
      `SELECT company_id, status::text AS status FROM purchases WHERE id = $1 AND deleted_at IS NULL`,
      [purchaseId],
    );
    const row = rows[0];
    if (!row || row.company_id !== companyId) throw ApiError.notFound();
    if (row.status === 'void') throw new ApiError('DOCUMENT_VOID', { purchase_id: purchaseId });
  }

  /**
   * What one purchase still owes, counting only the entries that name it (FR-712). The
   * oldest-first allocation is deliberately *not* used here: settling "this purchase in full"
   * means the amount actually tied to it, not a share of somebody's lump sum.
   */
  /**
   * A credit that names a damage record (FR-805) must name **this** company's record: the
   * goods went back to the supplier the record is attributed to, and a credit on anyone else's
   * account is a mis-typed id rather than an accounting decision.
   */
  private async assertDamageOfCompany(tx: Db, damageId: string, companyId: string): Promise<void> {
    const { rows } = await tx.query<{ status: string; company_id: string | null }>(
      `SELECT status::text AS status, company_id FROM damages
        WHERE id = $1 AND deleted_at IS NULL`,
      [damageId],
    );
    const row = rows[0];
    if (!row || row.company_id !== companyId) {
      throw ApiError.validation([
        { path: 'damage_id', code: 'NOT_FOUND', message_key: 'errors:field.required', params: {} },
      ]);
    }
    if (row.status === 'void') throw new ApiError('DOCUMENT_VOID', { damage_id: damageId });
  }

  private async purchaseRemaining(tx: Db, purchaseId: string): Promise<number> {
    const { rows } = await tx.query<{ total: string; linked: string }>(
      'SELECT total::text AS total, linked::text AS linked FROM purchase_linked_totals WHERE purchase_id = $1',
      [purchaseId],
    );
    const row = rows[0];
    if (!row) throw ApiError.notFound();
    return Number(row.total) + Number(row.linked);
  }

  private async writeMoneyRow(
    context: RequestContext,
    tx: Db,
    account: LedgerAccount,
    input: {
      entry_type: string;
      money: MoneyPair;
      entry_date: string;
      note: string | null;
      purchase_id?: string | null;
      damage_id?: string | null;
      performed_by_user_id: string;
      method: string | null;
      voucher: boolean;
    },
  ): Promise<CompanyWriteResultDto> {
    const result = await this.ledger.write(
      context,
      tx,
      account,
      {
        entry_type: input.entry_type,
        money: input.money,
        entry_date: input.entry_date,
        note: input.note,
        performed_by_user_id: input.performed_by_user_id,
        refs: { purchase_id: input.purchase_id ?? null, damage_id: input.damage_id ?? null },
        method: input.method,
        assign_voucher_number: input.voucher,
      },
      { audit_note: input.note, related: { company_id: account.id } },
    );
    return toWriteResult(result);
  }

  private async versionConflict(id: string): Promise<ApiError> {
    const current = await this.companies.findById(id);
    return new ApiError('VERSION_CONFLICT', { entity: 'company', version: current?.version ?? null });
  }

  /** Whether the caller may see any company money at all (FR-704). */
  canSeeBalances(context: RequestContext): boolean {
    return can(context, 'fields.see_company_balances');
  }
}

export interface LedgerGroupDto {
  kind: string;
  entry_id: string;
  entry_type: string;
  entry_date: string;
  amount_iqd: number;
  amount_usd_cents: number;
  entered_currency: Currency | null;
  rate_iqd_per_usd: Rate;
  rate_source: string;
  balance_after: number;
  note: string | null;
  purchase_id: string | null;
  performed_by_user_id: string | null;
  performed_by_name: string | null;
  voucher_number: number | null;
  method: string | null;
  hidden_by_default: boolean;
  created_at: string;
  rows: {
    id: string;
    entry_type: string;
    entry_date: string;
    amount_iqd: number;
    amount_usd_cents: number;
    note: string | null;
    balance_after: number;
    created_at: string;
    performed_by_name: string | null;
  }[];
}

function pairIsEmpty(pair: MoneyPair): boolean {
  return pair.amount_iqd === 0 && pair.amount_usd_cents === 0;
}

function toAccount(row: CompanyRow): LedgerAccount {
  return { id: row.id, name: row.name, settlement_currency: row.settlement_currency };
}

function toBalance(balance: number, currency: Currency, rate: Rate): CompanyBalanceDto {
  return {
    // The settlement currency carries the fact; the other side is today's conversion at the
    // company's own rate, which is why the client renders it with "≈" (2.3.6).
    amount_iqd: currency === 'IQD' ? balance : convert(balance, 'USD', rate),
    amount_usd_cents: currency === 'USD' ? balance : convert(balance, 'IQD', rate),
    currency,
    rate_iqd_per_usd: rate,
    kind: 'derived',
  };
}

function toWriteResult(result: {
  entry: LedgerEntry;
  balance: { before: number; after: number; currency: Currency };
}): CompanyWriteResultDto {
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
    purchase_id: (entry.refs.purchase_id as string | null) ?? null,
    performed_by_user_id: entry.performed_by_user_id,
    performed_by_name: entry.performed_by_user_id ? names.get(entry.performed_by_user_id) ?? null : null,
    voucher_number: entry.voucher_number ?? null,
    method: entry.method ?? null,
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
        ? names.get(row.entry.performed_by_user_id) ?? null
        : null,
    })),
  };
}

function toCompanyDtoFromListRow(row: CompanyListRow, globalRate: Rate | null): CompanyDto {
  const rate = row.rate_iqd_per_usd
    ? {
        rate_iqd_per_usd: formatRate(row.rate_iqd_per_usd),
        since: (row.rate_since as Date).toISOString(),
        is_company_rate: true,
      }
    : globalRate
      ? { rate_iqd_per_usd: globalRate, since: '', is_company_rate: false }
      : null;

  return {
    id: row.id,
    name: row.name,
    contact_name: row.contact_name,
    phone: row.phone,
    address: row.address,
    notes: row.notes,
    settlement_currency: row.settlement_currency,
    assigned_user_id: row.assigned_user_id,
    assigned_user_name: row.assigned_user_name,
    is_active: row.is_active,
    rate,
    balance: rate ? toBalance(Number(row.balance), row.settlement_currency, rate.rate_iqd_per_usd) : null,
    version: row.version,
  };
}

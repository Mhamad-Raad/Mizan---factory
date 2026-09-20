import { Injectable } from '@nestjs/common';
import {
  LedgerWriteError,
  LedgerWriter,
  ReversalNotAllowedError,
  AlreadyReversedError,
  balanceAsOf,
  balanceOf,
  groupLedger,
  ledgerAuditChanges,
  liveEntries,
  moneyMovementsOnly,
  runningBalances,
} from '@mizan/ledger';
import type { LedgerEntry, LedgerGroup, NewLedgerEntry, WriteResult } from '@mizan/ledger';
import type { Currency } from '@mizan/money';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/errors.js';
import type { RequestContext } from '../common/request-context.js';
import type { Db } from '../database/pool.js';
import { CustomerLedgerStore } from './customer-ledger.store.js';

/** What the writer needs to know about the counterparty: its id, its reading rule and a label. */
export interface LedgerCustomer {
  id: string;
  name: string;
  settlement_currency: Currency;
}

export interface LedgerWriteOptions {
  /** The note that goes into the audit row; the entry keeps its own. */
  audit_note?: string | null;
  /** Extra ids for the record History tabs (spec 2.4.4 `related`). */
  related?: Record<string, string | null>;
}

/**
 * The only path from a request to a row in `customer_ledger` (rule 2, spec 2.4.1).
 *
 * Each write happens inside the caller's transaction, after the customer row has been locked,
 * and produces both the ledger row and the `audit_log` row that records the balance before
 * and after — one call, so a committed money movement without its History entry is not a
 * thing this code can express.
 */
@Injectable()
export class CustomerLedgerService {
  constructor(private readonly audit: AuditService) {}

  /**
   * Locks one customer for the rest of the transaction (spec 2.9.5). Running balances are
   * therefore computed serially per customer, while two employees recording payments for two
   * different customers never wait for each other.
   */
  async lockCustomer(tx: Db, customerId: string): Promise<LedgerCustomer | null> {
    const { rows } = await tx.query<{ id: string; name: string; settlement_currency: Currency }>(
      `SELECT id, name, settlement_currency FROM customers
        WHERE id = $1 AND deleted_at IS NULL
        FOR UPDATE`,
      [customerId],
    );
    return rows[0] ?? null;
  }

  private writerFor(tx: Db, customer: LedgerCustomer): LedgerWriter {
    return new LedgerWriter(new CustomerLedgerStore(tx), () => customer.settlement_currency);
  }

  /** Appends one row and records it in History with the balance before and after. */
  async write(
    context: RequestContext,
    tx: Db,
    customer: LedgerCustomer,
    entry: Omit<NewLedgerEntry, 'owner_id' | 'created_by'> & { created_by?: string },
    options: LedgerWriteOptions = {},
  ): Promise<WriteResult> {
    const result = await this.guard(() =>
      this.writerFor(tx, customer).write({
        ...entry,
        owner_id: customer.id,
        created_by: entry.created_by ?? context.userId,
      }),
    );
    await this.recordAudit(context, tx, customer, result, options);
    return result;
  }

  /** The exact negation of one row, refused if that row was already reversed (2.4.1 rule 3). */
  async reverse(
    context: RequestContext,
    tx: Db,
    customer: LedgerCustomer,
    entryId: string,
    options: { note: string; entry_date?: string } & LedgerWriteOptions,
  ): Promise<WriteResult> {
    const result = await this.guard(() =>
      this.writerFor(tx, customer).reverse(customer.id, entryId, {
        created_by: context.userId,
        note: options.note,
        entry_date: options.entry_date,
      }),
    );
    await this.recordAudit(context, tx, customer, result, {
      audit_note: options.note,
      related: options.related,
    });
    return result;
  }

  /**
   * "Reverse everything live, then write the new version" for one document (spec 2.5.3 step 2).
   * Every live row carrying the order's id is negated, including its cash settlement.
   */
  async reverseLiveForOrder(
    context: RequestContext,
    tx: Db,
    customer: LedgerCustomer,
    orderId: string,
    options: { note: string; entry_date?: string } & LedgerWriteOptions,
  ): Promise<WriteResult[]> {
    const entries = await new CustomerLedgerStore(tx).entriesFor(customer.id);
    const targets = liveEntries(entries).filter((entry) => entry.refs.order_id === orderId);
    const results: WriteResult[] = [];
    for (const target of targets) {
      results.push(await this.reverse(context, tx, customer, target.id, options));
    }
    return results;
  }

  async entriesFor(tx: Db, customerId: string): Promise<LedgerEntry[]> {
    return new CustomerLedgerStore(tx).entriesFor(customerId);
  }

  async balanceOf(tx: Db, customer: LedgerCustomer): Promise<number> {
    return balanceOf(await this.entriesFor(tx, customer.id), customer.settlement_currency);
  }

  /** The balance at a business date, for the "as of" reading of a ledger (spec 2.2.6, A-43). */
  async balanceAsOf(tx: Db, customer: LedgerCustomer, isoDate: string): Promise<number> {
    return balanceAsOf(await this.entriesFor(tx, customer.id), customer.settlement_currency, isoDate);
  }

  /** The grouped ledger of 2.4.5; `raw` returns every row as its own group. */
  async groupsFor(
    tx: Db,
    customer: LedgerCustomer,
    options: { raw?: boolean; money_only?: boolean } = {},
  ): Promise<{ groups: LedgerGroup[]; entries: LedgerEntry[] }> {
    const entries = await this.entriesFor(tx, customer.id);

    // `?raw=true` is the audit view: one group per row, nothing collapsed, nothing hidden.
    if (options.raw) {
      const groups: LedgerGroup[] = runningBalances(entries, customer.settlement_currency).map((row) => ({
        kind: 'entry',
        rows: [row],
        anchor: row,
        amount_iqd: row.entry.amount_iqd,
        amount_usd_cents: row.entry.amount_usd_cents,
        hidden_by_default: false,
        order_id: (row.entry.refs.order_id as string | null) ?? null,
        received_currency: row.entry.entry_type === 'cash_settlement' ? row.entry.entered_currency : null,
      }));
      return { groups, entries };
    }

    const grouped = groupLedger(entries, customer.settlement_currency);
    return { groups: options.money_only ? moneyMovementsOnly(grouped) : grouped, entries };
  }

  private async recordAudit(
    context: RequestContext,
    tx: Db,
    customer: LedgerCustomer,
    result: WriteResult,
    options: LedgerWriteOptions,
  ): Promise<void> {
    await this.audit.record(
      context,
      {
        action: 'ledger_entry',
        entity_type: 'customer',
        entity_id: customer.id,
        entity_label: `Customer: ${customer.name}`,
        changes: ledgerAuditChanges(result),
        note: options.audit_note ?? result.entry.note,
        related: {
          customer_id: customer.id,
          ledger_entry_id: result.entry.id,
          order_id: (result.entry.refs.order_id as string | null) ?? null,
          ...options.related,
        },
      },
      // The audit row belongs to the same transaction as the ledger row it describes.
      tx,
    );
  }

  /**
   * Turns a kernel refusal into the error shape of 2.9.2. The kernel throws because the rule
   * is a property of the ledger, not of the API; the API decides the status code.
   */
  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AlreadyReversedError) {
        throw new ApiError('VERSION_CONFLICT', { reason: 'already_reversed', entry_id: error.entryId });
      }
      if (error instanceof ReversalNotAllowedError || error instanceof LedgerWriteError) {
        throw ApiError.validation([
          { path: 'entry', code: 'LEDGER_RULE', message_key: 'errors:ledger_rule', params: { detail: error.message } },
        ]);
      }
      throw error;
    }
  }
}

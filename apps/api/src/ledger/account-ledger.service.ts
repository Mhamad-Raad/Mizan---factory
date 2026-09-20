import {
  AlreadyReversedError,
  LedgerWriteError,
  LedgerWriter,
  ReversalNotAllowedError,
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
import { AccountLedgerStore } from './account-ledger.store.js';
import type { LedgerShape } from './account-ledger.store.js';

/** The counterparty a balance belongs to: its id, its reading rule and a label for History. */
export interface LedgerAccount {
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
 * The only path from a request to a row in `customer_ledger` or `company_ledger` (rule 2,
 * spec 2.4.1).
 *
 * Both ledgers obey the same five rules — write inside the caller's transaction, after locking
 * the counterparty; compute the balance before and after *there*; append, never update; record
 * the audit row in the same transaction; correct by reversal — so both go through this class
 * and the subclasses supply only what differs (D-019).
 */
export abstract class AccountLedgerService {
  protected abstract readonly shape: LedgerShape;
  /** `customer` or `company`: what History calls the entity (spec 2.4.2). */
  protected abstract readonly entityType: 'customer' | 'company';
  /** "Customer: Kawa Trading" / "Company: Al-Noor Steel Co." on the audit row. */
  protected abstract label(account: LedgerAccount): string;

  constructor(protected readonly audit: AuditService) {}

  private get documentColumn(): 'order_id' | 'purchase_id' {
    return this.shape.documentColumn;
  }

  /**
   * Locks one counterparty for the rest of the transaction (spec 2.9.5). Running balances are
   * therefore computed serially per counterparty, while two employees working on two different
   * ones never wait for each other.
   */
  async lockOwner(tx: Db, id: string): Promise<LedgerAccount | null> {
    const { rows } = await tx.query<LedgerAccount>(
      `SELECT id, name, settlement_currency FROM ${this.shape.ownerTable}
        WHERE id = $1 AND deleted_at IS NULL
        FOR UPDATE`,
      [id],
    );
    return rows[0] ?? null;
  }

  protected storeFor(tx: Db): AccountLedgerStore {
    return new AccountLedgerStore(tx, this.shape);
  }

  private writerFor(tx: Db, account: LedgerAccount): LedgerWriter {
    return new LedgerWriter(this.storeFor(tx), () => account.settlement_currency);
  }

  /** Appends one row and records it in History with the balance before and after. */
  async write(
    context: RequestContext,
    tx: Db,
    account: LedgerAccount,
    entry: Omit<NewLedgerEntry, 'owner_id' | 'created_by'> & { created_by?: string },
    options: LedgerWriteOptions = {},
  ): Promise<WriteResult> {
    const result = await this.guard(() =>
      this.writerFor(tx, account).write({
        ...entry,
        owner_id: account.id,
        created_by: entry.created_by ?? context.userId,
      }),
    );
    await this.recordAudit(context, tx, account, result, options);
    return result;
  }

  /** The exact negation of one row, refused if that row was already reversed (2.4.1 rule 3). */
  async reverse(
    context: RequestContext,
    tx: Db,
    account: LedgerAccount,
    entryId: string,
    options: { note: string; entry_date?: string } & LedgerWriteOptions,
  ): Promise<WriteResult> {
    const result = await this.guard(() =>
      this.writerFor(tx, account).reverse(account.id, entryId, {
        created_by: context.userId,
        note: options.note,
        entry_date: options.entry_date,
      }),
    );
    await this.recordAudit(context, tx, account, result, {
      audit_note: options.note,
      related: options.related,
    });
    return result;
  }

  /**
   * "Reverse everything live, then write the new version" for one document (spec 2.5.3 step 2).
   * `types` limits it to the document's own rows — a void reverses the purchase or order and its
   * settlement, and leaves the payments standing, because that money did arrive (FR-610).
   */
  async reverseLiveForDocument(
    context: RequestContext,
    tx: Db,
    account: LedgerAccount,
    documentId: string,
    options: { note: string; entry_date?: string; types: readonly string[] } & LedgerWriteOptions,
  ): Promise<WriteResult[]> {
    const entries = await this.entriesFor(tx, account.id);
    const targets = liveEntries(entries).filter(
      (entry) => entry.refs[this.documentColumn] === documentId && options.types.includes(entry.entry_type),
    );
    const results: WriteResult[] = [];
    for (const target of targets) {
      results.push(await this.reverse(context, tx, account, target.id, options));
    }
    return results;
  }

  async entriesFor(tx: Db, ownerId: string): Promise<LedgerEntry[]> {
    return this.storeFor(tx).entriesFor(ownerId);
  }

  async balanceOf(tx: Db, account: LedgerAccount): Promise<number> {
    return balanceOf(await this.entriesFor(tx, account.id), account.settlement_currency);
  }

  /** The balance at a business date, for the "as of" reading of a ledger (spec 2.2.6, A-43). */
  async balanceAsOf(tx: Db, account: LedgerAccount, isoDate: string): Promise<number> {
    return balanceAsOf(await this.entriesFor(tx, account.id), account.settlement_currency, isoDate);
  }

  /** The grouped ledger of 2.4.5; `raw` returns every row as its own group. */
  async groupsFor(
    tx: Db,
    account: LedgerAccount,
    options: { raw?: boolean; money_only?: boolean } = {},
  ): Promise<{ groups: LedgerGroup[]; entries: LedgerEntry[] }> {
    const entries = await this.entriesFor(tx, account.id);

    // `?raw=true` is the audit view: one group per row, nothing collapsed, nothing hidden.
    if (options.raw) {
      const groups: LedgerGroup[] = runningBalances(entries, account.settlement_currency).map((row) => ({
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

    const grouped = groupLedger(entries, account.settlement_currency);
    return { groups: options.money_only ? moneyMovementsOnly(grouped) : grouped, entries };
  }

  private async recordAudit(
    context: RequestContext,
    tx: Db,
    account: LedgerAccount,
    result: WriteResult,
    options: LedgerWriteOptions,
  ): Promise<void> {
    await this.audit.record(
      context,
      {
        action: 'ledger_entry',
        entity_type: this.entityType,
        entity_id: account.id,
        entity_label: this.label(account),
        changes: ledgerAuditChanges(result),
        note: options.audit_note ?? result.entry.note,
        related: {
          [`${this.entityType}_id`]: account.id,
          ledger_entry_id: result.entry.id,
          [this.documentColumn]: (result.entry.refs[this.documentColumn] as string | null) ?? null,
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

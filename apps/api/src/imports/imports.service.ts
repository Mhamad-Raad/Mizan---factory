import { Injectable } from '@nestjs/common';
import { normalizeForSearch } from '@mizan/text';
import { ApiError, messageKeyFor } from '../common/errors.js';
import type { RequestContext } from '../common/request-context.js';
import { Database } from '../database/pool.js';
import { ItemsService } from '../items/items.service.js';
import { CustomersService } from '../customers/customers.service.js';
import { CompaniesService } from '../companies/companies.service.js';
import { PeriodService } from '../settings/period.service.js';

/** What can be imported at go-live (FR-1312). Nothing else; this is not a data-entry API. */
export type ImportKind =
  | 'materials'
  | 'customers'
  | 'companies'
  | 'opening_stock'
  | 'customer_opening_balance'
  | 'company_opening_balance';

export const IMPORT_KINDS: readonly ImportKind[] = [
  'materials',
  'customers',
  'companies',
  'opening_stock',
  'customer_opening_balance',
  'company_opening_balance',
];

/** One row as the spreadsheet had it: the column names of the template, values as text. */
export type ImportRow = Record<string, string | null>;

export interface RowProblem {
  row: number;
  column: string | null;
  message_key: string;
  params: Record<string, unknown>;
}

export interface ImportPreview {
  kind: ImportKind;
  rows: number;
  /** Rows that would be created, after the problems below are taken out. */
  ready: number;
  problems: RowProblem[];
}

export interface ImportResult extends ImportPreview {
  created: number;
  failed: { row: number; message_key: string; params: Record<string, unknown> }[];
}

/**
 * CSV import for the data a factory arrives with (FR-1312, **Proposed — not requested**).
 *
 * Go-live means entering five thousand materials, ten thousand customers, their opening debts
 * and the stock on the floor. Typing that is a week of somebody's life and a hundred typos, so
 * the templates exist — but an import is the most dangerous screen in the system: it writes
 * money, in bulk, from a file somebody edited in Excel. Three rules follow from that.
 *
 * **It writes nothing the forms cannot.** Every row goes through the same service the screen
 * uses, so an imported opening balance is the same ledger entry with the same audit row and the
 * same rate as one typed by hand — attributed to the admin who imported it (FR-1312).
 *
 * **It is previewed first, per row.** A preview reads the file against the database — unknown
 * material, duplicate name, unparsable number, a date in the future, a locked period — and says
 * which line of the spreadsheet is wrong and why. Nobody should discover row 4,213 after the
 * first 4,212 have been written.
 *
 * **Each row is its own transaction.** A file of ten thousand customers must not be lost
 * because one of them has no name: the good rows are created, the bad ones come back with their
 * reasons, and the file can be fixed and imported again — the duplicate check makes the second
 * run skip what already exists.
 */
@Injectable()
export class ImportsService {
  constructor(
    private readonly database: Database,
    private readonly items: ItemsService,
    private readonly customers: CustomersService,
    private readonly companies: CompaniesService,
    private readonly period: PeriodService,
  ) {}

  /** The columns of each template, in order. The client builds its CSV headers from these. */
  columnsOf(kind: ImportKind): { required: string[]; optional: string[] } {
    switch (kind) {
      case 'materials':
        return { required: ['name', 'pricing_unit'], optional: ['code', 'min_stock', 'notes'] };
      case 'customers':
        return { required: ['name'], optional: ['phone', 'address', 'settlement_currency', 'notes'] };
      case 'companies':
        return {
          required: ['name'],
          optional: ['contact_name', 'phone', 'address', 'settlement_currency', 'notes'],
        };
      case 'opening_stock':
        return { required: ['material'], optional: ['qty_count', 'qty_kg', 'entry_date', 'note'] };
      case 'customer_opening_balance':
        return { required: ['customer', 'amount', 'currency'], optional: ['entry_date', 'note'] };
      case 'company_opening_balance':
        return { required: ['company', 'amount', 'currency'], optional: ['entry_date', 'note'] };
    }
  }

  /**
   * Reads the file against the database and says what is wrong with it, per row, without
   * writing anything.
   */
  async preview(kind: ImportKind, rows: readonly ImportRow[]): Promise<ImportPreview> {
    const problems: RowProblem[] = [];
    const seen = new Set<string>();
    const { required } = this.columnsOf(kind);

    for (const [index, row] of rows.entries()) {
      const at = index + 1;
      const problem = (column: string | null, key: string, params: Record<string, unknown> = {}) =>
        problems.push({ row: at, column, message_key: key, params });

      for (const column of required) {
        if (!text(row[column])) problem(column, 'errors:field.required', { field: column });
      }

      // A name twice in one file is the mistake a merged spreadsheet makes, and the database's
      // own duplicate check will not see it until the second row is already being written.
      const identity = text(row.name) ?? text(row.material) ?? text(row.customer) ?? text(row.company);
      if (identity) {
        const key = normalizeForSearch(identity);
        if (seen.has(key)) problem(null, 'imports:duplicate_in_file', { name: identity });
        seen.add(key);
      }

      switch (kind) {
        case 'materials': {
          const unit = text(row.pricing_unit);
          if (unit && unit !== 'per_kg' && unit !== 'per_piece') {
            problem('pricing_unit', 'imports:bad_pricing_unit', { value: unit });
          }
          if (identity && (await this.nameTaken('items', identity))) {
            problem('name', 'imports:already_exists', { name: identity });
          }
          break;
        }
        case 'customers':
        case 'companies': {
          const currency = text(row.settlement_currency);
          if (currency && currency !== 'IQD' && currency !== 'USD') {
            problem('settlement_currency', 'imports:bad_currency', { value: currency });
          }
          const table = kind === 'customers' ? 'customers' : 'companies';
          if (identity && (await this.nameTaken(table, identity))) {
            problem('name', 'imports:already_exists', { name: identity });
          }
          break;
        }
        case 'opening_stock': {
          const material = text(row.material);
          if (material && !(await this.findByName('items', material))) {
            problem('material', 'imports:unknown_material', { name: material });
          }
          if (!text(row.qty_count) && !text(row.qty_kg)) {
            problem(null, 'imports:quantity_required', {});
          }
          this.checkNumber(row.qty_count, 'qty_count', problem);
          this.checkNumber(row.qty_kg, 'qty_kg', problem);
          await this.checkDate(row.entry_date, problem);
          break;
        }
        case 'customer_opening_balance':
        case 'company_opening_balance': {
          const column = kind === 'customer_opening_balance' ? 'customer' : 'company';
          const table = kind === 'customer_opening_balance' ? 'customers' : 'companies';
          const name = text(row[column]);
          if (name && !(await this.findByName(table, name))) {
            problem(column, 'imports:unknown_counterparty', { name });
          }
          this.checkNumber(row.amount, 'amount', problem);
          const currency = text(row.currency);
          if (currency && currency !== 'IQD' && currency !== 'USD') {
            problem('currency', 'imports:bad_currency', { value: currency });
          }
          await this.checkDate(row.entry_date, problem);
          break;
        }
      }
    }

    const badRows = new Set(problems.map((problem) => problem.row));
    return { kind, rows: rows.length, ready: rows.length - badRows.size, problems };
  }

  /**
   * Writes the rows, one transaction each, through the same services the screens use. A row
   * that fails comes back with its reason and does not stop the others.
   */
  async run(context: RequestContext, kind: ImportKind, rows: readonly ImportRow[]): Promise<ImportResult> {
    const preview = await this.preview(kind, rows);
    const badRows = new Set(preview.problems.map((problem) => problem.row));
    const failed: ImportResult['failed'] = [];
    let created = 0;

    for (const [index, row] of rows.entries()) {
      const at = index + 1;
      if (badRows.has(at)) continue;
      try {
        await this.writeRow(context, kind, row);
        created += 1;
      } catch (caught) {
        // The row's own reason, in the reader's language, beside the line of the spreadsheet.
        const error = caught instanceof ApiError ? caught : null;
        failed.push({
          row: at,
          // A field error is the useful one — "row 812: this customer has no name" — so it is
          // preferred over the generic code when the row failed validation.
          message_key: error
            ? (error.fields[0]?.message_key ?? messageKeyFor(error.code))
            : 'errors:INTERNAL',
          params: error ? (error.fields[0]?.params ?? error.params) : {},
        });
      }
    }

    return { ...preview, created, failed };
  }

  private async writeRow(context: RequestContext, kind: ImportKind, row: ImportRow): Promise<void> {
    const today = this.period.today();

    switch (kind) {
      case 'materials':
        await this.items.create(context, {
          name: text(row.name) as string,
          pricing_unit: text(row.pricing_unit) as 'per_kg' | 'per_piece',
          code: text(row.code),
          min_stock_count:
            text(row.pricing_unit) === 'per_piece' && text(row.min_stock) ? Number(row.min_stock) : null,
          min_stock_kg: text(row.pricing_unit) === 'per_kg' ? text(row.min_stock) : null,
          notes: text(row.notes),
        });
        return;

      case 'customers':
        await this.customers.create(context, {
          name: text(row.name) as string,
          phone: text(row.phone),
          address: text(row.address),
          settlement_currency: (text(row.settlement_currency) as 'IQD' | 'USD') ?? undefined,
          notes: text(row.notes),
        });
        return;

      case 'companies':
        await this.companies.create(context, {
          name: text(row.name) as string,
          contact_name: text(row.contact_name),
          phone: text(row.phone),
          address: text(row.address),
          settlement_currency: (text(row.settlement_currency) as 'IQD' | 'USD') ?? undefined,
          notes: text(row.notes),
        });
        return;

      case 'opening_stock': {
        const item = await this.findByName('items', text(row.material) as string);
        if (!item) throw ApiError.notFound();
        await this.items.recordMovement(context, item, 'opening', {
          qty_count: text(row.qty_count) ? Number(row.qty_count) : null,
          qty_kg: text(row.qty_kg),
          entry_date: text(row.entry_date) ?? today,
          note: text(row.note) ?? 'Imported at go-live',
        });
        return;
      }

      case 'customer_opening_balance': {
        const customer = await this.findByName('customers', text(row.customer) as string);
        if (!customer) throw ApiError.notFound();
        await this.customers.recordEntry(context, customer, 'opening', {
          amount: Number(row.amount),
          currency: text(row.currency) as 'IQD' | 'USD',
          entry_date: text(row.entry_date) ?? today,
          note: text(row.note) ?? 'Opening debt imported at go-live',
        });
        return;
      }

      case 'company_opening_balance': {
        const company = await this.findByName('companies', text(row.company) as string);
        if (!company) throw ApiError.notFound();
        await this.companies.recordEntry(context, company, 'opening', {
          amount: Number(row.amount),
          currency: text(row.currency) as 'IQD' | 'USD',
          entry_date: text(row.entry_date) ?? today,
          note: text(row.note) ?? 'Opening debt imported at go-live',
        });
        return;
      }
    }
  }

  /** By normalised name, which is how a human writes the same thing twice (2.10.7). */
  private async findByName(table: 'items' | 'customers' | 'companies', name: string): Promise<string | null> {
    const { rows } = await this.database.query<{ id: string }>(
      `SELECT id::text AS id FROM ${table} WHERE name_normalized = $1 AND deleted_at IS NULL LIMIT 1`,
      [normalizeForSearch(name)],
    );
    return rows[0]?.id ?? null;
  }

  private async nameTaken(table: 'items' | 'customers' | 'companies', name: string): Promise<boolean> {
    return (await this.findByName(table, name)) !== null;
  }

  private checkNumber(
    value: string | null | undefined,
    column: string,
    problem: (column: string | null, key: string, params?: Record<string, unknown>) => void,
  ): void {
    const given = text(value);
    if (!given) return;
    if (!/^-?\d+(\.\d+)?$/.test(given)) problem(column, 'imports:not_a_number', { value: given });
  }

  private async checkDate(
    value: string | null | undefined,
    problem: (column: string | null, key: string, params?: Record<string, unknown>) => void,
  ): Promise<void> {
    const given = text(value);
    if (!given) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(given)) {
      problem('entry_date', 'imports:bad_date', { value: given });
      return;
    }
    // The same two rules every form obeys: not the future, not a locked period.
    try {
      this.period.assertNotFuture(given, 'entry_date');
      await this.period.assertNotLocked(given);
    } catch (caught) {
      const error = caught instanceof ApiError ? caught : null;
      problem(
        'entry_date',
        error ? (error.fields[0]?.message_key ?? messageKeyFor(error.code)) : 'errors:INTERNAL',
        error ? (error.fields[0]?.params ?? error.params) : {},
      );
    }
  }
}

/** A spreadsheet cell is blank, whitespace, or something; this is the difference. */
function text(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

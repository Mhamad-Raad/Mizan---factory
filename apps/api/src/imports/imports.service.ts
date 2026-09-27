import { Injectable, Logger } from '@nestjs/common';
import { normalizeForSearch } from '@mizan/text';
import { ApiError } from '../common/errors.js';
import type { RequestContext } from '../common/request-context.js';
import { Database } from '../database/pool.js';
import { ItemsService } from '../items/items.service.js';
import { CustomersService } from '../customers/customers.service.js';
import { CompaniesService } from '../companies/companies.service.js';
import { PeriodService } from '../settings/period.service.js';
import type { ZodType } from 'zod';
import { createSchema as itemCreateSchema, movementSchema } from '../items/items.controller.js';
import { createSchema as customerCreateSchema, entrySchema as customerEntrySchema } from '../customers/customers.controller.js';
import { entrySchema as companyEntrySchema } from '../companies/companies.controller.js';

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
 * material, duplicate name, unparsable number, a date in the future — and says
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
  private readonly logger = new Logger('Import');

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
        return {
          required: ['name'],
          optional: ['phone', 'address', 'settlement_currency', 'notes'],
        };
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

    // Every name in the file, resolved before the loop rather than inside it.
    const identityOf = (row: ImportRow): string | null =>
      text(row.name) ?? text(row.material) ?? text(row.customer) ?? text(row.company);
    const identities = rows.map(identityOf).filter((name): name is string => name !== null);
    const table: 'items' | 'customers' | 'companies' =
      kind === 'materials' || kind === 'opening_stock'
        ? 'items'
        : kind === 'customers' || kind === 'customer_opening_balance' || kind === 'companies'
          ? // A new business of either kind collides with any business of that name (D-054).
            'customers'
          : 'companies';
    const known = await this.namesIn(table, identities);
    const isKnown = (name: string): boolean => known.has(normalizeForSearch(name));

    for (const [index, row] of rows.entries()) {
      const at = index + 1;
      const problem = (column: string | null, key: string, params: Record<string, unknown> = {}) =>
        problems.push({ row: at, column, message_key: key, params });

      for (const column of required) {
        if (!text(row[column])) problem(column, 'errors:field.required', { field: column });
      }

      // A name twice in one file is the mistake a merged spreadsheet makes, and the database's
      // own duplicate check will not see it until the second row is already being written.
      const identity = identityOf(row);
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
          if (identity && isKnown(identity)) {
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
          if (identity && isKnown(identity)) {
            problem('name', 'imports:already_exists', { name: identity });
          }
          break;
        }
        case 'opening_stock': {
          const material = text(row.material);
          if (material && !isKnown(material)) {
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
          const name = text(row[column]);
          if (name && !isKnown(name)) {
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

      /*
       * Then the very schema the form's route validates with, over the body this row would be
       * (security review, finding 15). The checks above explain the common mistakes in the
       * spreadsheet's own terms; this one catches everything else the route would refuse — a
       * name too long, a negative minimum, half a piece — which used to reach the database and
       * come back as a bare 500. A column that already has its problem is not told twice.
       */
      const flagged = new Set(problems.filter((found) => found.row === at).map((found) => found.column));
      for (const issue of schemaProblems(kind, row)) {
        if (flagged.has(issue.column) || flagged.has(null)) continue;
        flagged.add(issue.column);
        problem(issue.column, issue.message_key, issue.params);
      }
    }

    const badRows = new Set(problems.map((problem) => problem.row));
    return { kind, rows: rows.length, ready: rows.length - badRows.size, problems };
  }

  /**
   * Writes the rows, one transaction each, through the same services the screens use. A row
   * that fails comes back with its reason and does not stop the others.
   */
  async run(
    context: RequestContext,
    kind: ImportKind,
    rows: readonly ImportRow[],
  ): Promise<ImportResult> {
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
        // Anything else is ours to look into: the row reads "internal", the log says why.
        if (!error) this.logger.error(`import ${kind} row ${at}: ${(caught as Error)?.message}`, (caught as Error)?.stack);
        failed.push({
          row: at,
          // A field error is the useful one — "row 812: this customer has no name" — so it is
          // preferred over the generic code when the row failed validation.
          message_key: error
            ? (error.fields[0]?.message_key ?? error.messageKey)
            : 'errors:INTERNAL',
          params: error ? (error.fields[0]?.params ?? error.params) : {},
        });
      }
    }

    return { ...preview, created, failed };
  }

  private async writeRow(context: RequestContext, kind: ImportKind, row: ImportRow): Promise<void> {
    // The same parse the preview ran: a row reaches here only when it passed, so this cannot
    // fail — and if it ever did, it would refuse rather than write a half-read row.
    const today = this.period.today();

    switch (kind) {
      case 'materials': {
        const body = itemCreateSchema.parse(bodyOf(kind, row, today));
        await this.items.create(context, {
          name: body.name,
          pricing_unit: body.pricing_unit,
          code: body.code ?? null,
          min_stock_count: body.min_stock_count ?? null,
          min_stock_kg: body.min_stock_kg ?? null,
          notes: body.notes ?? null,
        });
        return;
      }

      case 'customers':
      case 'companies': {
        const body = customerCreateSchema.parse(bodyOf(kind, row, today));
        await this.customers.create(context, {
          name: body.name,
          ...(kind === 'companies' ? { contact_name: body.contact_name ?? null } : {}),
          phone: body.phone ?? null,
          address: body.address ?? null,
          settlement_currency: body.settlement_currency,
          notes: body.notes ?? null,
        });
        return;
      }

      case 'opening_stock': {
        const body = movementSchema.parse(bodyOf(kind, row, today));
        const item = await this.findByName('items', text(row.material) as string);
        if (!item) throw ApiError.notFound();
        await this.items.recordMovement(context, item, 'opening', {
          qty_count: body.qty_count ?? null,
          qty_kg: body.qty_kg ?? null,
          entry_date: body.entry_date,
          note: body.note,
        });
        return;
      }

      case 'customer_opening_balance': {
        const body = customerEntrySchema.parse(bodyOf(kind, row, today));
        const customer = await this.findByName('customers', text(row.customer) as string);
        if (!customer) throw ApiError.notFound();
        await this.customers.recordEntry(context, customer, 'opening', {
          amount: body.amount,
          currency: body.currency,
          entry_date: body.entry_date,
          note: body.note,
        });
        return;
      }

      case 'company_opening_balance': {
        const body = companyEntrySchema.parse(bodyOf(kind, row, today));
        const company = await this.findByName('companies', text(row.company) as string);
        if (!company) throw ApiError.notFound();
        await this.companies.recordEntry(context, company, 'opening', {
          amount: body.amount,
          currency: body.currency,
          entry_date: body.entry_date,
          note: body.note,
        });
        return;
      }
    }
  }

  /** By normalised name, which is how a human writes the same thing twice (2.10.7). */
  /**
   * Every name the file mentions, resolved in **one** query per table.
   *
   * The preview used to ask the database about each row as it read it — "is this material
   * known?", "is this name taken?" — which is one sequential round trip per row. At the
   * 10,000 rows the import's own schema allows, that was **22.7 seconds of a 44.7 second
   * import** (system-wide review). The lookups are read-only and order does not matter, so
   * they are one `= ANY` per table, and the loop consults a map.
   */
  private async namesIn(
    table: 'items' | 'customers' | 'companies',
    identities: readonly string[],
  ): Promise<Map<string, string>> {
    const normalized = [...new Set(identities.map((name) => normalizeForSearch(name)))];
    if (normalized.length === 0) return new Map();
    const { rows } = await this.database.query<{ id: string; name_normalized: string }>(
      `SELECT id::text AS id, name_normalized FROM ${sourceOf(table)}
        name_normalized = ANY($1::text[]) AND deleted_at IS NULL`,
      [normalized],
    );
    return new Map(rows.map((row) => [row.name_normalized, row.id]));
  }

  private async findByName(
    table: 'items' | 'customers' | 'companies',
    name: string,
  ): Promise<string | null> {
    const { rows } = await this.database.query<{ id: string }>(
      `SELECT id::text AS id FROM ${sourceOf(table)} name_normalized = $1 AND deleted_at IS NULL LIMIT 1`,
      [normalizeForSearch(name)],
    );
    return rows[0]?.id ?? null;
  }

  private async nameTaken(
    table: 'items' | 'customers' | 'companies',
    name: string,
  ): Promise<boolean> {
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
    // The rule every form obeys: not the future.
    try {
      this.period.assertNotFuture(given, 'entry_date');
    } catch (caught) {
      const error = caught instanceof ApiError ? caught : null;
      problem(
        'entry_date',
        error ? (error.fields[0]?.message_key ?? error.messageKey) : 'errors:INTERNAL',
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

/**
 * Where a name is looked up. Customers and companies are one table (D-054): a company is a
 * ordinary account (not the walk-in, D-055), so an opening debt to a company finds any of them — and a new
 * row of either kind collides with any business of that name, because it would be the same one.
 */
function sourceOf(table: 'items' | 'customers' | 'companies'): string {
  return table === 'companies' ? 'customers WHERE NOT is_system AND' : `${table} WHERE`;
}

/** A cell as a number: blank is "not given", anything else is read — `NaN` when it is not one. */
function numberOf(value: string | null | undefined): number | null {
  const given = text(value);
  return given === null ? null : Number(given);
}

/**
 * The body the form's route would receive for this row, and the spreadsheet column each of its
 * fields came from — so a refusal names the column the admin has to fix.
 */
function bodyOf(kind: ImportKind, row: ImportRow, today: string): Record<string, unknown> {
  switch (kind) {
    case 'materials': {
      const unit = text(row.pricing_unit);
      return {
        name: text(row.name) ?? '',
        pricing_unit: unit,
        code: text(row.code),
        min_stock_count: unit === 'per_piece' ? numberOf(row.min_stock) : null,
        min_stock_kg: unit === 'per_kg' ? text(row.min_stock) : null,
        notes: text(row.notes),
      };
    }
    case 'customers':
    case 'companies':
      return {
        name: text(row.name) ?? '',
        contact_name: kind === 'companies' ? text(row.contact_name) : null,
        phone: text(row.phone),
        address: text(row.address),
        settlement_currency: text(row.settlement_currency) ?? undefined,
        notes: text(row.notes),
      };
    case 'opening_stock':
      return {
        qty_count: numberOf(row.qty_count),
        qty_kg: text(row.qty_kg),
        entry_date: text(row.entry_date) ?? today,
        note: text(row.note) ?? 'Imported at go-live',
      };
    case 'customer_opening_balance':
    case 'company_opening_balance':
      return {
        amount: numberOf(row.amount),
        currency: text(row.currency),
        entry_date: text(row.entry_date) ?? today,
        note: text(row.note) ?? 'Opening debt imported at go-live',
      };
  }
}

const COLUMN_OF: Readonly<Record<string, string>> = {
  min_stock_count: 'min_stock',
  min_stock_kg: 'min_stock',
};

function schemaOf(kind: ImportKind): ZodType {
  switch (kind) {
    case 'materials':
      return itemCreateSchema;
    case 'customers':
    case 'companies':
      return customerCreateSchema;
    case 'opening_stock':
      return movementSchema;
    case 'customer_opening_balance':
      return customerEntrySchema;
    case 'company_opening_balance':
      return companyEntrySchema;
  }
}

/** The route schema's refusals for one row, in the preview's shape: column, key, params. */
function schemaProblems(
  kind: ImportKind,
  row: ImportRow,
): { column: string | null; message_key: string; params: Record<string, unknown> }[] {
  // The date is only a placeholder here: a missing one defaults to today, and a given one has
  // its own check with its own message (checkDate).
  const parsed = schemaOf(kind).safeParse(bodyOf(kind, row, '2000-01-01'));
  if (parsed.success) return [];
  return parsed.error.issues.map((raw) => {
    const issue = raw as typeof raw & { origin?: string; minimum?: unknown; maximum?: unknown; inclusive?: boolean };
    const field = String(issue.path[0] ?? '');
    const column = field === '' ? null : (COLUMN_OF[field] ?? field);
    const value = column ? (text(row[column]) ?? '') : '';
    const isText = issue.origin === 'string';

    if (issue.code === 'too_big' && isText) {
      return { column, message_key: 'errors:field.too_long', params: { max: issue.maximum, field: column } };
    }
    if (issue.code === 'too_small' && isText) {
      return { column, message_key: 'errors:field.required', params: { field: column } };
    }
    // Below or above the bound, saying which bound: "cannot be negative" was also what a
    // number over its maximum was told.
    if (issue.code === 'too_small') {
      const key = issue.inclusive === false ? 'imports:number_above' : 'imports:number_too_small';
      return { column, message_key: key, params: { value, min: Number(issue.minimum) } };
    }
    if (issue.code === 'too_big') {
      return { column, message_key: 'imports:number_too_big', params: { value, max: Number(issue.maximum) } };
    }
    if (value !== '' && Number.isNaN(Number(value))) {
      return { column, message_key: 'imports:not_a_number', params: { value } };
    }
    if (issue.code === 'invalid_type' && /^-?\d+\.\d+$/.test(value)) {
      return { column, message_key: 'imports:whole_number_required', params: { value } };
    }
    return { column, message_key: 'imports:value_not_accepted', params: { value } };
  });
}

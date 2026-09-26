import { Injectable } from '@nestjs/common';
import { completePair } from '@mizan/money';
import type { Currency, Rate, RateSource } from '@mizan/money';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/errors.js';
import { pagingOf } from '../common/paging.js';
import type { RequestContext } from '../common/request-context.js';
import { Database } from '../database/pool.js';
import { RatesService } from '../rates/rates.service.js';
import { PeriodService } from '../settings/period.service.js';
import { containing } from '../common/like.js';

export interface ExpenseDto {
  id: string;
  number: number;
  expense_date: string;
  title: string;
  note: string | null;
  amount_iqd: number;
  amount_usd_cents: number;
  entered_currency: Currency;
  rate_iqd_per_usd: string;
  rate_source: RateSource;
  doc_status: 'active' | 'void';
  void_reason: string | null;
  created_by_name: string | null;
  created_at: string;
  version: number;
}

interface ExpenseRow {
  id: string;
  number: string;
  expense_date: string;
  title: string;
  note: string | null;
  amount_iqd: string;
  amount_usd_cents: string;
  entered_currency: Currency;
  rate_iqd_per_usd: string;
  rate_source: RateSource;
  status: 'active' | 'void';
  void_reason: string | null;
  created_by_name: string | null;
  created_at: Date;
  version: number;
}

const COLUMNS = `e.id, e.number::text AS number, to_char(e.expense_date, 'YYYY-MM-DD') AS expense_date,
  e.title, e.note, e.amount_iqd::text AS amount_iqd, e.amount_usd_cents::text AS amount_usd_cents,
  e.entered_currency::text AS entered_currency, e.rate_iqd_per_usd::text AS rate_iqd_per_usd,
  e.rate_source::text AS rate_source, e.status::text AS status, e.void_reason,
  u.display_name AS created_by_name, e.created_at, e.version`;

function toDto(row: ExpenseRow): ExpenseDto {
  return {
    id: row.id,
    number: Number(row.number),
    expense_date: row.expense_date,
    title: row.title,
    note: row.note,
    amount_iqd: Number(row.amount_iqd),
    amount_usd_cents: Number(row.amount_usd_cents),
    entered_currency: row.entered_currency,
    rate_iqd_per_usd: row.rate_iqd_per_usd,
    rate_source: row.rate_source,
    doc_status: row.status,
    void_reason: row.void_reason,
    created_by_name: row.created_by_name,
    created_at: row.created_at.toISOString(),
    version: row.version,
  };
}

/**
 * The accountant's own expenses (D-062): rent, salaries, electricity — anything the factory pays
 * that is not a buy of stock. Each is an amount in the currency it was paid in, with the other
 * currency at the system rate of the day and the rate kept (rule 1). An expense is never edited
 * or deleted; a wrong one is voided with a reason, and History has both.
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly database: Database,
    private readonly rates: RatesService,
    private readonly period: PeriodService,
    private readonly audit: AuditService,
  ) {}

  async list(filters: {
    from?: string;
    to?: string;
    q?: string;
    include_void?: boolean;
    page?: number;
    page_size?: number;
  }): Promise<{ items: ExpenseDto[]; total: number }> {
    const values: unknown[] = [];
    const where: string[] = [];
    if (!filters.include_void) where.push(`e.status = 'active'`);
    if (filters.from) {
      values.push(filters.from);
      where.push(`e.expense_date >= $${values.length}::date`);
    }
    if (filters.to) {
      values.push(filters.to);
      where.push(`e.expense_date <= $${values.length}::date`);
    }
    const query = filters.q?.trim();
    if (query) {
      values.push(containing(query));
      const param = values.length;
      where.push(`(e.title ILIKE $${param} OR e.note ILIKE $${param} OR e.number::text = btrim($${param}, '%'))`);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const paging = pagingOf(filters);
    const [list, count] = await Promise.all([
      this.database.query<ExpenseRow>(
        `SELECT ${COLUMNS} FROM expenses e LEFT JOIN users u ON u.id = e.created_by ${clause}
          ORDER BY e.expense_date DESC, e.number DESC
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, paging.page_size, paging.offset],
      ),
      this.database.query<{ total: string }>(`SELECT count(*)::text AS total FROM expenses e ${clause}`, values),
    ]);
    return { items: list.rows.map(toDto), total: Number(count.rows[0]?.total ?? 0) };
  }

  async get(id: string): Promise<ExpenseDto> {
    const { rows } = await this.database.query<ExpenseRow>(
      `SELECT ${COLUMNS} FROM expenses e LEFT JOIN users u ON u.id = e.created_by WHERE e.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw ApiError.notFound();
    return toDto(row);
  }

  async create(
    context: RequestContext,
    input: {
      expense_date: string;
      title: string;
      amount: { amount: number; currency: Currency; other_amount?: number | null };
      note?: string | null;
    },
  ): Promise<ExpenseDto> {
    this.period.assertNotFuture(input.expense_date, 'expense_date');
    if (input.amount.amount <= 0) {
      throw ApiError.validation([
        { path: 'amount', code: 'POSITIVE', message_key: 'errors:field.required', params: { field: 'amount' } },
      ]);
    }
    const rate: Rate = await this.rates.requireCurrent();
    const pair = completePair({
      amount: input.amount.amount,
      currency: input.amount.currency,
      rate,
      rate_source: 'global',
      other_amount: input.amount.other_amount ?? undefined,
    });

    const id = await this.database.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string; number: string }>(
        `INSERT INTO expenses
           (expense_date, title, amount_iqd, amount_usd_cents, entered_currency, rate_iqd_per_usd,
            rate_source, note, created_by)
         VALUES ($1::date, $2, $3, $4, $5::currency, $6::numeric, $7::rate_source, $8, $9)
         RETURNING id, number::text AS number`,
        [
          input.expense_date,
          input.title.trim(),
          pair.amount_iqd,
          pair.amount_usd_cents,
          input.amount.currency,
          pair.rate_iqd_per_usd,
          pair.rate_source,
          input.note?.trim() || null,
          context.userId,
        ],
      );
      const row = rows[0] as { id: string; number: string };
      await this.audit.record(
        context,
        {
          action: 'create',
          entity_type: 'expense',
          entity_id: row.id,
          entity_label: `Expense #${row.number}`,
          changes: {
            title: { old: null, new: input.title.trim() },
            expense_date: { old: null, new: input.expense_date },
            amount: { old: null, new: { iqd: pair.amount_iqd, usd_cents: pair.amount_usd_cents } },
          },
          note: input.note?.trim() || null,
          related: { expense_id: row.id },
        },
        tx,
      );
      return row.id;
    });
    return this.get(id);
  }

  async void(context: RequestContext, id: string, input: { reason: string; version?: number }): Promise<ExpenseDto> {
    await this.database.transaction(async (tx) => {
      const { rows } = await tx.query<{ status: string; number: string; version: number }>(
        `SELECT status::text AS status, number::text AS number, version FROM expenses WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const row = rows[0];
      if (!row) throw ApiError.notFound();
      if (row.status === 'void') throw new ApiError('DOCUMENT_VOID', { expense_id: id });
      if (input.version !== undefined && input.version !== row.version) {
        throw new ApiError('VERSION_CONFLICT', { current_version: row.version });
      }
      await tx.query(
        `UPDATE expenses SET status = 'void', void_reason = $2, voided_by = $3, voided_at = now(),
                version = version + 1
          WHERE id = $1`,
        [id, input.reason.trim(), context.userId],
      );
      await this.audit.record(
        context,
        {
          action: 'void',
          entity_type: 'expense',
          entity_id: id,
          entity_label: `Expense #${row.number}`,
          changes: { status: { old: 'active', new: 'void' } },
          note: input.reason.trim(),
          related: { expense_id: id },
        },
        tx,
      );
    });
    return this.get(id);
  }
}

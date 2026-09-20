import { Injectable } from '@nestjs/common';
import { normalizeForSearch, normalizePhone } from '@mizan/text';
import type { Currency } from '@mizan/money';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';

export interface CompanyRow {
  id: string;
  name: string;
  name_normalized: string;
  contact_name: string | null;
  phone: string | null;
  phone_normalized: string | null;
  address: string | null;
  notes: string | null;
  settlement_currency: Currency;
  assigned_user_id: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  version: number;
}

export interface CompanyListRow extends CompanyRow {
  assigned_user_name: string | null;
  balance: string;
  rate_iqd_per_usd: string | null;
  rate_since: Date | null;
}

export interface CompanyFilters {
  q?: string;
  assigned_to?: string;
  include_inactive?: boolean;
  /** FR-710: "highest balance first" is the collections view an owner asks for. */
  sort?: 'name' | 'balance';
  page?: number;
  page_size?: number;
}

function companyColumns(alias = 'companies'): string {
  return [
    'id',
    'name',
    'name_normalized',
    'contact_name',
    'phone',
    'phone_normalized',
    'address',
    'notes',
    'settlement_currency::text AS settlement_currency',
    'assigned_user_id',
    'is_active',
    'created_at',
    'updated_at',
    'deleted_at',
    'version',
  ]
    .map((field) => `${alias}.${field}`)
    .join(', ');
}

/**
 * All SQL for companies (decision D-008).
 *
 * There is no scope rule here: every user with `companies.view` sees every company (FR-711,
 * 2.6.4), which is the one place the supplier side deliberately differs from the customer one.
 * The balance and the current rate are read per row through LATERALs, served by the covering
 * index of migration 0008 — the pattern the I1 review measured into place.
 */
@Injectable()
export class CompaniesRepository {
  constructor(private readonly database: Database) {}

  async findById(id: string, tx?: Db): Promise<CompanyRow | null> {
    const { rows } = await (tx ?? this.database).query<CompanyRow>(
      `SELECT ${companyColumns()} FROM companies WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ?? null;
  }

  async lock(id: string, tx: Db): Promise<CompanyRow | null> {
    const { rows } = await tx.query<CompanyRow>(
      `SELECT ${companyColumns()} FROM companies WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findByNormalizedName(normalized: string, tx?: Db): Promise<CompanyRow | null> {
    const { rows } = await (tx ?? this.database).query<CompanyRow>(
      `SELECT ${companyColumns()} FROM companies WHERE name_normalized = $1 AND deleted_at IS NULL`,
      [normalized],
    );
    return rows[0] ?? null;
  }

  async list(filters: CompanyFilters): Promise<{ rows: CompanyListRow[]; total: number }> {
    const conditions = ['c.deleted_at IS NULL'];
    const values: unknown[] = [];

    if (!filters.include_inactive) conditions.push('c.is_active = true');
    if (filters.assigned_to) {
      values.push(filters.assigned_to);
      conditions.push(`c.assigned_user_id = $${values.length}::uuid`);
    }
    const query = filters.q?.trim();
    if (query) {
      values.push(`%${normalizeForSearch(query)}%`);
      const nameParam = values.length;
      const phone = normalizePhone(query);
      values.push(phone === '' ? null : `%${phone}%`);
      const phoneParam = values.length;
      conditions.push(
        `(c.name_normalized LIKE $${nameParam}` +
          ` OR ($${phoneParam}::text IS NOT NULL AND c.phone_normalized IS NOT NULL` +
          ` AND c.phone_normalized LIKE $${phoneParam}))`,
      );
    }

    const from = `
      FROM companies c
      LEFT JOIN users u ON u.id = c.assigned_user_id
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END), 0)
                 AS balance
          FROM company_ledger l
         WHERE l.company_id = c.id
      ) bal ON true
      LEFT JOIN LATERAL (
        SELECT r.rate_iqd_per_usd, r.effective_from
          FROM company_rates r
         WHERE r.company_id = c.id AND r.effective_from <= now()
         ORDER BY r.effective_from DESC
         LIMIT 1
      ) rate ON true`;
    const where = `WHERE ${conditions.join(' AND ')}`;

    const countValues = [...values];
    const pageSize = Math.min(filters.page_size ?? 25, 100);
    const offset = Math.max((filters.page ?? 1) - 1, 0) * pageSize;
    values.push(pageSize, offset);

    const order = filters.sort === 'balance' ? 'bal.balance DESC, c.name ASC' : 'c.name ASC';

    const [list, count] = await Promise.all([
      this.database.query<CompanyListRow>(
        `SELECT ${companyColumns('c')}, u.display_name AS assigned_user_name,
                bal.balance::text AS balance,
                rate.rate_iqd_per_usd::text AS rate_iqd_per_usd,
                rate.effective_from AS rate_since
         ${from} ${where}
         ORDER BY ${order}
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      ),
      this.database.query<{ total: string }>(`SELECT count(*)::text AS total ${from} ${where}`, countValues),
    ]);

    return { rows: list.rows, total: Number(count.rows[0]?.total ?? 0) };
  }

  async balanceOf(id: string, tx?: Db): Promise<number> {
    const { rows } = await (tx ?? this.database).query<{ balance: string }>(
      'SELECT balance::text AS balance FROM company_balances WHERE company_id = $1',
      [id],
    );
    return Number(rows[0]?.balance ?? 0);
  }

  async create(
    input: {
      name: string;
      contact_name: string | null;
      phone: string | null;
      address: string | null;
      notes: string | null;
      settlement_currency: Currency;
      assigned_user_id: string | null;
      created_by: string;
    },
    tx: Db,
  ): Promise<CompanyRow> {
    const { rows } = await tx.query<CompanyRow>(
      `INSERT INTO companies (name, name_normalized, contact_name, phone, phone_normalized, address,
                              notes, settlement_currency, assigned_user_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::currency, $9, $10, $10)
       RETURNING ${companyColumns()}`,
      [
        input.name,
        normalizeForSearch(input.name),
        input.contact_name,
        input.phone,
        input.phone ? normalizePhone(input.phone) || null : null,
        input.address,
        input.notes,
        input.settlement_currency,
        input.assigned_user_id,
        input.created_by,
      ],
    );
    return rows[0] as CompanyRow;
  }

  async update(
    id: string,
    version: number,
    patch: Partial<{
      name: string;
      contact_name: string | null;
      phone: string | null;
      address: string | null;
      notes: string | null;
      settlement_currency: Currency;
      assigned_user_id: string | null;
      is_active: boolean;
    }>,
    updatedBy: string,
    tx: Db,
  ): Promise<CompanyRow | null> {
    const fields = Object.keys(patch) as (keyof typeof patch)[];
    if (fields.length === 0) return this.lock(id, tx);

    const values: unknown[] = [id, version, updatedBy];
    const assignments: string[] = [];
    for (const field of fields) {
      values.push(patch[field] ?? null);
      assignments.push(`${field} = $${values.length}`);
      if (field === 'name') {
        values.push(normalizeForSearch(String(patch.name ?? '')));
        assignments.push(`name_normalized = $${values.length}`);
      }
      if (field === 'phone') {
        const phone = patch.phone ? normalizePhone(patch.phone) || null : null;
        values.push(phone);
        assignments.push(`phone_normalized = $${values.length}`);
      }
    }

    const { rows } = await tx.query<CompanyRow>(
      `UPDATE companies
          SET ${assignments.join(', ')}, updated_at = now(), updated_by = $3, version = version + 1
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL
        RETURNING ${companyColumns()}`,
      values,
    );
    return rows[0] ?? null;
  }

  async softDelete(id: string, version: number, deletedBy: string, tx: Db): Promise<CompanyRow | null> {
    const { rows } = await tx.query<CompanyRow>(
      `UPDATE companies
          SET deleted_at = now(), deleted_by = $3, updated_at = now(), updated_by = $3, version = version + 1
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL
        RETURNING ${companyColumns()}`,
      [id, version, deletedBy],
    );
    return rows[0] ?? null;
  }

  /** A company may only be hidden while nothing references it (A-32). */
  async isReferenced(id: string, tx?: Db): Promise<boolean> {
    const { rows } = await (tx ?? this.database).query<{ referenced: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM purchases WHERE company_id = $1)
           OR EXISTS (SELECT 1 FROM company_ledger WHERE company_id = $1)
           OR EXISTS (SELECT 1 FROM company_rates WHERE company_id = $1) AS referenced`,
      [id],
    );
    return rows[0]?.referenced ?? true;
  }

  // ─────────────────────────────── rates (FR-703) ───────────────────────────────

  /** The company's current rate, or null when it has never had one (then the global applies). */
  async currentRate(id: string, tx?: Db): Promise<{ rate: string; since: Date } | null> {
    const { rows } = await (tx ?? this.database).query<{ rate: string; since: Date }>(
      `SELECT rate_iqd_per_usd::text AS rate, effective_from AS since
         FROM company_rates
        WHERE company_id = $1 AND effective_from <= now()
        ORDER BY effective_from DESC
        LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async rateHistory(id: string, limit = 50) {
    const { rows } = await this.database.query<{
      id: string;
      rate_iqd_per_usd: string;
      effective_from: Date;
      note: string | null;
      created_by_name: string | null;
    }>(
      `SELECT r.id, r.rate_iqd_per_usd::text AS rate_iqd_per_usd, r.effective_from, r.note,
              u.display_name AS created_by_name
         FROM company_rates r
         LEFT JOIN users u ON u.id = r.created_by
        WHERE r.company_id = $1
        ORDER BY r.effective_from DESC
        LIMIT $2`,
      [id, Math.min(limit, 100)],
    );
    return rows;
  }

  async insertRate(
    input: { company_id: string; rate: string; note: string | null; created_by: string },
    tx: Db,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO company_rates (company_id, rate_iqd_per_usd, note, created_by)
       VALUES ($1, $2::numeric, $3, $4)`,
      [input.company_id, input.rate, input.note, input.created_by],
    );
  }

  /** The active purchases of a company, for the oldest-first allocation of FR-712. */
  async purchasesForAllocation(id: string, tx?: Db) {
    const { rows } = await (tx ?? this.database).query<{
      id: string;
      number: string;
      purchase_date: string;
      total_iqd: string;
      total_usd_cents: string;
      status: string;
    }>(
      `SELECT id, number::text AS number, to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date,
              total_iqd::text AS total_iqd, total_usd_cents::text AS total_usd_cents,
              status::text AS status
         FROM purchases
        WHERE company_id = $1 AND deleted_at IS NULL
        ORDER BY purchase_date ASC, number ASC`,
      [id],
    );
    return rows;
  }
}

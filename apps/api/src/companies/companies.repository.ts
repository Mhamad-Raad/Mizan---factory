import { Injectable } from '@nestjs/common';
import { normalizeForSearch, normalizePhone } from '@mizan/text';
import type { Currency } from '@mizan/money';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';
import { countFrom } from '../common/count-from.js';

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
 * The buying side of a business, read from `customers` (D-054): a "company" is a business with
 * `is_supplier`, and the record itself — creating, editing, assigning, its rate and its
 * settlement currency — belongs to the customers module. What stays here is what the buying
 * side reads: the supplier as the purchase and damage forms see it, its balance, its rate.
 *
 * There is no scope rule here: every user with `companies.view` sees every supplier (FR-711,
 * 2.6.4). The balance and the current rate are read per row through LATERALs, served by the
 * covering index of migration 0008 — the pattern the I1 review measured into place.
 */
@Injectable()
export class CompaniesRepository {
  constructor(private readonly database: Database) {}

  async findById(id: string, tx?: Db): Promise<CompanyRow | null> {
    const { rows } = await (tx ?? this.database).query<CompanyRow>(
      `SELECT ${companyColumns()} FROM customers companies WHERE id = $1 AND is_supplier AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ?? null;
  }

  async lock(id: string, tx: Db): Promise<CompanyRow | null> {
    const { rows } = await tx.query<CompanyRow>(
      `SELECT ${companyColumns()} FROM customers companies WHERE id = $1 AND is_supplier AND deleted_at IS NULL FOR UPDATE`,
      [id],
    );
    return rows[0] ?? null;
  }

  async list(filters: CompanyFilters): Promise<{ rows: CompanyListRow[]; total: number }> {
    const conditions = ['c.deleted_at IS NULL', 'c.is_supplier'];
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

    const assignee = 'LEFT JOIN users u ON u.id = c.assigned_user_id';
    const owed = `
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END), 0)
                 AS balance
          FROM company_ledger l
         WHERE l.company_id = c.id
      ) bal ON true`;
    const currentRate = `
      LEFT JOIN LATERAL (
        SELECT r.rate_iqd_per_usd, r.effective_from
          FROM customer_rates r
         WHERE r.customer_id = c.id AND r.effective_from <= now()
         ORDER BY r.effective_from DESC
         LIMIT 1
      ) rate ON true`;
    const from = `FROM customers c\n${assignee}${owed}${currentRate}`;
    const where = `WHERE ${conditions.join(' AND ')}`;
    // The count needs none of the three unless a filter mentions one (`countFrom`).
    const forCount = countFrom('FROM customers c', where, [
      { alias: 'u.', sql: assignee },
      { alias: 'bal.', sql: owed },
      { alias: 'rate.', sql: currentRate },
    ]);

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
      this.database.query<{ total: string }>(`SELECT count(*)::text AS total ${forCount} ${where}`, countValues),
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

  // ─────────────────────────────── rates (FR-703) ───────────────────────────────

  /** The business's current rate (one per business, D-054), or null: then the global applies. */
  async currentRate(id: string, tx?: Db): Promise<{ rate: string; since: Date } | null> {
    const { rows } = await (tx ?? this.database).query<{ rate: string; since: Date }>(
      `SELECT rate_iqd_per_usd::text AS rate, effective_from AS since
         FROM customer_rates
        WHERE customer_id = $1 AND effective_from <= now()
        ORDER BY effective_from DESC
        LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
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

import { Injectable } from '@nestjs/common';
import { normalizeForSearch, normalizePhone } from '@mizan/text';
import type { Currency } from '@mizan/money';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';
import type { CustomerRow } from './customer.types.js';
import { countFrom } from '../common/count-from.js';
import { pagingOf, type Paging } from '../common/paging.js';
import { containing } from '../common/like.js';

/** Alias-aware column list, so the same fields serve a plain read and the list query. */
function customerColumns(alias = 'customers'): string {
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
    'is_system',
    'credit_limit_iqd::text AS credit_limit_iqd',
    'credit_limit_usd_cents::text AS credit_limit_usd_cents',
    'is_active',
    'created_at',
    'updated_at',
    'deleted_at',
    'version',
  ]
    .map((field) => `${alias}.${field}`)
    .join(', ');
}

export interface CustomerFilters {
  q?: string;
  /** On the net figure: `owes` = they owe us, `credit` = we owe them, `settled` = zero (FR-505). */
  balance?: 'owes' | 'settled' | 'credit';
  include_inactive?: boolean;
  sort?: 'name' | 'balance';
  page?: number;
  page_size?: number;
}

export interface CustomerListRow extends CustomerRow {
  /** What they owe us, what we owe them, and the difference — all in the settlement currency. */
  balance: string;
  payable: string;
  net: string;
}

@Injectable()
export class CustomersRepository {
  constructor(private readonly database: Database) {}

  /**
   * An account by id. Every account is visible to whoever may see accounts (D-055, D-056), so
   * there is no scope to apply — the route's permission is the whole of the rule.
   */
  async findById(id: string, tx?: Db): Promise<CustomerRow | null> {
    const { rows } = await (tx ?? this.database).query<CustomerRow>(
      `SELECT ${customerColumns()} FROM customers WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ?? null;
  }


  async lock(id: string, tx: Db): Promise<CustomerRow | null> {
    const { rows } = await tx.query<CustomerRow>(
      `SELECT ${customerColumns()} FROM customers WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findSystemCustomer(tx?: Db): Promise<CustomerRow | null> {
    const { rows } = await (tx ?? this.database).query<CustomerRow>(
      `SELECT ${customerColumns()} FROM customers WHERE is_system AND deleted_at IS NULL`,
    );
    return rows[0] ?? null;
  }

  /**
   * The duplicate check of FR-501 runs over **all** accounts:
   * the directory must not fragment into twins because an employee cannot see the original.
   */
  async findDuplicates(
    name: string,
    tx?: Db,
  ): Promise<{ id: string; name: string }[]> {
    const { rows } = await (tx ?? this.database).query<{
      id: string;
      name: string;
    }>(
      `SELECT c.id, c.name
         FROM customers c
        WHERE c.deleted_at IS NULL AND c.name_normalized = $1
        ORDER BY c.created_at ASC
        LIMIT 5`,
      [normalizeForSearch(name)],
    );
    return rows;
  }

  async list(
    filters: CustomerFilters,
  ): Promise<{ rows: CustomerListRow[]; total: number }> {
    const conditions = ['c.deleted_at IS NULL'];
    const values: unknown[] = [];

    if (!filters.include_inactive) conditions.push('c.is_active = true');
    const query = filters.q?.trim();
    if (query) {
      values.push(containing(normalizeForSearch(query)));
      const nameParam = values.length;
      const phone = normalizePhone(query);
      values.push(phone === '' ? null : containing(phone));
      const phoneParam = values.length;
      conditions.push(
        `(c.name_normalized LIKE $${nameParam}` +
          ` OR ($${phoneParam}::text IS NOT NULL AND c.phone_normalized IS NOT NULL` +
          ` AND c.phone_normalized LIKE $${phoneParam}))`,
      );
    }
    // The filters and the sort read the net figure (D-054): "owes us" means after what we owe them.
    const net = '(bal.balance - pay.payable)';
    if (filters.balance === 'owes') conditions.push(`${net} > 0`);
    if (filters.balance === 'credit') conditions.push(`${net} < 0`);
    if (filters.balance === 'settled') conditions.push(`${net} = 0`);

    // The balance is a sum over the customer's own rows, which `customer_ledger_running_idx`
    // serves as one index scan per customer rather than an aggregate of the whole ledger.
    const balance = `
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END), 0)
                 AS balance
          FROM customer_ledger l
         WHERE l.customer_id = c.id
      ) bal ON true`;
    // What we owe them, from the buying side's ledger, served by `company_ledger_balance_idx`.
    const payable = `
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END), 0)
                 AS payable
          FROM company_ledger l
         WHERE l.company_id = c.id
      ) pay ON true`;
    const from = `FROM customers c\n${balance}${payable}`;
    const where = `WHERE ${conditions.join(' AND ')}`;
    // Counting thirty thousand customers does not need each one's balance summed — only a
    // filter on the balance does (`countFrom`, the system-wide review).
    const forCount = countFrom('FROM customers c', where, [
      { alias: 'bal.', sql: balance },
      { alias: 'pay.', sql: payable },
    ]);

    const countValues = [...values];
    const { page_size: pageSize, offset } = pagingOf(filters);
    values.push(pageSize, offset);

    const order = filters.sort === 'balance' ? `${net} DESC, c.name ASC` : 'c.name ASC';

    const [list, count] = await Promise.all([
      this.database.query<CustomerListRow>(
        `SELECT ${customerColumns('c')}, bal.balance::text AS balance,
                pay.payable::text AS payable, ${net}::text AS net
         ${from} ${where}
         ORDER BY ${order}
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      ),
      this.database.query<{ total: string }>(`SELECT count(*)::text AS total ${forCount} ${where}`, countValues),
    ]);

    return { rows: list.rows, total: Number(count.rows[0]?.total ?? 0) };
  }

  /** What we owe this account on the buying side (0 when we have never bought from it). */
  async payableOf(id: string, tx?: Db): Promise<number> {
    const { rows } = await (tx ?? this.database).query<{ payable: string }>(
      `SELECT payable::text AS payable FROM party_balances WHERE customer_id = $1`,
      [id],
    );
    return Number(rows[0]?.payable ?? 0);
  }

  /** The selling-side balance of one customer: the sum of the settlement-currency column (2.2.6). */
  async balanceOf(id: string, tx?: Db): Promise<number> {
    const { rows } = await (tx ?? this.database).query<{ balance: string }>(
      `SELECT balance::text AS balance FROM customer_balances WHERE customer_id = $1`,
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
      credit_limit_iqd: number | null;
      credit_limit_usd_cents: number | null;
      created_by: string;
    },
    tx: Db,
  ): Promise<CustomerRow> {
    const { rows } = await tx.query<CustomerRow>(
      `INSERT INTO customers (name, name_normalized, phone, phone_normalized, address, notes,
                              settlement_currency, credit_limit_iqd, credit_limit_usd_cents,
                              created_by, updated_by, contact_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7::currency, $8, $9, $10, $10, $11)
       RETURNING ${customerColumns()}`,
      [
        input.name,
        normalizeForSearch(input.name),
        input.phone,
        input.phone ? normalizePhone(input.phone) || null : null,
        input.address,
        input.notes,
        input.settlement_currency,
        input.credit_limit_iqd,
        input.credit_limit_usd_cents,
        input.created_by,
        input.contact_name,
      ],
    );
    return rows[0] as CustomerRow;
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
      credit_limit_iqd: number | null;
      credit_limit_usd_cents: number | null;
      is_active: boolean;
    }>,
    updatedBy: string,
    tx: Db,
  ): Promise<CustomerRow | null> {
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

    const { rows } = await tx.query<CustomerRow>(
      `UPDATE customers
          SET ${assignments.join(', ')}, updated_at = now(), updated_by = $3, version = version + 1
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL
        RETURNING ${customerColumns()}`,
      values,
    );
    return rows[0] ?? null;
  }

  async softDelete(id: string, version: number, deletedBy: string, tx: Db): Promise<CustomerRow | null> {
    const { rows } = await tx.query<CustomerRow>(
      `UPDATE customers
          SET deleted_at = now(), deleted_by = $3, updated_at = now(), updated_by = $3, version = version + 1
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL
        RETURNING ${customerColumns()}`,
      [id, version, deletedBy],
    );
    return rows[0] ?? null;
  }

  /** A business may only be hidden while nothing on either side references it (FR-507, A-32). */
  async isReferenced(id: string, tx?: Db): Promise<boolean> {
    const { rows } = await (tx ?? this.database).query<{ referenced: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM orders WHERE customer_id = $1)
           OR EXISTS (SELECT 1 FROM customer_ledger WHERE customer_id = $1)
           OR EXISTS (SELECT 1 FROM purchases WHERE company_id = $1)
           OR EXISTS (SELECT 1 FROM company_ledger WHERE company_id = $1)
           OR EXISTS (SELECT 1 FROM damages WHERE company_id = $1) AS referenced`,
      [id],
    );
    return rows[0]?.referenced ?? true;
  }

  // ─────────────────────────────── rates ───────────────────────────────

  /** The customer's current rate, or null when it has never had one (then the global applies). */
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

  /** One page of the account's rates, newest first, and how many there are in all (D-058). */
  async rateHistory(id: string, paging: Paging) {
    const { rows } = await this.database.query<{
      id: string;
      rate_iqd_per_usd: string;
      effective_from: Date;
      note: string | null;
      created_by_name: string | null;
      total: string;
    }>(
      `SELECT r.id, r.rate_iqd_per_usd::text AS rate_iqd_per_usd, r.effective_from, r.note,
              u.display_name AS created_by_name, count(*) OVER ()::text AS total
         FROM customer_rates r
         LEFT JOIN users u ON u.id = r.created_by
        WHERE r.customer_id = $1
        ORDER BY r.effective_from DESC, r.id DESC
        LIMIT $2 OFFSET $3`,
      [id, paging.page_size, paging.offset],
    );
    return { rows, total: rows.length > 0 ? Number(rows[0]?.total) : await this.rateCount(id) };
  }

  /** A page past the end has no row to carry the count; ask for it on its own. */
  private async rateCount(id: string): Promise<number> {
    const { rows } = await this.database.query<{ total: string }>(
      'SELECT count(*)::text AS total FROM customer_rates WHERE customer_id = $1',
      [id],
    );
    return Number(rows[0]?.total ?? 0);
  }

  async insertRate(
    input: { customer_id: string; rate: string; note: string | null; created_by: string },
    tx: Db,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO customer_rates (customer_id, rate_iqd_per_usd, note, created_by)
       VALUES ($1, $2::numeric, $3, $4)`,
      [input.customer_id, input.rate, input.note, input.created_by],
    );
  }
}

import { Injectable } from '@nestjs/common';
import { normalizeForSearch, normalizePhone } from '@mizan/text';
import type { Currency } from '@mizan/money';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';
import type { CustomerRow } from './customer.types.js';
import { countFrom } from '../common/count-from.js';

/** Alias-aware column list, so the same fields serve a plain read and the list query. */
function customerColumns(alias = 'customers'): string {
  return [
    'id',
    'name',
    'name_normalized',
    'phone',
    'phone_normalized',
    'address',
    'notes',
    'settlement_currency::text AS settlement_currency',
    'assigned_user_id',
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

/**
 * The scope of the caller (spec 2.6.4). It is applied *here*, in the repository, from the
 * request context — never in a controller — so no list, search or picker can forget it.
 */
export interface CustomerScope {
  userId: string;
  /** `customers.view_all`: sees every customer. Otherwise only their own, plus the walk-in. */
  viewAll: boolean;
}

export interface CustomerFilters {
  q?: string;
  assigned_to?: string;
  /** `owes` = the customer owes us, `credit` = we owe them, `settled` = zero (FR-505). */
  balance?: 'owes' | 'settled' | 'credit';
  include_inactive?: boolean;
  sort?: 'name' | 'balance';
  page?: number;
  page_size?: number;
}

export interface CustomerListRow extends CustomerRow {
  assigned_user_name: string | null;
  balance: string;
}

@Injectable()
export class CustomersRepository {
  constructor(private readonly database: Database) {}

  /**
   * A customer the caller may open. Out of scope returns null so the service can answer 404
   * rather than 403: a "forbidden" would confirm that the customer exists (spec 2.6.4).
   */
  async findById(id: string, scope: CustomerScope, tx?: Db): Promise<CustomerRow | null> {
    const { rows } = await (tx ?? this.database).query<CustomerRow>(
      `SELECT ${customerColumns()} FROM customers
        WHERE id = $1 AND deleted_at IS NULL
          AND ($2::boolean OR is_system OR assigned_user_id = $3::uuid)`,
      [id, scope.viewAll, scope.userId],
    );
    return rows[0] ?? null;
  }

  /** Unscoped read, for the paths that must see every customer: duplicate checks and admin. */
  async findByIdUnscoped(id: string, tx?: Db): Promise<CustomerRow | null> {
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
   * The duplicate check of FR-501 runs over **all** customers whatever the caller's scope:
   * the directory must not fragment into twins because an employee cannot see the original.
   * The assignee's name comes back so the warning can say "ask your admin".
   */
  async findDuplicates(
    name: string,
    tx?: Db,
  ): Promise<{ id: string; name: string; assigned_user_id: string | null; assigned_user_name: string | null }[]> {
    const { rows } = await (tx ?? this.database).query<{
      id: string;
      name: string;
      assigned_user_id: string | null;
      assigned_user_name: string | null;
    }>(
      `SELECT c.id, c.name, c.assigned_user_id, u.display_name AS assigned_user_name
         FROM customers c
         LEFT JOIN users u ON u.id = c.assigned_user_id
        WHERE c.deleted_at IS NULL AND c.name_normalized = $1
        ORDER BY c.created_at ASC
        LIMIT 5`,
      [normalizeForSearch(name)],
    );
    return rows;
  }

  async list(
    filters: CustomerFilters,
    scope: CustomerScope,
  ): Promise<{ rows: CustomerListRow[]; total: number }> {
    const conditions = ['c.deleted_at IS NULL'];
    const values: unknown[] = [];

    // Scope first, so every later condition narrows an already-permitted set (spec 2.6.4).
    if (!scope.viewAll) {
      values.push(scope.userId);
      conditions.push(`(c.is_system OR c.assigned_user_id = $${values.length}::uuid)`);
    }
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
    if (filters.balance === 'owes') conditions.push('bal.balance > 0');
    if (filters.balance === 'credit') conditions.push('bal.balance < 0');
    if (filters.balance === 'settled') conditions.push('bal.balance = 0');

    // The balance is a sum over the customer's own rows, which `customer_ledger_running_idx`
    // serves as one index scan per customer rather than an aggregate of the whole ledger.
    const assignee = 'LEFT JOIN users u ON u.id = c.assigned_user_id';
    const balance = `
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END), 0)
                 AS balance
          FROM customer_ledger l
         WHERE l.customer_id = c.id
      ) bal ON true`;
    const from = `FROM customers c\n${assignee}${balance}`;
    const where = `WHERE ${conditions.join(' AND ')}`;
    // Counting thirty thousand customers does not need each one's balance summed — only a
    // filter on the balance does (`countFrom`, the system-wide review).
    const forCount = countFrom('FROM customers c', where, [
      { alias: 'u.', sql: assignee },
      { alias: 'bal.', sql: balance },
    ]);

    const countValues = [...values];
    const pageSize = Math.min(filters.page_size ?? 25, 100);
    const offset = Math.max((filters.page ?? 1) - 1, 0) * pageSize;
    values.push(pageSize, offset);

    const order = filters.sort === 'balance' ? 'bal.balance DESC, c.name ASC' : 'c.name ASC';

    const [list, count] = await Promise.all([
      this.database.query<CustomerListRow>(
        `SELECT ${customerColumns('c')}, u.display_name AS assigned_user_name, bal.balance::text AS balance
         ${from} ${where}
         ORDER BY ${order}
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      ),
      this.database.query<{ total: string }>(`SELECT count(*)::text AS total ${forCount} ${where}`, countValues),
    ]);

    return { rows: list.rows, total: Number(count.rows[0]?.total ?? 0) };
  }

  /** The balance of one customer: the sum of the settlement-currency column (spec 2.2.6). */
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
      phone: string | null;
      address: string | null;
      notes: string | null;
      settlement_currency: Currency;
      assigned_user_id: string | null;
      credit_limit_iqd: number | null;
      credit_limit_usd_cents: number | null;
      created_by: string;
    },
    tx: Db,
  ): Promise<CustomerRow> {
    const { rows } = await tx.query<CustomerRow>(
      `INSERT INTO customers (name, name_normalized, phone, phone_normalized, address, notes,
                              settlement_currency, assigned_user_id, credit_limit_iqd,
                              credit_limit_usd_cents, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::currency, $8, $9, $10, $11, $11)
       RETURNING ${customerColumns()}`,
      [
        input.name,
        normalizeForSearch(input.name),
        input.phone,
        input.phone ? normalizePhone(input.phone) || null : null,
        input.address,
        input.notes,
        input.settlement_currency,
        input.assigned_user_id,
        input.credit_limit_iqd,
        input.credit_limit_usd_cents,
        input.created_by,
      ],
    );
    return rows[0] as CustomerRow;
  }

  async update(
    id: string,
    version: number,
    patch: Partial<{
      name: string;
      phone: string | null;
      address: string | null;
      notes: string | null;
      settlement_currency: Currency;
      assigned_user_id: string | null;
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

  /** A customer may only be hidden while nothing references them (FR-507, A-32). */
  async isReferenced(id: string, tx?: Db): Promise<boolean> {
    const { rows } = await (tx ?? this.database).query<{ referenced: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM orders WHERE customer_id = $1)
           OR EXISTS (SELECT 1 FROM customer_ledger WHERE customer_id = $1) AS referenced`,
      [id],
    );
    return rows[0]?.referenced ?? true;
  }
}

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
    'contact_name',
    'is_customer',
    'is_supplier',
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
  /**
   * `companies.view`: sees every supplier. Suppliers were never scoped (FR-711) and still are
   * not — a warehouse employee records purchases from any of them — so a record that is a
   * supplier is visible to them even when it is also somebody else's customer (D-054).
   */
  seesSuppliers: boolean;
}

/** The scope predicate over alias `c`, with the caller's values at `$userParam`, `$suppliersParam`. */
function scopeCondition(alias: string, userParam: number, suppliersParam: number): string {
  return (
    `(${alias}.is_system OR ${alias}.assigned_user_id = $${userParam}::uuid` +
    ` OR (${alias}.is_supplier AND $${suppliersParam}::boolean))`
  );
}

export interface CustomerFilters {
  q?: string;
  /** One side of the business: the order form asks for customers, the purchase form suppliers. */
  side?: 'customer' | 'supplier';
  assigned_to?: string;
  /** On the net figure: `owes` = they owe us, `credit` = we owe them, `settled` = zero (FR-505). */
  balance?: 'owes' | 'settled' | 'credit';
  include_inactive?: boolean;
  sort?: 'name' | 'balance';
  page?: number;
  page_size?: number;
}

export interface CustomerListRow extends CustomerRow {
  assigned_user_name: string | null;
  /** What they owe us, what we owe them, and the difference — all in the settlement currency. */
  balance: string;
  payable: string;
  net: string;
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
          AND ($2::boolean OR ${scopeCondition('customers', 3, 4)})`,
      [id, scope.viewAll, scope.userId, scope.seesSuppliers],
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
      values.push(scope.userId, scope.seesSuppliers);
      conditions.push(scopeCondition('c', values.length - 1, values.length));
    }
    if (filters.side === 'customer') conditions.push('c.is_customer');
    if (filters.side === 'supplier') conditions.push('c.is_supplier');
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
    // The filters and the sort read the net figure (D-054): "owes us" means after what we owe them.
    const net = '(bal.balance - pay.payable)';
    if (filters.balance === 'owes') conditions.push(`${net} > 0`);
    if (filters.balance === 'credit') conditions.push(`${net} < 0`);
    if (filters.balance === 'settled') conditions.push(`${net} = 0`);

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
    // What we owe them, from the buying side's ledger, served by `company_ledger_balance_idx`.
    const payable = `
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(CASE WHEN c.settlement_currency = 'IQD' THEN l.amount_iqd ELSE l.amount_usd_cents END), 0)
                 AS payable
          FROM company_ledger l
         WHERE l.company_id = c.id
      ) pay ON true`;
    const from = `FROM customers c\n${assignee}${balance}${payable}`;
    const where = `WHERE ${conditions.join(' AND ')}`;
    // Counting thirty thousand customers does not need each one's balance summed — only a
    // filter on the balance does (`countFrom`, the system-wide review).
    const forCount = countFrom('FROM customers c', where, [
      { alias: 'u.', sql: assignee },
      { alias: 'bal.', sql: balance },
      { alias: 'pay.', sql: payable },
    ]);

    const countValues = [...values];
    const pageSize = Math.min(filters.page_size ?? 25, 100);
    const offset = Math.max((filters.page ?? 1) - 1, 0) * pageSize;
    values.push(pageSize, offset);

    const order = filters.sort === 'balance' ? `${net} DESC, c.name ASC` : 'c.name ASC';

    const [list, count] = await Promise.all([
      this.database.query<CustomerListRow>(
        `SELECT ${customerColumns('c')}, u.display_name AS assigned_user_name, bal.balance::text AS balance,
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

  /** What we owe this business on the buying side (0 when it has never been a supplier). */
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
      is_customer: boolean;
      is_supplier: boolean;
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
                              credit_limit_usd_cents, created_by, updated_by,
                              contact_name, is_customer, is_supplier)
       VALUES ($1, $2, $3, $4, $5, $6, $7::currency, $8, $9, $10, $11, $11, $12, $13, $14)
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
        input.contact_name,
        input.is_customer,
        input.is_supplier,
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
      is_customer: boolean;
      is_supplier: boolean;
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
         FROM customer_rates r
         LEFT JOIN users u ON u.id = r.created_by
        WHERE r.customer_id = $1
        ORDER BY r.effective_from DESC
        LIMIT $2`,
      [id, Math.min(limit, 100)],
    );
    return rows;
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

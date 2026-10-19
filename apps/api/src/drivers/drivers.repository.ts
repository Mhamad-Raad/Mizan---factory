import { Injectable } from '@nestjs/common';
import { normalizeForSearch, normalizePhone } from '@mizan/text';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';
import { pagingOf } from '../common/paging.js';
import { containing } from '../common/like.js';

export interface DriverRow {
  id: string;
  name: string;
  phone: string | null;
  car_number: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  version: number;
}

export interface DriverListRow extends DriverRow {
  /** The date of the newest sale or purchase that names this driver, or null before the first. */
  last_order_date: string | null;
}

export interface DriverFilters {
  q?: string;
  /** `active` (the default) for the order form's picker, `inactive` for the Deactivated filter. */
  status?: 'active' | 'inactive' | 'all';
  page?: number;
  page_size?: number;
}

export type DriverPatch = Partial<{
  name: string;
  phone: string | null;
  car_number: string | null;
  notes: string | null;
  is_active: boolean;
}>;

const COLUMNS = [
  'id',
  'name',
  'phone',
  'car_number',
  'notes',
  'is_active',
  'created_at',
  'updated_at',
  'version',
];

function driverColumns(alias = 'drivers'): string {
  return COLUMNS.map((column) => `${alias}.${column}`).join(', ');
}

/**
 * The drivers an order may be sent with (D-105). A driver is never deleted — the orders that name
 * them keep doing so — so every read here is of the live rows, and "gone" is `is_active = false`.
 */
@Injectable()
export class DriversRepository {
  constructor(private readonly database: Database) {}

  async findById(id: string, tx?: Db): Promise<DriverRow | null> {
    const { rows } = await (tx ?? this.database).query<DriverRow>(
      `SELECT ${driverColumns()} FROM drivers WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ?? null;
  }

  async lock(id: string, tx: Db): Promise<DriverRow | null> {
    const { rows } = await tx.query<DriverRow>(
      `SELECT ${driverColumns()} FROM drivers WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * A driver an order or a purchase is being saved with, held against a deactivation until the order commits.
   * A share lock: two documents for the same driver do not wait for each other.
   */
  async holdForOrder(id: string, tx: Db): Promise<DriverRow | null> {
    const { rows } = await tx.query<DriverRow>(
      `SELECT ${driverColumns()} FROM drivers WHERE id = $1 AND deleted_at IS NULL FOR SHARE`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * A page of drivers by name. The search reads the name (trigram index), the phone and the car
   * number; each row carries the date of its newest sale or purchase, one probe each of
   * `orders_driver_idx` and `purchases_driver_idx`.
   */
  async list(filters: DriverFilters): Promise<{ rows: DriverListRow[]; total: number }> {
    const conditions = ['d.deleted_at IS NULL'];
    const values: unknown[] = [];
    const status = filters.status ?? 'active';
    if (status === 'active') conditions.push('d.is_active');
    if (status === 'inactive') conditions.push('NOT d.is_active');

    const query = filters.q?.trim();
    if (query) {
      values.push(containing(normalizeForSearch(query)));
      const nameParam = values.length;
      const phone = normalizePhone(query);
      values.push(phone === '' ? null : containing(phone));
      const phoneParam = values.length;
      values.push(containing(query));
      const textParam = values.length;
      conditions.push(
        `(d.name_normalized LIKE $${nameParam}` +
          ` OR ($${phoneParam}::text IS NOT NULL AND d.phone_normalized LIKE $${phoneParam})` +
          ` OR d.car_number ILIKE $${textParam})`,
      );
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const countValues = [...values];
    const { page_size: pageSize, offset } = pagingOf(filters);
    values.push(pageSize, offset);

    const [list, count] = await Promise.all([
      this.database.query<DriverListRow>(
        `SELECT ${driverColumns('d')},
                to_char(greatest(
                  (SELECT o.order_date FROM orders o
                    WHERE o.driver_id = d.id AND o.deleted_at IS NULL
                    ORDER BY o.order_date DESC, o.number DESC LIMIT 1),
                  (SELECT p.purchase_date FROM purchases p
                    WHERE p.driver_id = d.id AND p.deleted_at IS NULL
                    ORDER BY p.purchase_date DESC, p.number DESC LIMIT 1)
                ), 'YYYY-MM-DD') AS last_order_date
           FROM drivers d
           ${where}
          ORDER BY d.name_normalized ASC, d.id ASC
          LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      ),
      this.database.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM drivers d ${where}`,
        countValues,
      ),
    ]);
    return { rows: list.rows, total: Number(count.rows[0]?.total ?? 0) };
  }

  /** The other live drivers with this phone, for the "already used by" warning. */
  async withPhone(
    phone: string,
    exceptId: string | null,
    tx?: Db,
  ): Promise<{ id: string; name: string }[]> {
    const normalized = normalizePhone(phone);
    if (normalized === '') return [];
    const { rows } = await (tx ?? this.database).query<{ id: string; name: string }>(
      `SELECT id, name FROM drivers
        WHERE phone_normalized = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)
        ORDER BY name_normalized, id
        LIMIT 5`,
      [normalized, exceptId],
    );
    return rows;
  }

  async create(
    input: {
      name: string;
      phone: string | null;
      car_number: string | null;
      notes: string | null;
      created_by: string;
    },
    tx: Db,
  ): Promise<DriverRow> {
    const { rows } = await tx.query<DriverRow>(
      `INSERT INTO drivers (name, name_normalized, phone, phone_normalized, car_number, notes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING ${driverColumns()}`,
      [
        input.name,
        normalizeForSearch(input.name),
        input.phone,
        input.phone ? normalizePhone(input.phone) || null : null,
        input.car_number,
        input.notes,
        input.created_by,
      ],
    );
    return rows[0] as DriverRow;
  }

  async update(
    id: string,
    version: number,
    patch: DriverPatch,
    updatedBy: string,
    tx: Db,
  ): Promise<DriverRow | null> {
    const fields = Object.keys(patch) as (keyof DriverPatch)[];
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
        values.push(patch.phone ? normalizePhone(patch.phone) || null : null);
        assignments.push(`phone_normalized = $${values.length}`);
      }
    }

    const { rows } = await tx.query<DriverRow>(
      `UPDATE drivers
          SET ${assignments.join(', ')}, updated_at = now(), updated_by = $3, version = version + 1
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL
        RETURNING ${driverColumns()}`,
      values,
    );
    return rows[0] ?? null;
  }
}

import { Injectable } from '@nestjs/common';
import { normalizeForSearch, normalizePhone } from '@mizan/text';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';
import type { DirectoryEntryDto, UserRole, UserRow } from './user.types.js';

const COLUMNS = `id, username::text AS username, phone, display_name, role, password_hash,
                 must_change_password, pin_hash, pin_length, preset_key, preset_version,
                 is_active, last_login_at, failed_login_count, locked_until,
                 created_at, updated_at, deleted_at, version`;

export interface UserFilters {
  q?: string;
  include_inactive?: boolean;
  page?: number;
  page_size?: number;
}

/**
 * All SQL for users lives here (decision D-008). Every statement is parameterised and every
 * list excludes soft-deleted rows by default (spec 2.2.1, 2.13).
 */
@Injectable()
export class UsersRepository {
  constructor(private readonly database: Database) {}

  async findById(id: string, tx?: Db): Promise<UserRow | null> {
    const { rows } = await (tx ?? this.database).query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** Sign-in accepts the username or the phone number as an alias of it (FR-101). */
  async findByUsernameOrPhone(identifier: string): Promise<UserRow | null> {
    const username = identifier.trim().toLowerCase();
    const phone = normalizePhone(identifier);
    const { rows } = await this.database.query<UserRow>(
      `SELECT ${COLUMNS} FROM users
        WHERE deleted_at IS NULL
          AND (username = $1 OR ($2::text IS NOT NULL AND phone IS NOT NULL AND phone = $2))
        LIMIT 1`,
      [username, phone === '' ? null : phone],
    );
    return rows[0] ?? null;
  }

  async findByUsername(username: string, tx?: Db): Promise<UserRow | null> {
    const { rows } = await (tx ?? this.database).query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE username = $1 AND deleted_at IS NULL`,
      [username.toLowerCase()],
    );
    return rows[0] ?? null;
  }

  async findByPhone(phone: string, tx?: Db): Promise<UserRow | null> {
    const normalized = normalizePhone(phone);
    if (normalized === '') return null;
    const { rows } = await (tx ?? this.database).query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE phone = $1 AND deleted_at IS NULL`,
      [normalized],
    );
    return rows[0] ?? null;
  }

  async list(filters: UserFilters): Promise<{ rows: UserRow[]; total: number }> {
    const conditions = ['deleted_at IS NULL'];
    const values: unknown[] = [];

    if (!filters.include_inactive) conditions.push('is_active = true');

    const query = filters.q?.trim();
    if (query) {
      // Names are matched after script normalisation, so a name typed on an Arabic keyboard
      // is found from a Kurdish one (FR-1205, FR-206).
      values.push(`%${normalizeForSearch(query)}%`);
      const nameParam = values.length;
      const phone = normalizePhone(query);
      values.push(phone === '' ? null : `%${phone}%`);
      const phoneParam = values.length;
      conditions.push(
        `(display_name_normalized LIKE $${nameParam}` +
          ` OR username::text LIKE $${nameParam}` +
          ` OR ($${phoneParam}::text IS NOT NULL AND phone IS NOT NULL AND phone LIKE $${phoneParam}))`,
      );
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const pageSize = Math.min(filters.page_size ?? 25, 100);
    const offset = Math.max((filters.page ?? 1) - 1, 0) * pageSize;
    values.push(pageSize, offset);

    const [list, count] = await Promise.all([
      this.database.query<UserRow>(
        `SELECT ${COLUMNS} FROM users ${where} ORDER BY display_name ASC LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      ),
      this.database.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM users ${where}`,
        values.slice(0, values.length - 2),
      ),
    ]);
    return { rows: list.rows, total: Number(count.rows[0]?.total ?? 0) };
  }

  /** Any signed-in user may read the directory, for "Done by" pickers (spec 2.7). */
  async directory(): Promise<DirectoryEntryDto[]> {
    const { rows } = await this.database.query<DirectoryEntryDto>(
      `SELECT id, display_name, role, is_active FROM users WHERE deleted_at IS NULL ORDER BY display_name ASC`,
    );
    return rows;
  }

  async create(
    input: {
      username: string;
      display_name: string;
      phone: string | null;
      role: UserRole;
      password_hash: string;
      preset_key: string | null;
      preset_version: number | null;
      created_by: string;
    },
    tx?: Db,
  ): Promise<UserRow> {
    const { rows } = await (tx ?? this.database).query<UserRow>(
      `INSERT INTO users (username, display_name, display_name_normalized, phone, role, password_hash,
                          preset_key, preset_version, must_change_password, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $9)
       RETURNING ${COLUMNS}`,
      [
        input.username.toLowerCase(),
        input.display_name,
        normalizeForSearch(input.display_name),
        input.phone,
        input.role,
        input.password_hash,
        input.preset_key,
        input.preset_version,
        input.created_by,
      ],
    );
    return rows[0] as UserRow;
  }

  /**
   * Optimistic locking: the update applies only when the version the client sent is still the
   * current one, so two admins editing the same employee cannot overwrite each other silently
   * (FR-1308). A null return means the version was stale.
   */
  async update(
    id: string,
    version: number,
    patch: Partial<
      Pick<
        UserRow,
        | 'username'
        | 'display_name'
        | 'phone'
        | 'role'
        | 'preset_key'
        | 'preset_version'
        | 'is_active'
        | 'must_change_password'
        | 'password_hash'
        | 'pin_hash'
        | 'pin_length'
      >
    >,
    updatedBy: string,
    tx?: Db,
  ): Promise<UserRow | null> {
    const fields = Object.keys(patch) as (keyof typeof patch)[];
    if (fields.length === 0) return this.findById(id, tx);

    const values: unknown[] = [id, version, updatedBy];
    const assignments: string[] = [];
    for (const field of fields) {
      values.push(patch[field] ?? null);
      assignments.push(`${field} = $${values.length}`);
      if (field === 'display_name') {
        values.push(normalizeForSearch(String(patch.display_name ?? '')));
        assignments.push(`display_name_normalized = $${values.length}`);
      }
    }

    const { rows } = await (tx ?? this.database).query<UserRow>(
      `UPDATE users
          SET ${assignments.join(', ')}, updated_at = now(), updated_by = $3, version = version + 1
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL
        RETURNING ${COLUMNS}`,
      values,
    );
    return rows[0] ?? null;
  }

  /** The system always keeps at least one active admin (FR-107). */
  async countActiveAdmins(excludingId: string | null, tx?: Db): Promise<number> {
    const { rows } = await (tx ?? this.database).query<{ count: string }>(
      `SELECT count(*)::text AS count FROM users
        WHERE role = 'admin' AND is_active = true AND deleted_at IS NULL
          AND ($1::uuid IS NULL OR id <> $1::uuid)`,
      [excludingId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async permissionsOf(userId: string, tx?: Db): Promise<string[]> {
    const { rows } = await (tx ?? this.database).query<{ permission_key: string }>(
      'SELECT permission_key FROM user_permissions WHERE user_id = $1 ORDER BY permission_key',
      [userId],
    );
    return rows.map((row) => row.permission_key);
  }

  /** The whole set is replaced at once, inside the caller's transaction (spec 2.6.5). */
  async replacePermissions(userId: string, keys: readonly string[], grantedBy: string, tx: Db): Promise<void> {
    await tx.query('DELETE FROM user_permissions WHERE user_id = $1', [userId]);
    if (keys.length === 0) return;
    const placeholders = keys.map((_, index) => `($1, $${index + 3}, $2)`).join(', ');
    await tx.query(`INSERT INTO user_permissions (user_id, permission_key, granted_by) VALUES ${placeholders}`, [
      userId,
      grantedBy,
      ...keys,
    ]);
  }

  async recordLoginAttempt(
    input: { username: string; userId: string | null; ip: string | null; succeeded: boolean },
    tx?: Db,
  ): Promise<void> {
    await (tx ?? this.database).query(
      'INSERT INTO login_attempts (username_attempted, user_id, ip, succeeded) VALUES ($1, $2, $3, $4)',
      [input.username, input.userId, input.ip, input.succeeded],
    );
  }

  async recentFailures(username: string, withinMinutes: number): Promise<number> {
    const { rows } = await this.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM login_attempts
        WHERE username_attempted = $1 AND succeeded = false
          AND attempted_at > now() - make_interval(mins => $2::int)`,
      [username, withinMinutes],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async markSignedIn(id: string, tx?: Db): Promise<void> {
    await (tx ?? this.database).query(
      'UPDATE users SET last_login_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = $1',
      [id],
    );
  }

  async registerFailure(id: string, lockUntil: Date | null, tx?: Db): Promise<void> {
    await (tx ?? this.database).query(
      'UPDATE users SET failed_login_count = failed_login_count + 1, locked_until = $2 WHERE id = $1',
      [id, lockUntil],
    );
  }
}

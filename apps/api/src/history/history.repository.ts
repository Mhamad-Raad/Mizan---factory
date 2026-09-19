import { Injectable } from '@nestjs/common';
import { Database } from '../database/pool.js';

export interface AuditRow {
  id: string;
  occurred_at: Date;
  actor_user_id: string | null;
  actor_display_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  entity_label: string;
  changes: Record<string, unknown>;
  note: string | null;
  related: Record<string, string>;
  request_id: string;
  auth_method: string | null;
}

export interface HistoryFilters {
  done_by?: string;
  from?: string;
  to?: string;
  entity_type?: string;
  entity_id?: string;
  action?: string;
  /** Cursor pagination keeps infinite scroll stable while new rows arrive (spec 2.9.1). */
  cursor?: string;
  limit?: number;
}

@Injectable()
export class HistoryRepository {
  constructor(private readonly database: Database) {}

  /**
   * History is read far more often than anything else and grows without bound (2 million rows
   * over five years, NFR-13). The query is therefore keyset-paginated on the primary key and
   * ordered by `occurred_at DESC, id DESC`, which the `audit_log_occurred_idx` index serves
   * directly — no OFFSET, so page 10,000 costs what page 1 costs.
   */
  async list(filters: HistoryFilters): Promise<{ items: AuditRow[]; next_cursor: string | null }> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filters.done_by) {
      values.push(filters.done_by);
      conditions.push(`a.actor_user_id = $${values.length}`);
    }
    if (filters.from) {
      // Business days are Asia/Baghdad days, whatever the server's time zone (spec 2.9.4).
      values.push(filters.from);
      conditions.push(`(a.occurred_at AT TIME ZONE 'Asia/Baghdad')::date >= $${values.length}::date`);
    }
    if (filters.to) {
      values.push(filters.to);
      conditions.push(`(a.occurred_at AT TIME ZONE 'Asia/Baghdad')::date <= $${values.length}::date`);
    }
    if (filters.entity_type) {
      values.push(filters.entity_type);
      conditions.push(`a.entity_type = $${values.length}`);
    }
    if (filters.entity_id) {
      values.push(filters.entity_id);
      conditions.push(`a.entity_id = $${values.length}`);
    }
    if (filters.action) {
      values.push(filters.action);
      conditions.push(`a.action = $${values.length}::audit_action`);
    }
    if (filters.cursor) {
      values.push(filters.cursor);
      conditions.push(`a.id < $${values.length}::bigint`);
    }

    const limit = Math.min(filters.limit ?? 50, 100);
    values.push(limit + 1);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await this.database.query<AuditRow>(
      `SELECT a.id::text AS id, a.occurred_at, a.actor_user_id, u.display_name AS actor_display_name,
              a.action::text AS action, a.entity_type, a.entity_id, a.entity_label,
              a.changes, a.note, a.related, a.request_id::text AS request_id,
              a.auth_method::text AS auth_method
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.actor_user_id
         ${where}
        ORDER BY a.id DESC
        LIMIT $${values.length}`,
      values,
    );

    const items = rows.slice(0, limit);
    const next = rows.length > limit ? (items[items.length - 1]?.id ?? null) : null;
    return { items, next_cursor: next };
  }
}

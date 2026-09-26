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
  /**
   * The employee the *record* is assigned to, which is a different question from who did it
   * (spec 2.9.4): it reads `related.assigned_user_id`, written by every audit row that belongs
   * to a customer or a company, and is served by the GIN index on `related`.
   */
  assigned_to?: string;
  from?: string;
  to?: string;
  entity_type?: string;
  entity_id?: string;
  /**
   * Everything that happened *about* one order: its own rows, and the rows filed under
   * something else that name it in `related` — the payments and reversals recorded against it
   * (filed under the customer), and the damage reported from it. Both halves are index scans:
   * `audit_log_entity_idx` and the GIN index on `related`.
   */
  about_order?: string;
  action?: string;
  /** Collapse an edit storm into one entry per record (spec 2.4.5, last row). */
  group_edits?: boolean;
  /**
   * Keyset cursor, `<occurred_at ISO>|<id>`. Cursor pagination keeps infinite scroll stable
   * while new rows arrive (spec 2.9.1) and, unlike OFFSET, does not get slower page by page.
   */
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
  async list(filters: HistoryFilters): Promise<{ items: AuditEntry[]; next_cursor: string | null }> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filters.done_by) {
      values.push(filters.done_by);
      conditions.push(`a.actor_user_id = $${values.length}`);
    }
    // Containment rather than `->>`: `audit_log_related_idx` is a GIN index on the whole
    // document, so `related @> {...}` is an index scan while a field extraction is a filter.
    if (filters.assigned_to) {
      values.push(JSON.stringify({ assigned_user_id: filters.assigned_to }));
      conditions.push(`a.related @> $${values.length}::jsonb`);
    }
    // Business days are Asia/Baghdad days, whatever the server's time zone (spec 2.9.4).
    //
    // The bound is converted to an instant rather than the column being converted to a date:
    // wrapping `occurred_at` in an expression makes the predicate unusable by
    // `audit_log_occurred_idx`, and at the design volume of two million rows (NFR-13) that is
    // the difference between an index scan and reading the whole table on every filter.
    if (filters.from) {
      values.push(filters.from);
      conditions.push(`a.occurred_at >= ($${values.length}::date::timestamp AT TIME ZONE 'Asia/Baghdad')`);
    }
    if (filters.to) {
      values.push(filters.to);
      conditions.push(
        `a.occurred_at < (($${values.length}::date + 1)::timestamp AT TIME ZONE 'Asia/Baghdad')`,
      );
    }
    if (filters.entity_type) {
      values.push(filters.entity_type);
      conditions.push(`a.entity_type = $${values.length}`);
    }
    if (filters.entity_id) {
      values.push(filters.entity_id);
      conditions.push(`a.entity_id = $${values.length}`);
    }
    if (filters.about_order) {
      values.push(filters.about_order, JSON.stringify({ order_id: filters.about_order }));
      conditions.push(
        `((a.entity_type = 'order' AND a.entity_id = $${values.length - 1}) OR a.related @> $${values.length}::jsonb)`,
      );
    }
    if (filters.action) {
      values.push(filters.action);
      conditions.push(`a.action = $${values.length}::audit_action`);
    }
    if (filters.cursor) {
      const [occurredAt, id] = filters.cursor.split('|');
      values.push(occurredAt, id);
      // Row-value comparison matches the composite index exactly, so this is a range start
      // rather than a filter.
      conditions.push(`(a.occurred_at, a.id) < ($${values.length - 1}::timestamptz, $${values.length}::bigint)`);
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
        ORDER BY a.occurred_at DESC, a.id DESC
        LIMIT $${values.length}`,
      values,
    );

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const next = rows.length > limit && last ? `${last.occurred_at.toISOString()}|${last.id}` : null;
    return { items: filters.group_edits ? groupEdits(page) : page.map(single), next_cursor: next };
  }
}

/** One entry on the History page: a row, or a run of edits to the same record (spec 2.4.5). */
export interface AuditEntry extends AuditRow {
  /** How many audit rows this entry stands for; 1 for everything that is not an edit run. */
  group_size: number;
  /** The rows behind it, newest first — the same shape the ledger's groups use. */
  rows: AuditRow[];
}

function single(row: AuditRow): AuditEntry {
  return { ...row, group_size: 1, rows: [row] };
}

/**
 * "The same grouping applies to audit rows of edits: one 'edited' entry with the field diff,
 * expandable to the details" (spec 2.4.5).
 *
 * Only *adjacent* update rows of the same record by the same person collapse, and the newest
 * one leads — so the entry shows the state the record is in now, and expanding it tells the
 * story of how it got there. Adjacency is what keeps this honest: a payment recorded between
 * two edits breaks the run, because the reader needs to see it in order.
 *
 * A run that straddles a page boundary comes back as two entries, one per page. Keyset
 * pagination cannot know what is on the next page without fetching it, and an entry that
 * changes shape when more is loaded would be worse than one that is split (D-028).
 */
export function groupEdits(rows: readonly AuditRow[]): AuditEntry[] {
  const entries: AuditEntry[] = [];
  for (const row of rows) {
    const previous = entries[entries.length - 1];
    const sameRecord =
      previous &&
      previous.action === 'update' &&
      row.action === 'update' &&
      previous.entity_type === row.entity_type &&
      previous.entity_id === row.entity_id &&
      previous.actor_user_id === row.actor_user_id;

    if (sameRecord && previous) {
      previous.group_size += 1;
      previous.rows.push(row);
      continue;
    }
    entries.push(single(row));
  }
  return entries;
}

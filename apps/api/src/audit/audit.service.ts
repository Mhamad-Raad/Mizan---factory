import { Injectable } from '@nestjs/common';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';
import type { RequestContext } from '../common/request-context.js';

export type AuditAction =
  | 'create' | 'update' | 'void' | 'delete' | 'login' | 'logout' | 'login_failed' | 'lockout'
  | 'lock' | 'unlock' | 'switch_user' | 'permission_change' | 'password_change' | 'password_reset'
  | 'rate_change' | 'price_change' | 'ledger_entry' | 'assignment_change' | 'status_change'
  | 'settings_change' | 'export';

export interface FieldChange {
  old: unknown;
  new: unknown;
}

export interface AuditEntry {
  action: AuditAction;
  entity_type: string;
  entity_id: string;
  entity_label: string;
  changes?: Record<string, FieldChange | unknown>;
  note?: string | null;
  related?: Record<string, string | null>;
}

/** Fields that must never reach the audit log, whatever a caller passes (spec 2.4.4). */
const NEVER_LOGGED = new Set(['password_hash', 'pin_hash', 'token_hash', 'password', 'pin', 'ticket']);

/**
 * Rule 3: every write is recorded with who, when, old → new and the note.
 *
 * Every write endpoint goes through `record()` *inside its transaction*, so a committed
 * change without its History row is impossible. The audit table is append-only and the
 * application's database role has no UPDATE or DELETE on it (spec 2.13), so this service
 * has no update and no delete method — there is nothing to call.
 */
@Injectable()
export class AuditService {
  constructor(private readonly database: Database) {}

  async record(context: RequestContext, entry: AuditEntry, tx?: Db): Promise<void> {
    const db = tx ?? this.database;
    await db.query(
      `INSERT INTO audit_log
         (actor_user_id, action, entity_type, entity_id, entity_label,
          changes, note, related, request_id, session_id, auth_method, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        context.userId,
        entry.action,
        entry.entity_type,
        entry.entity_id,
        entry.entity_label,
        JSON.stringify(redact(entry.changes ?? {})),
        entry.note ?? null,
        JSON.stringify(entry.related ?? {}),
        context.requestId,
        context.sessionId || null,
        context.authMethod,
        context.ip,
        context.userAgent,
      ],
    );
  }

  /**
   * Sign-in, failed sign-in and lockout happen before a session exists, so they are recorded
   * without a request context (FR-101, FR-901).
   */
  async recordAnonymous(
    entry: AuditEntry & { actor_user_id?: string | null; request_id: string; ip?: string | null; user_agent?: string | null },
    tx?: Db,
  ): Promise<void> {
    const db = tx ?? this.database;
    await db.query(
      `INSERT INTO audit_log
         (actor_user_id, action, entity_type, entity_id, entity_label, changes, note, related, request_id, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        entry.actor_user_id ?? null,
        entry.action,
        entry.entity_type,
        entry.entity_id,
        entry.entity_label,
        JSON.stringify(redact(entry.changes ?? {})),
        entry.note ?? null,
        JSON.stringify(entry.related ?? {}),
        entry.request_id,
        entry.ip ?? null,
        entry.user_agent ?? null,
      ],
    );
  }
}

function redact(changes: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(changes)) {
    if (NEVER_LOGGED.has(field)) continue;
    clean[field] = value;
  }
  return clean;
}

/** The field-by-field diff of an update, with unchanged fields left out (spec 2.4.4). */
export function diffOf<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
  fields: readonly (keyof T & string)[],
): Record<string, FieldChange> {
  const changes: Record<string, FieldChange> = {};
  for (const field of fields) {
    if (!(field in after)) continue;
    const from = before[field] ?? null;
    const to = after[field] ?? null;
    if (from === to) continue;
    changes[field] = { old: from, new: to };
  }
  return changes;
}

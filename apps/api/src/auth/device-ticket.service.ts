import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { ENV } from '../config/env.js';
import type { Env } from '../config/env.js';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';

/** Seven days, as specification 2.8 states: a ticket outlives a weekend and not a holiday. */
const TICKET_DAYS = 7;

/** Five wrong PINs and the ticket goes; the lock screen then has only the password to offer. */
export const MAX_PIN_ATTEMPTS = 5;

export interface DeviceTicketRow {
  id: string;
  user_id: string;
  device_label: string | null;
  is_shared_device: boolean;
  pin_failures: number;
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

/**
 * Device tickets: what makes a four-to-six digit PIN safe enough to sign in with (FR-106, 2.8).
 *
 * A PIN on its own is a short secret typed on a tablet everybody on the floor holds. A ticket is
 * a 256-bit secret that *this browser* was handed the last time that user signed in with their
 * **password**, stored hashed and peppered exactly like a session token. So a PIN sign-in is
 * always two things — a browser the user proved themselves on within the last week, and the PIN
 * — and neither alone is enough. A ticket is revoked by five wrong PINs, by a password reset, by
 * deactivation, and by the admin from the Sessions tab.
 */
@Injectable()
export class DeviceTicketService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly database: Database,
  ) {}

  private hash(ticket: string): string {
    return createHash('sha256').update(`${ticket}${this.env.SESSION_PEPPER}`).digest('hex');
  }

  /**
   * Issued at every password sign-in, so the week starts again each time the user proves
   * themselves properly. The plain ticket is returned once and never stored.
   */
  async issue(
    params: {
      userId: string;
      isSharedDevice: boolean;
      deviceLabel?: string | null;
      userAgent?: string | null;
    },
    tx?: Db,
  ): Promise<{ ticket: string; row: DeviceTicketRow }> {
    const db = tx ?? this.database;
    const ticket = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + TICKET_DAYS * 86_400_000);

    const { rows } = await db.query<DeviceTicketRow>(
      `INSERT INTO device_tickets
         (user_id, ticket_hash, device_label, is_shared_device, user_agent, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $1, $6)
       RETURNING id, user_id, device_label, is_shared_device, pin_failures,
                 created_at, expires_at, last_used_at, revoked_at, revoke_reason`,
      [
        params.userId,
        this.hash(ticket),
        params.deviceLabel ?? null,
        params.isSharedDevice,
        params.userAgent ?? null,
        expires,
      ],
    );
    return { ticket, row: rows[0] as DeviceTicketRow };
  }

  /**
   * The ticket a lock screen presented, if it is still good for anything. A revoked, expired or
   * attempt-exhausted ticket resolves to nothing — the server decides, never the client.
   */
  async resolve(ticket: string): Promise<(DeviceTicketRow & { user_is_active: boolean }) | null> {
    const { rows } = await this.database.query<DeviceTicketRow & { user_is_active: boolean }>(
      `SELECT t.id, t.user_id, t.device_label, t.is_shared_device, t.pin_failures,
              t.created_at, t.expires_at, t.last_used_at, t.revoked_at, t.revoke_reason,
              u.is_active AS user_is_active
         FROM device_tickets t
         JOIN users u ON u.id = t.user_id
        WHERE t.ticket_hash = $1`,
      [this.hash(ticket)],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.revoked_at) return null;
    if (row.expires_at.getTime() <= Date.now()) return null;
    if (row.pin_failures >= MAX_PIN_ATTEMPTS) return null;
    return row;
  }

  /** A wrong PIN; the fifth one takes the ticket with it. */
  async registerPinFailure(id: string): Promise<{ failures: number; revoked: boolean }> {
    const { rows } = await this.database.query<{ pin_failures: number }>(
      `UPDATE device_tickets
          SET pin_failures = least(pin_failures + 1, $2),
              revoked_at = CASE WHEN pin_failures + 1 >= $2 THEN now() ELSE revoked_at END,
              revoke_reason = CASE WHEN pin_failures + 1 >= $2 THEN 'pin_attempts' ELSE revoke_reason END
        WHERE id = $1
        RETURNING pin_failures`,
      [id, MAX_PIN_ATTEMPTS],
    );
    const failures = rows[0]?.pin_failures ?? 0;
    return { failures, revoked: failures >= MAX_PIN_ATTEMPTS };
  }

  /** A right PIN: the count starts again and the ticket records that it was used. */
  async markUsed(id: string, tx?: Db): Promise<void> {
    const db = tx ?? this.database;
    await db.query('UPDATE device_tickets SET last_used_at = now(), pin_failures = 0 WHERE id = $1', [id]);
  }

  async revoke(id: string, reason: string, tx?: Db): Promise<boolean> {
    const db = tx ?? this.database;
    const result = await db.query(
      `UPDATE device_tickets SET revoked_at = now(), revoke_reason = $2
        WHERE id = $1 AND revoked_at IS NULL`,
      [id, reason],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Every browser at once: a password reset, a deactivation, or the admin deciding that a
   * tablet has left the building (FR-202, FR-203, 2.8).
   */
  async revokeAllForUser(userId: string, reason: string, tx?: Db): Promise<number> {
    const db = tx ?? this.database;
    const result = await db.query(
      `UPDATE device_tickets SET revoked_at = now(), revoke_reason = $2
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, reason],
    );
    return result.rowCount ?? 0;
  }

  /**
   * For the admin's Sessions tab. Revoked and expired tickets are listed for the grace period
   * the sweep leaves them, because "why has my PIN stopped working?" is answered by the row
   * that says it was revoked, not by its absence.
   */
  async listForUser(userId: string): Promise<DeviceTicketRow[]> {
    const { rows } = await this.database.query<DeviceTicketRow>(
      `SELECT id, user_id, device_label, is_shared_device, pin_failures,
              created_at, expires_at, last_used_at, revoked_at, revoke_reason
         FROM device_tickets
        WHERE user_id = $1
        ORDER BY coalesce(last_used_at, created_at) DESC
        LIMIT 50`,
      [userId],
    );
    return rows;
  }
}

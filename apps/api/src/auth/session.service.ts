import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { ENV } from '../config/env.js';
import type { Env } from '../config/env.js';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';
import { SettingsService } from '../settings/settings.service.js';
import type { UserRole } from '../users/user.types.js';

export const SESSION_COOKIE = 'mizan_session';

export interface SessionRow {
  id: string;
  user_id: string;
  is_locked: boolean;
  is_shared_device: boolean;
  auth_method: 'password';
  device_label: string | null;
  absolute_expires_at: Date;
  idle_expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
}

export interface SessionWithUser extends SessionRow {
  role: UserRole;
  user_is_active: boolean;
  must_change_password: boolean;
}

/** Session lifetimes of specification 2.8 / A-44. */
const SHARED_ABSOLUTE_HOURS = 12;
const PERSONAL_ABSOLUTE_DAYS = 30;
const SHARED_LOCK_GRACE_HOURS = 4;
const LAST_SEEN_REFRESH_MS = 60_000;

@Injectable()
export class SessionService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly database: Database,
    private readonly settings: SettingsService,
  ) {}

  /**
   * The cookie carries an opaque random token; the database stores only its hash, peppered
   * with a secret that lives outside the database, so a stolen dump cannot be replayed (2.8).
   */
  private hashToken(token: string): string {
    return createHash('sha256').update(`${token}${this.env.SESSION_PEPPER}`).digest('hex');
  }

  async create(
    params: {
      userId: string;
      isSharedDevice: boolean;
      deviceLabel?: string | null;
      authMethod?: 'password';
      ip?: string | null;
      userAgent?: string | null;
    },
    tx?: Db,
  ): Promise<{ token: string; session: SessionRow }> {
    const db = tx ?? this.database;
    const token = randomBytes(32).toString('base64url');
    const now = new Date();

    // A shared tablet's session lasts a shift; a personal phone's lasts a month, so nobody
    // is asked for a password every morning and the admin is not buried in resets (A-44).
    const absolute = new Date(
      params.isSharedDevice
        ? now.getTime() + SHARED_ABSOLUTE_HOURS * 3_600_000
        : now.getTime() + PERSONAL_ABSOLUTE_DAYS * 86_400_000,
    );
    const idle = params.isSharedDevice ? await this.sharedIdleExpiry(now) : absolute;

    const { rows } = await db.query<SessionRow>(
      `INSERT INTO sessions
         (user_id, token_hash, absolute_expires_at, idle_expires_at, is_shared_device, auth_method, device_label, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, user_id, is_locked, is_shared_device, auth_method, device_label,
                 absolute_expires_at, idle_expires_at, last_seen_at, revoked_at`,
      [
        params.userId,
        this.hashToken(token),
        absolute,
        idle,
        params.isSharedDevice,
        params.authMethod ?? 'password',
        params.deviceLabel ?? null,
        params.ip ?? null,
        params.userAgent ?? null,
      ],
    );
    return { token, session: rows[0] as SessionRow };
  }

  private async sharedIdleExpiry(from: Date): Promise<Date> {
    const lockMinutes = await this.settings.get('idle_lock_shared_minutes');
    return new Date(from.getTime() + lockMinutes * 60_000 + SHARED_LOCK_GRACE_HOURS * 3_600_000);
  }

  /**
   * Resolves the cookie to a live session. A session that is revoked, past its absolute
   * lifetime or past its idle window resolves to nothing — the server decides, not the client.
   */
  async resolve(token: string): Promise<SessionWithUser | null> {
    const { rows } = await this.database.query<SessionWithUser>(
      `SELECT s.id, s.user_id, s.is_locked, s.is_shared_device, s.auth_method, s.device_label,
              s.absolute_expires_at, s.idle_expires_at, s.last_seen_at, s.revoked_at,
              u.role, u.is_active AS user_is_active, u.must_change_password
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1`,
      [this.hashToken(token)],
    );
    const session = rows[0];
    if (!session) return null;

    const now = Date.now();
    if (session.revoked_at) return null;
    if (session.absolute_expires_at.getTime() <= now) return null;
    if (session.idle_expires_at.getTime() <= now) return null;

    // The idle lock of FR-106 / spec 2.8, decided here and not only by the screen: a session
    // left alone past its device's idle minutes is locked, and the guard answers 423 until the
    // password is typed again (review — only the manual lock existed). `last_seen_at` moves
    // once a minute, hence the minute of tolerance.
    if (!session.is_locked) {
      const idleMinutes = await this.idleLockMinutes(session.is_shared_device);
      if (now - session.last_seen_at.getTime() > idleMinutes * 60_000 + LAST_SEEN_REFRESH_MS) {
        await this.database.query('UPDATE sessions SET is_locked = true WHERE id = $1 AND NOT is_locked', [session.id]);
        session.is_locked = true;
      }
    }

    if (now - session.last_seen_at.getTime() > LAST_SEEN_REFRESH_MS) {
      await this.touch(session);
    }
    return session;
  }

  /** How long a session of this kind of device may sit idle before it locks (Settings). */
  idleLockMinutes(isSharedDevice: boolean): Promise<number> {
    return this.settings.get(isSharedDevice ? 'idle_lock_shared_minutes' : 'idle_lock_default_minutes');
  }

  /** `last_seen_at` moves at most once a minute; on a shared device it slides the idle window. */
  private async touch(session: SessionRow): Promise<void> {
    const now = new Date();
    if (session.is_shared_device && !session.is_locked) {
      await this.database.query(
        'UPDATE sessions SET last_seen_at = $2, idle_expires_at = $3 WHERE id = $1',
        [session.id, now, await this.sharedIdleExpiry(now)],
      );
      return;
    }
    await this.database.query('UPDATE sessions SET last_seen_at = $2 WHERE id = $1', [
      session.id,
      now,
    ]);
  }

  async lock(sessionId: string): Promise<void> {
    await this.database.query(
      'UPDATE sessions SET is_locked = true, locked_at = now() WHERE id = $1 AND revoked_at IS NULL',
      [sessionId],
    );
  }

  async unlock(session: SessionRow): Promise<void> {
    const now = new Date();
    const idle = session.is_shared_device
      ? await this.sharedIdleExpiry(now)
      : session.absolute_expires_at;
    await this.database.query(
      `UPDATE sessions
          SET is_locked = false, locked_at = NULL, last_seen_at = $2, idle_expires_at = $3,
              pin_failures = 0
        WHERE id = $1`,
      [session.id, now, idle],
    );
  }

  async revoke(sessionId: string, reason: string, tx?: Db): Promise<void> {
    const db = tx ?? this.database;
    await db.query(
      'UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL',
      [sessionId, reason],
    );
  }

  /**
   * Ends one session of one user. `missing` when the user has no such session — an admin
   * revoking from an employee's page must not end somebody else's (review); `already` when it
   * had ended, which a double tap or a stale list asks for and is not an error.
   */
  async revokeOfUser(userId: string, sessionId: string, reason: string, tx?: Db): Promise<'revoked' | 'already' | 'missing'> {
    const db = tx ?? this.database;
    const { rowCount } = await db.query(
      `UPDATE sessions SET revoked_at = now(), revoke_reason = $3
        WHERE id = $2 AND user_id = $1 AND revoked_at IS NULL`,
      [userId, sessionId, reason],
    );
    if ((rowCount ?? 0) > 0) return 'revoked';
    const { rowCount: exists } = await db.query('SELECT 1 FROM sessions WHERE id = $2 AND user_id = $1', [userId, sessionId]);
    return exists ? 'already' : 'missing';
  }

  /** Used when a password is reset or an account is deactivated (FR-202, FR-203). */
  async revokeAllForUser(userId: string, reason: string, tx?: Db): Promise<number> {
    const db = tx ?? this.database;
    const result = await db.query(
      'UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL',
      [userId, reason],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Every other live session of a user, when they change their own password (review
   * finding 12): whoever else holds the old password's session is signed out, and the device
   * the change was made on stays signed in.
   */
  async revokeOthersForUser(userId: string, keepSessionId: string, reason: string, tx?: Db): Promise<number> {
    const db = tx ?? this.database;
    const result = await db.query(
      `UPDATE sessions SET revoked_at = now(), revoke_reason = $3
        WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
      [userId, keepSessionId, reason],
    );
    return result.rowCount ?? 0;
  }

  async listForUser(userId: string): Promise<SessionRow[]> {
    const { rows } = await this.database.query<SessionRow>(
      `SELECT id, user_id, is_locked, is_shared_device, auth_method, device_label,
              absolute_expires_at, idle_expires_at, last_seen_at, revoked_at
         FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND absolute_expires_at > now()
        ORDER BY last_seen_at DESC
        LIMIT 20`,
      [userId],
    );
    return rows;
  }

  cookieOptions(): {
    httpOnly: true;
    secure: boolean;
    sameSite: 'lax';
    path: string;
    maxAge: number;
  } {
    return {
      httpOnly: true,
      // Over http on localhost a Secure cookie is dropped; every other attribute is identical
      // in all environments, and production is asserted by test (decision D-007).
      secure: this.env.NODE_ENV !== 'development',
      sameSite: 'lax',
      path: '/',
      maxAge: PERSONAL_ABSOLUTE_DAYS * 86_400_000,
    };
  }
}

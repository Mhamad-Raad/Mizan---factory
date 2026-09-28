/**
 * The way back in when nobody can sign in as an admin (runbook, "Incidents"): a new temporary
 * password for one user, from the server's command line.
 *
 *   docker compose exec api node apps/api/dist/database/reset-password.js admin
 *
 * It does what an admin's "Reset password" does in Users, and no more: a generated temporary
 * password, printed once; `must_change_password`, so it cannot survive the next sign-in; every
 * session of that user ended; the account's lockout lifted; and a History row, so the reset is
 * never invisible. It runs as the application's own role — it needs nothing the API lacks.
 */
import { Client } from 'pg';
import { hash } from '@node-rs/argon2';
import { ARGON2_OPTIONS, PasswordService } from '../auth/password.service.js';

export interface ResetResult {
  userId: string;
  temporaryPassword: string;
  sessionsEnded: number;
}

export async function resetPassword(connectionString: string, username: string): Promise<ResetResult> {
  const temporaryPassword = new PasswordService().generateTemporary();
  const passwordHash = await hash(temporaryPassword, ARGON2_OPTIONS);
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; display_name: string }>(
      `UPDATE users
          SET password_hash = $2, must_change_password = true, locked_until = NULL,
              failed_login_count = 0, version = version + 1, updated_at = now()
        WHERE username = $1 AND deleted_at IS NULL
        RETURNING id, display_name`,
      [username.toLowerCase(), passwordHash],
    );
    const user = rows[0];
    if (!user) throw new Error(`no user named "${username}"`);
    const ended = await client.query(
      "UPDATE sessions SET revoked_at = now(), revoke_reason = 'password_reset' WHERE user_id = $1 AND revoked_at IS NULL",
      [user.id],
    );
    // A success clears the sign-in throttle's count for this name, as a correct sign-in would.
    await client.query('INSERT INTO login_attempts (username_attempted, user_id, ip, succeeded) VALUES ($1, $2, NULL, true)', [
      username.toLowerCase(),
      user.id,
    ]);
    await client.query(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, entity_label, changes, note, related, request_id)
       VALUES (NULL, 'password_reset', 'user', $1, $2, '{}'::jsonb, 'Reset from the server''s command line', jsonb_build_object('user_id', $1::text), gen_random_uuid())`,
      [user.id, `Employee: ${user.display_name}`],
    );
    await client.query('COMMIT');
    return { userId: user.id, temporaryPassword, sessionsEnded: ended.rowCount ?? 0 };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const connectionString = process.env.DATABASE_URL;
  const username = process.argv[2];
  if (!connectionString) throw new Error('DATABASE_URL must be set');
  if (!username) throw new Error('usage: node reset-password.js <username>');
  const result = await resetPassword(connectionString, username);
  console.log(`temporary password for ${username}: ${result.temporaryPassword}`);
  console.log(`(it must be changed at the next sign-in; ${result.sessionsEnded} session(s) were ended)`);
}

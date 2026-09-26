import { Injectable } from '@nestjs/common';
import { expandImplied } from '@mizan/permissions';
import { normalizePhone } from '@mizan/text';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/errors.js';
import type { RequestContext } from '../common/request-context.js';
import { Database } from '../database/pool.js';
import type { Db } from '../database/pool.js';
import { UsersRepository } from '../users/users.repository.js';
import { toUserDto } from '../users/user.types.js';
import type { UserDto, UserRow } from '../users/user.types.js';
import { PasswordService, checkPasswordRules } from './password.service.js';
import { SessionService } from './session.service.js';
import { SignInAddressLimiter } from './sign-in-throttle.js';
import type { SessionWithUser } from './session.service.js';

/**
 * Sign-in throttling of specification 2.8 / FR-101: five wrong passwords within fifteen minutes
 * lock the username for fifteen minutes, counted from the fifth. The window and the lockout are
 * the same length, so once a lockout ends none of the failures that caused it are still counted.
 */
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MINUTES = 15;
const LOCKOUT_MINUTES = 15;

type FailureState = { recent: number; run: number; lastFailureAt: Date | null };

/** When a lockout ends, or null when there is none: a fixed time after the failure that caused it. */
function lockedUntil(state: FailureState): Date | null {
  if (state.run < MAX_FAILURES || !state.lastFailureAt) return null;
  const until = new Date(state.lastFailureAt.getTime() + LOCKOUT_MINUTES * 60_000);
  return until.getTime() > Date.now() ? until : null;
}

/** Whole minutes left, rounded up, so the message never says "0 min" while still locked. */
function minutesUntil(until: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
}

/**
 * What the sign-in throttle counts under (2.8, FR-101).
 *
 * The lockout protects an **account**, so when the typed name resolves to one the count is
 * kept under its username — whichever of its aliases was typed. Keyed on the raw text, every
 * spelling of a phone number (`0750…`, `+964 750…`, `00964-750…`, Arabic-Indic digits) and the
 * username itself each had five attempts of their own (security review, finding 1).
 *
 * A name that resolves to nobody is still counted, so the form cannot tell which accounts
 * exist; it is normalised the way the lookup normalises it, so the variants of an unknown
 * phone number share one count too.
 */
export function throttleKeyFor(identifier: string, user: Pick<UserRow, 'username'> | null): string {
  if (user) return user.username.toLowerCase();
  const typed = identifier.normalize('NFKC').trim();
  if (looksLikePhone(typed)) {
    const phone = normalizePhone(typed);
    if (phone !== '') return phone;
  }
  return typed.toLowerCase();
}

/** Digits in any script with the separators people type in a phone number, and enough of them. */
function looksLikePhone(typed: string): boolean {
  if (!/^[\p{Nd}\s+\-().]+$/u.test(typed)) return false;
  return (typed.match(/\p{Nd}/gu)?.length ?? 0) >= 7;
}

/**
 * One sign-in check at a time per throttle key, in this process: it is what gives a parallel
 * burst exactly five checks without holding a pooled connection across the password check. The
 * database lock in `attemptPassword` keeps the count correct across replicas.
 */
class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(work, work);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

type LoginOutcome =
  | { kind: 'locked'; minutes: number }
  | { kind: 'lockout' }
  | { kind: 'invalid'; attemptsLeft: number }
  | { kind: 'deactivated' }
  | { kind: 'signed_in'; token: string };

type PasswordCheck =
  | { kind: 'ok' }
  | { kind: 'locked'; minutes: number }
  | { kind: 'lockout' }
  | { kind: 'invalid'; attemptsLeft: number };

export interface LoginInput {
  username_or_phone: string;
  password: string;
  is_shared_device?: boolean;
  device_label?: string | null;
}

export interface LoginContext {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface MeDto {
  user: UserDto;
  permissions: string[];
  is_locked: boolean;
  is_shared_device: boolean;
  device_label: string | null;
  auth_method: 'password' | 'ticket_pin';
}

@Injectable()
export class AuthService {
  constructor(
    private readonly database: Database,
    private readonly users: UsersRepository,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly addresses: SignInAddressLimiter,
  ) {}

  private readonly queue = new KeyedQueue();

  /**
   * A hash no password matches, verified when the typed name resolves to nobody, so a wrong
   * username costs the same Argon2 time as a wrong password and the response time does not
   * say which accounts exist (security review, finding 11).
   */
  private dummyHash: Promise<string> | null = null;

  private verifyOrDummy(user: UserRow | null, password: string): Promise<boolean> {
    if (user) return this.passwords.verify(user.password_hash, password);
    this.dummyHash ??= this.passwords.hash(randomBytes(32).toString('base64url'));
    return this.dummyHash.then((dummy) => this.passwords.verify(dummy, password)).then(() => false);
  }

  /**
   * Check the lockout, try the password and record the result as one step per key (security
   * review, finding 5), without holding a database connection while Argon2 runs (its
   * follow-up). Without the serialising, parallel requests each read "fewer than five failures"
   * before any of them was recorded, and a burst got as many guesses as it had requests.
   *
   * 1. A short read of the key's failures; while it is locked, the password is not checked.
   * 2. The address ceiling (`SignInAddressLimiter`) and the password check, outside any
   *    transaction: Argon2 takes 64 MB and tens of milliseconds, and the pool has ten
   *    connections.
   * 3. A short transaction under `pg_advisory_xact_lock(hashtext(key))` that reads the
   *    failures again and records the result. If another replica locked the key meanwhile, the
   *    attempt is answered as locked whatever the password was.
   *
   * The in-process queue runs the three steps for one key one attempt at a time, so on one
   * replica a burst gets exactly five checks. Across replicas the lock in step 3 keeps the
   * count exact, and at most one check per other replica can be under way when the fifth
   * failure lands.
   */
  private attemptPassword<T>(
    key: string,
    ip: string | null,
    verify: () => Promise<boolean>,
    onLocked: (minutes: number, db: Db) => Promise<T>,
    onResult: (correct: boolean, state: FailureState, tx: Db) => Promise<T>,
  ): Promise<T> {
    return this.queue.run(key, async () => {
      const before = lockedUntil(await this.failureState(key, this.database));
      if (before) return onLocked(minutesUntil(before), this.database);

      const settle = this.addresses.begin(ip);
      let correct: boolean;
      try {
        correct = await verify();
      } catch (error) {
        settle(false);
        throw error;
      }
      settle(!correct);

      return this.database.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mizan:sign-in:${key}`]);
        const state = await this.failureState(key, tx);
        const until = lockedUntil(state);
        if (until) return onLocked(minutesUntil(until), tx);
        return onResult(correct, state, tx);
      });
    });
  }

  /**
   * Sign in with a username or phone number and a password (FR-101). There is no e-mail
   * anywhere in the system and no self-service recovery: an admin resets a password in person.
   *
   * A wrong username and a wrong password are answered identically, so the form cannot be used
   * to find out which usernames exist.
   */
  async login(
    input: LoginInput,
    ctx: LoginContext,
  ): Promise<{ token: string; user: UserDto; permissions: string[] }> {
    const identifier = input.username_or_phone.trim();
    const user = await this.users.findByUsernameOrPhone(identifier);
    const key = throttleKeyFor(identifier, user);

    const outcome = await this.attemptPassword<LoginOutcome>(
      key,
      ctx.ip,
      () => this.verifyOrDummy(user, input.password),
      async (minutes, db) => {
        // Recorded in History, but not as a failure: trying a locked door does not move when it opens.
        await this.recordFailure(key, identifier, user?.id ?? null, ctx, 'locked_out', false, db);
        return { kind: 'locked', minutes };
      },
      async (correct, state, tx) => {
        if (!user || !correct) {
          // A wrong username and a wrong password are answered identically, down to the count.
          const attemptsLeft = MAX_FAILURES - (state.recent + 1);
          const locking = attemptsLeft <= 0;
          if (user) {
            await this.users.registerFailure(
              user.id,
              locking ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
              tx,
            );
          }
          await this.recordFailure(
            key,
            identifier,
            user?.id ?? null,
            ctx,
            locking ? 'lockout' : user ? 'invalid_password' : 'unknown_user',
            true,
            tx,
          );
          return locking ? { kind: 'lockout' } : { kind: 'invalid', attemptsLeft };
        }

        // A deactivated user is told plainly — that is not credential disclosure, and the
        // alternative is an employee standing at a tablet with no idea why (FR-101).
        if (!user.is_active) {
          await this.recordFailure(key, identifier, user.id, ctx, 'deactivated', true, tx);
          return { kind: 'deactivated' };
        }

        const created = await this.sessions.create(
          {
            userId: user.id,
            isSharedDevice: input.is_shared_device ?? false,
            deviceLabel: input.device_label ?? null,
            authMethod: 'password',
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          },
          tx,
        );
        await this.users.markSignedIn(user.id, tx);
        // Under the throttle key, so a success clears the failures of every alias of the account.
        await this.users.recordLoginAttempt(
          { username: key, userId: user.id, ip: ctx.ip, succeeded: true },
          tx,
        );
        await this.audit.recordAnonymous(
          {
            actor_user_id: user.id,
            action: 'login',
            entity_type: 'session',
            entity_id: created.session.id,
            entity_label: `Sign-in: ${user.display_name}`,
            changes: {
              shared_device: input.is_shared_device ?? false,
              device_label: input.device_label ?? null,
              auth_method: 'password',
            },
            request_id: ctx.requestId,
            session_id: created.session.id,
            auth_method: 'password',
            ip: ctx.ip,
            user_agent: ctx.userAgent,
            related: { user_id: user.id },
          },
          tx,
        );
        return { kind: 'signed_in', token: created.token };
      },
    );

    // Thrown after the transaction has committed, so the failure it records is kept.
    switch (outcome.kind) {
      case 'locked':
        throw new ApiError('RATE_LIMITED', { minutes: outcome.minutes });
      case 'lockout':
        throw new ApiError('RATE_LIMITED', { minutes: LOCKOUT_MINUTES });
      case 'invalid':
        throw new ApiError('UNAUTHENTICATED', {
          reason: 'invalid_credentials',
          attempts_left: outcome.attemptsLeft,
          lockout_minutes: LOCKOUT_MINUTES,
        });
      case 'deactivated':
        throw new ApiError('UNAUTHENTICATED', { reason: 'deactivated' });
    }
    const token = outcome.token;
    if (!user) throw new ApiError('UNAUTHENTICATED');

    const permissions =
      user.role === 'admin' ? [] : [...expandImplied(await this.users.permissionsOf(user.id))];
    return { token, user: toUserDto(user), permissions };
  }

  async logout(context: RequestContext): Promise<void> {
    await this.sessions.revoke(context.sessionId, 'logout');
    await this.audit.record(context, {
      action: 'logout',
      entity_type: 'session',
      entity_id: context.sessionId,
      entity_label: 'Sign-out',
      related: { user_id: context.userId },
    });
  }

  async me(context: RequestContext, session: SessionWithUser): Promise<MeDto> {
    const user = await this.users.findById(context.userId);
    if (!user) throw new ApiError('UNAUTHENTICATED');
    return {
      user: toUserDto(user),
      permissions:
        user.role === 'admin' ? [] : [...expandImplied(await this.users.permissionsOf(user.id))],
      is_locked: session.is_locked,
      is_shared_device: session.is_shared_device,
      device_label: session.device_label,
      auth_method: session.auth_method,
    };
  }

  /**
   * Changing one's own password clears the "must change" flag (FR-108).
   *
   * The current password is a credential like any other: while the account is locked out it
   * is not even checked, and a wrong one counts toward the same five-in-fifteen lockout —
   * this route stays open on a locked screen, so without that a stolen locked tablet could
   * guess here without limit (security review, finding 2). Every *other* session of the user
   * is signed out with the old password (finding 12); this device stays signed in.
   */
  async changePassword(context: RequestContext, current: string, next: string): Promise<void> {
    const user = await this.users.findById(context.userId);
    if (!user) throw new ApiError('UNAUTHENTICATED');

    const check = await this.checkPassword(user, context, current);
    if (check.kind === 'locked') throw new ApiError('RATE_LIMITED', { minutes: check.minutes });
    if (check.kind === 'lockout') throw new ApiError('RATE_LIMITED', { minutes: LOCKOUT_MINUTES });
    if (check.kind === 'invalid') {
      throw ApiError.validation([
        {
          path: 'current',
          code: 'INVALID',
          message_key: 'auth:invalid_credentials',
          params: { attempts_left: check.attemptsLeft, lockout_minutes: LOCKOUT_MINUTES },
        },
      ]);
    }

    const problem = checkPasswordRules(next, user.username);
    if (problem) {
      throw ApiError.validation([
        { path: 'new', code: problem.code, message_key: problem.message_key, params: { min: 8 } },
      ]);
    }

    const passwordHash = await this.passwords.hash(next);
    await this.database.transaction(async (tx) => {
      const updated = await this.users.update(
        user.id,
        user.version,
        { password_hash: passwordHash, must_change_password: false },
        user.id,
        tx,
      );
      if (!updated) throw new ApiError('VERSION_CONFLICT', { current_version: user.version });
      const signedOut = await this.sessions.revokeOthersForUser(
        user.id,
        context.sessionId,
        'password_change',
        tx,
      );
      await this.audit.record(
        context,
        {
          action: 'password_change',
          entity_type: 'user',
          entity_id: user.id,
          entity_label: `Employee: ${user.display_name}`,
          changes: { other_sessions_signed_out: signedOut },
          related: { user_id: user.id },
        },
        tx,
      );
    });
  }

  async lock(context: RequestContext): Promise<void> {
    await this.sessions.lock(context.sessionId);
    await this.audit.record(context, {
      action: 'lock',
      entity_type: 'session',
      entity_id: context.sessionId,
      entity_label: 'Screen locked',
      related: { user_id: context.userId },
    });
  }

  /**
   * Unlock keeps the same session and the drafts that belong to it (spec 2.8): the same person
   * proving again that it is still them, with their password. A wrong password counts toward the
   * same five-in-fifteen lockout as every other place it is typed (chargeWrongPassword).
   */
  async unlock(
    context: RequestContext,
    session: SessionWithUser,
    credentials: { password?: string },
  ): Promise<void> {
    const user = await this.users.findById(context.userId);
    if (!user) throw new ApiError('UNAUTHENTICATED');

    // The same lockout as the Login page: while it lasts, the password is not even checked.
    const check = await this.checkPassword(user, context, credentials.password ?? '');
    if (check.kind === 'locked') throw new ApiError('RATE_LIMITED', { minutes: check.minutes });
    if (check.kind === 'lockout') throw new ApiError('RATE_LIMITED', { minutes: LOCKOUT_MINUTES });
    if (check.kind === 'invalid') {
      throw ApiError.validation([
        {
          path: 'password',
          code: 'INVALID',
          message_key: 'auth:invalid_credentials',
          params: { attempts_left: check.attemptsLeft, lockout_minutes: LOCKOUT_MINUTES },
        },
      ]);
    }

    await this.sessions.unlock(session);
    await this.audit.record(context, {
      action: 'unlock',
      entity_type: 'session',
      entity_id: context.sessionId,
      entity_label: 'Screen unlocked',
      changes: { unlocked_with: 'password' },
      related: { user_id: context.userId },
    });
  }

  /**
   * A signed-in user's own password, typed again — on the lock screen or to change it (2.8).
   * It is the same credential as the Login page's, so it answers to the same lockout and a
   * wrong one counts toward it: counting only the Login page left a stolen **locked** tablet
   * as an unlimited password oracle (I5 review). Serialised with the Login page's attempts on
   * the same key, so the two doors cannot be raced against each other either.
   */
  private checkPassword(
    user: UserRow,
    context: RequestContext,
    password: string,
  ): Promise<PasswordCheck> {
    const key = throttleKeyFor(user.username, user);
    return this.attemptPassword<PasswordCheck>(
      key,
      context.ip,
      async () => password !== '' && (await this.passwords.verify(user.password_hash, password)),
      async (minutes) => ({ kind: 'locked', minutes }),
      async (correct, state, tx) => {
        if (correct) return { kind: 'ok' };

        const lockUntil =
          state.recent + 1 >= MAX_FAILURES ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null;
        await this.users.registerFailure(user.id, lockUntil, tx);
        await this.users.recordLoginAttempt(
          { username: key, userId: user.id, ip: context.ip, succeeded: false },
          tx,
        );
        await this.audit.recordAnonymous(
          {
            actor_user_id: user.id,
            action: lockUntil ? 'lockout' : 'login_failed',
            entity_type: 'session',
            entity_id: user.username,
            entity_label: `Failed sign-in: ${user.username}`,
            changes: { reason: lockUntil ? 'lockout' : 'invalid_password' },
            request_id: context.requestId,
            session_id: context.sessionId || null,
            auth_method: 'password',
            ip: context.ip,
            user_agent: context.userAgent,
            related: { user_id: user.id },
          },
          tx,
        );
        return lockUntil
          ? { kind: 'lockout' }
          : { kind: 'invalid', attemptsLeft: MAX_FAILURES - (state.recent + 1) };
      },
    );
  }

  private failureState(key: string, db: Db): Promise<FailureState> {
    return this.users.failureState(
      key,
      FAILURE_WINDOW_MINUTES,
      FAILURE_WINDOW_MINUTES + LOCKOUT_MINUTES,
      db,
    );
  }

  private async recordFailure(
    key: string,
    identifier: string,
    userId: string | null,
    ctx: LoginContext,
    reason: string,
    counts: boolean,
    tx: Db,
  ): Promise<void> {
    if (counts) {
      await this.users.recordLoginAttempt(
        { username: key, userId, ip: ctx.ip, succeeded: false },
        tx,
      );
    }
    await this.audit.recordAnonymous(
      {
        actor_user_id: userId,
        action: reason === 'lockout' ? 'lockout' : 'login_failed',
        entity_type: 'session',
        entity_id: identifier.toLowerCase(),
        entity_label: `Failed sign-in: ${identifier}`,
        changes: { reason },
        request_id: ctx.requestId,
        auth_method: 'password',
        ip: ctx.ip,
        user_agent: ctx.userAgent,
        related: userId ? { user_id: userId } : {},
      },
      tx,
    );
  }
}

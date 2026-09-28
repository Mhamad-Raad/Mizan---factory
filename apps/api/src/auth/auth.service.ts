import { Inject, Injectable } from '@nestjs/common';
import { expandImplied } from '@mizan/permissions';
import { normalizePhone } from '@mizan/text';
import { createHmac, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/errors.js';
import type { RequestContext } from '../common/request-context.js';
import { ENV } from '../config/env.js';
import type { Env } from '../config/env.js';
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
export function throttleKeyFor(
  identifier: string,
  user: Pick<UserRow, 'username'> | null,
  pepper = '',
): string {
  if (user) return user.username.toLowerCase();
  const typed = identifier.normalize('NFKC').trim();
  if (looksLikePhone(typed)) {
    const phone = normalizePhone(typed);
    if (phone !== '') return phone;
  }
  // A name that is nobody's is kept only as a keyed hash: it is sometimes a password typed into
  // the wrong box, and `login_attempts` keeps it for ever (review). Same name, same key, so the
  // count still works; lower case, so it can never meet the SESSION: keys below.
  return `?${createHmac('sha256', pepper).update(typed.toLowerCase()).digest('hex').slice(0, 32)}`;
}

/**
 * The key an in-session password check (unlock, change password) counts against. Upper case:
 * every key built from a typed name is lower case, so "session:<id>" typed at the sign-in page
 * can never reach — and lock — a signed-in tablet's unlock (review).
 */
function sessionThrottleKey(sessionId: string): string {
  return `SESSION:${sessionId}`;
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
  auth_method: 'password';
  /** Minutes of inactivity after which this device's session locks (FR-106). */
  idle_lock_minutes: number;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(ENV) private readonly env: Env,
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
    /** `firstKnock`: the first attempt on this lockout — the one worth recording. */
    onLocked: (minutes: number, db: Db, firstKnock: boolean) => Promise<T>,
    onResult: (correct: boolean, state: FailureState, tx: Db) => Promise<T>,
  ): Promise<T> {
    return this.queue.run(key, async () => {
      const before = lockedUntil(await this.failureState(key, this.database));
      if (before) {
        // The first knock on a locked door counts toward the address's ceiling like a wrong
        // password; the rest do not, or one colleague retrying the right password behind the
        // factory's single address would lock everybody's sign-in (review).
        const first = this.firstKnockOn(key, minutesUntil(before));
        if (first) this.addresses.begin(ip)(true);
        return onLocked(minutesUntil(before), this.database, first);
      }

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
        if (until) return onLocked(minutesUntil(until), tx, this.firstKnockOn(key, minutesUntil(until)));
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
    const key = throttleKeyFor(identifier, user, this.env.SESSION_PEPPER);

    const outcome = await this.attemptPassword<LoginOutcome>(
      key,
      ctx.ip,
      () => this.verifyOrDummy(user, input.password),
      async (minutes, db, firstKnock) => {
        // Recorded in History once per lockout, and not as a failure: trying a locked door does
        // not move when it opens, and a row per knock let anybody fill the append-only log (review).
        if (firstKnock) {
          await this.recordFailure(key, identifier, user?.id ?? null, ctx, 'locked_out', false, db);
        }
        return { kind: 'locked', minutes };
      },
      async (correct, state, tx) => {
        // The password was checked outside this transaction. An admin reset, a deactivation or a
        // deletion since then must win: read the row again, locked, and accept the password only
        // if it is still the one that was checked. A reset that commits after this waits for
        // the session below and then revokes it with the rest.
        const current = user && correct ? await this.users.findByIdForUpdate(user.id, tx) : null;
        if (!user || !correct || !current || current.password_hash !== user.password_hash) {
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
        if (!current.is_active) {
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

  /**
   * A sign-in on a browser that still carries somebody's session — the lock screen's "someone
   * else", or the Login page after a session expired on a shared tablet — ends that session
   * and says so in History, instead of leaving it alive for hours behind the new one (review).
   */
  async endReplacedSession(
    previousToken: string | undefined,
    next: { userId: string; requestId: string; ip: string | null; userAgent: string | null },
  ): Promise<void> {
    if (!previousToken) return;
    const previous = await this.sessions.resolve(previousToken);
    if (!previous) return;
    await this.sessions.revoke(previous.id, 'switch_user');
    await this.audit.recordAnonymous({
      actor_user_id: next.userId,
      action: 'switch_user',
      entity_type: 'session',
      entity_id: previous.id,
      entity_label: 'Switch user',
      changes: { from_user_id: previous.user_id, to_user_id: next.userId },
      request_id: next.requestId,
      auth_method: 'password',
      ip: next.ip,
      user_agent: next.userAgent,
      related: { user_id: previous.user_id },
    });
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
      // The screen's own idle timer uses the server's figure, so the two lock together.
      idle_lock_minutes: await this.sessions.idleLockMinutes(session.is_shared_device),
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
    // Counted per signed-in session, not per account: five wrong guesses at the sign-in page
    // from anywhere locked the account, and with it the unlock of the tablet already in use
    // (review). A stolen tablet still gets five guesses and then waits, as before.
    const key = context.sessionId ? sessionThrottleKey(context.sessionId) : throttleKeyFor(user.username, user);
    return this.attemptPassword<PasswordCheck>(
      key,
      context.ip,
      async () => password !== '' && (await this.passwords.verify(user.password_hash, password)),
      async (minutes) => ({ kind: 'locked', minutes }),
      async (correct, state, tx) => {
        const accountKey = throttleKeyFor(user.username, user);
        if (correct) {
          // A right password clears what came before it, on this session and on the account,
          // as a successful sign-in does: three slips and a correct unlock must not count as
          // three toward the next lock (review).
          for (const counted of new Set([key, accountKey])) {
            await this.users.recordLoginAttempt({ username: counted, userId: user.id, ip: context.ip, succeeded: true }, tx);
          }
          return { kind: 'ok' };
        }

        const lockUntil =
          state.recent + 1 >= MAX_FAILURES ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null;
        await this.users.registerFailure(user.id, lockUntil, tx);
        // Counted twice: against this session, whose own five guesses lock its unlock, and
        // against the account, so a stolen tablet's guesses still close the sign-in page too
        // (security review, finding 2 of D-066).
        await this.users.recordLoginAttempt(
          { username: key, userId: user.id, ip: context.ip, succeeded: false },
          tx,
        );
        if (accountKey !== key) {
          await this.users.recordLoginAttempt(
            { username: accountKey, userId: user.id, ip: context.ip, succeeded: false },
            tx,
          );
        }
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

  /** Locked keys already noted in History, until when — so a lockout is recorded once. */
  private readonly knocked = new Map<string, number>();

  private firstKnockOn(key: string, minutes: number): boolean {
    const now = Date.now();
    for (const [noted, until] of this.knocked) if (until <= now) this.knocked.delete(noted);
    if (this.knocked.has(key)) return false;
    this.knocked.set(key, now + minutes * 60_000);
    return true;
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
        // A name that is nobody's is stored masked: it is sometimes a password typed into the
        // wrong box, and this log keeps it for ever (review).
        entity_id: userId ? identifier.toLowerCase() : maskedIdentifier(identifier),
        entity_label: `Failed sign-in: ${userId ? identifier : maskedIdentifier(identifier)}`,
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

/** "ab…(9)": enough to tell attempts apart in History, not enough to read what was typed. */
function maskedIdentifier(typed: string): string {
  const trimmed = typed.trim();
  return `${trimmed.slice(0, 2)}…(${trimmed.length})`;
}

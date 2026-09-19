import { Injectable } from '@nestjs/common';
import { expandImplied } from '@mizan/permissions';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/errors.js';
import type { RequestContext } from '../common/request-context.js';
import { Database } from '../database/pool.js';
import { UsersRepository } from '../users/users.repository.js';
import { toUserDto } from '../users/user.types.js';
import type { UserDto } from '../users/user.types.js';
import { PasswordService, checkPasswordRules } from './password.service.js';
import { SessionService } from './session.service.js';
import type { SessionWithUser } from './session.service.js';

/** Sign-in throttling of specification 2.8 / FR-101. */
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MINUTES = 15;
const LOCKOUT_MINUTES = 15;

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
  ) {}

  /**
   * Sign in with a username or phone number and a password (FR-101). There is no e-mail
   * anywhere in the system and no self-service recovery: an admin resets a password in person.
   *
   * A wrong username and a wrong password are answered identically, so the form cannot be used
   * to find out which usernames exist.
   */
  async login(input: LoginInput, ctx: LoginContext): Promise<{ token: string; user: UserDto; permissions: string[] }> {
    const identifier = input.username_or_phone.trim();
    const user = await this.users.findByUsernameOrPhone(identifier);

    // Throttling is keyed on what was typed, so it also protects a username that does not exist.
    const failures = await this.users.recentFailures(identifier.toLowerCase(), FAILURE_WINDOW_MINUTES);
    if (failures >= MAX_FAILURES) {
      await this.recordFailure(identifier, user?.id ?? null, ctx, 'lockout');
      throw new ApiError('RATE_LIMITED', { minutes: LOCKOUT_MINUTES });
    }

    if (!user) {
      await this.recordFailure(identifier, null, ctx, 'unknown_user');
      throw new ApiError('UNAUTHENTICATED', { reason: 'invalid_credentials' });
    }

    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      const minutes = Math.ceil((user.locked_until.getTime() - Date.now()) / 60_000);
      throw new ApiError('RATE_LIMITED', { minutes });
    }

    const correct = await this.passwords.verify(user.password_hash, input.password);
    if (!correct) {
      const nextFailureCount = failures + 1;
      const lockUntil =
        nextFailureCount >= MAX_FAILURES ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null;
      await this.users.registerFailure(user.id, lockUntil);
      await this.recordFailure(identifier, user.id, ctx, lockUntil ? 'lockout' : 'invalid_password');
      throw new ApiError('UNAUTHENTICATED', { reason: 'invalid_credentials' });
    }

    // A deactivated user is told plainly — that is not credential disclosure, and the
    // alternative is an employee standing at a tablet with no idea why (FR-101).
    if (!user.is_active) {
      await this.recordFailure(identifier, user.id, ctx, 'deactivated');
      throw new ApiError('UNAUTHENTICATED', { reason: 'deactivated' });
    }

    const { token } = await this.database.transaction(async (tx) => {
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
      await this.users.recordLoginAttempt(
        { username: identifier.toLowerCase(), userId: user.id, ip: ctx.ip, succeeded: true },
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
          ip: ctx.ip,
          user_agent: ctx.userAgent,
          related: { user_id: user.id },
        },
        tx,
      );
      return created;
    });

    const permissions = user.role === 'admin' ? [] : [...expandImplied(await this.users.permissionsOf(user.id))];
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
      permissions: user.role === 'admin' ? [] : [...expandImplied(await this.users.permissionsOf(user.id))],
      is_locked: session.is_locked,
      is_shared_device: session.is_shared_device,
      device_label: session.device_label,
      auth_method: session.auth_method,
    };
  }

  /** Changing one's own password clears the "must change" flag (FR-108). */
  async changePassword(context: RequestContext, current: string, next: string): Promise<void> {
    const user = await this.users.findById(context.userId);
    if (!user) throw new ApiError('UNAUTHENTICATED');

    if (!(await this.passwords.verify(user.password_hash, current))) {
      throw ApiError.validation([
        { path: 'current', code: 'INVALID', message_key: 'auth:invalid_credentials', params: {} },
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
      await this.audit.record(
        context,
        {
          action: 'password_change',
          entity_type: 'user',
          entity_id: user.id,
          entity_label: `Employee: ${user.display_name}`,
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
   * Unlock keeps the same session and the drafts that belong to it (spec 2.8). In Iteration 0
   * the password is the only way in; the PIN and fast user switching arrive in I5.
   */
  async unlock(context: RequestContext, session: SessionWithUser, password: string): Promise<void> {
    const user = await this.users.findById(context.userId);
    if (!user) throw new ApiError('UNAUTHENTICATED');
    if (!(await this.passwords.verify(user.password_hash, password))) {
      throw ApiError.validation([
        { path: 'password', code: 'INVALID', message_key: 'auth:invalid_credentials', params: {} },
      ]);
    }
    await this.sessions.unlock(session);
    await this.audit.record(context, {
      action: 'unlock',
      entity_type: 'session',
      entity_id: context.sessionId,
      entity_label: 'Screen unlocked',
      related: { user_id: context.userId },
    });
  }

  private async recordFailure(
    identifier: string,
    userId: string | null,
    ctx: LoginContext,
    reason: string,
  ): Promise<void> {
    await this.users.recordLoginAttempt({
      username: identifier.toLowerCase(),
      userId,
      ip: ctx.ip,
      succeeded: false,
    });
    await this.audit.recordAnonymous({
      actor_user_id: userId,
      action: reason === 'lockout' ? 'lockout' : 'login_failed',
      entity_type: 'session',
      entity_id: identifier.toLowerCase(),
      entity_label: `Failed sign-in: ${identifier}`,
      changes: { reason },
      request_id: ctx.requestId,
      ip: ctx.ip,
      user_agent: ctx.userAgent,
      related: userId ? { user_id: userId } : {},
    });
  }
}

import { Injectable } from '@nestjs/common';
import { expandImplied } from '@mizan/permissions';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/errors.js';
import type { RequestContext } from '../common/request-context.js';
import { Database } from '../database/pool.js';
import { UsersRepository } from '../users/users.repository.js';
import { toUserDto } from '../users/user.types.js';
import type { UserDto } from '../users/user.types.js';
import { DeviceTicketService, MAX_PIN_ATTEMPTS } from './device-ticket.service.js';
import { PasswordService, checkPasswordRules } from './password.service.js';
import { SessionService } from './session.service.js';
import type { SessionWithUser } from './session.service.js';
import { SettingsService } from '../settings/settings.service.js';

/** Sign-in throttling of specification 2.8 / FR-101. */
const MAX_FAILURES = 5;
/** How many browsers may hold a live PIN ticket for one employee at once (2.2.5). */
const MAX_LIVE_TICKETS = 5;
const FAILURE_WINDOW_MINUTES = 15;
const LOCKOUT_MINUTES = 15;

export interface LoginInput {
  username_or_phone: string;
  password: string;
  is_shared_device?: boolean;
  device_label?: string | null;
  /** The ticket this browser already holds, retired as the new one is issued (FR-106). */
  replaces_ticket?: string | null;
}

/** What the lock screen sends when an employee taps their name and types their PIN (FR-106). */
export interface PinLoginInput {
  ticket: string;
  pin: string;
  is_shared_device?: boolean;
  device_label?: string | null;
  /** True when this is a takeover: the session that was open on the tablet is then revoked. */
  switch_from_session?: boolean;
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
    private readonly tickets: DeviceTicketService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

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
  ): Promise<{ token: string; ticket: string; user: UserDto; permissions: string[] }> {
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

    const { token, ticket } = await this.database.transaction(async (tx) => {
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
      // Every password sign-in hands this browser a fresh seven-day ticket, so a PIN can be
      // used here later — and only here (FR-106, 2.8). The ticket this browser was holding is
      // retired in the same breath, so a tablet ends the month with one live ticket per
      // employee rather than one per shift.
      if (input.replaces_ticket) {
        await this.tickets.revokeByTicket(input.replaces_ticket, user.id, 'replaced', tx);
      }
      const issued = await this.tickets.issue(
        {
          userId: user.id,
          isSharedDevice: input.is_shared_device ?? false,
          deviceLabel: input.device_label ?? null,
          userAgent: ctx.userAgent,
        },
        tx,
      );
      // Five browsers is more than any employee here has; the rest are retired (2.2.5).
      await this.tickets.retireBeyond(user.id, MAX_LIVE_TICKETS, tx);
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
            device_ticket_id: issued.row.id,
          },
          request_id: ctx.requestId,
          ip: ctx.ip,
          user_agent: ctx.userAgent,
          related: { user_id: user.id },
        },
        tx,
      );
      return { ...created, ticket: issued.ticket };
    });

    const permissions = user.role === 'admin' ? [] : [...expandImplied(await this.users.permissionsOf(user.id))];
    return { token, ticket, user: toUserDto(user), permissions };
  }

  /**
   * PIN quick sign-in from the lock screen (FR-106, 2.8).
   *
   * Two secrets, never one: the device ticket this browser was handed at the user's last
   * password sign-in, and the PIN. The ticket is what makes six digits acceptable — and the
   * reason a PIN is worthless on a browser the user has never signed into properly.
   */
  async loginWithPin(
    input: PinLoginInput,
    ctx: LoginContext,
    previous: { sessionId: string; userId: string } | null,
  ): Promise<{ token: string; user: UserDto; permissions: string[] }> {
    const ticket = await this.tickets.resolve(input.ticket);
    if (!ticket) {
      // Deliberately the same answer for expired, revoked, exhausted and never-existed: the
      // lock screen's response to all four is the same, which is to ask for the password.
      await this.recordPinFailure(null, ctx, 'ticket_invalid');
      throw new ApiError('UNAUTHENTICATED', { reason: 'ticket_invalid' });
    }
    if (!ticket.user_is_active) {
      await this.recordPinFailure(ticket.user_id, ctx, 'deactivated');
      throw new ApiError('UNAUTHENTICATED', { reason: 'deactivated' });
    }

    const user = await this.users.findById(ticket.user_id);
    if (!user) throw new ApiError('UNAUTHENTICATED', { reason: 'ticket_invalid' });

    // The device kind is the tablet's own claim, and the ticket remembers what it claimed when
    // it was issued; either being shared makes the shared rules apply.
    const shared = (input.is_shared_device ?? false) || ticket.is_shared_device;
    if (shared && !(await this.settings.get('allow_pin_switch_on_shared'))) {
      throw new ApiError('UNAUTHENTICATED', { reason: 'pin_switch_disabled' });
    }

    if (!user.pin_hash || !user.pin_length) {
      throw new ApiError('UNAUTHENTICATED', { reason: 'no_pin' });
    }
    const minimum = shared
      ? await this.settings.get('pin_min_length_shared')
      : await this.settings.get('pin_min_length_personal');
    if (user.pin_length < minimum) {
      // "Set a longer PIN" with a password fallback, rather than a refusal with no way out.
      throw new ApiError('UNAUTHENTICATED', { reason: 'pin_too_short', min: minimum });
    }

    if (!(await this.passwords.verify(user.pin_hash, input.pin))) {
      const { failures, revoked } = await this.tickets.registerPinFailure(ticket.id);
      await this.recordPinFailure(user.id, ctx, revoked ? 'pin_attempts_exhausted' : 'invalid_pin');
      throw new ApiError('UNAUTHENTICATED', {
        reason: revoked ? 'pin_attempts_exhausted' : 'invalid_pin',
        attempts_left: Math.max(0, MAX_PIN_ATTEMPTS - failures),
      });
    }

    const { token } = await this.database.transaction(async (tx) => {
      const created = await this.sessions.create(
        {
          userId: user.id,
          isSharedDevice: shared,
          deviceLabel: input.device_label ?? ticket.device_label,
          authMethod: 'ticket_pin',
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        tx,
      );
      await this.tickets.markUsed(ticket.id, tx);
      await this.users.markSignedIn(user.id, tx);
      await this.users.recordLoginAttempt(
        { username: user.username, userId: user.id, ip: ctx.ip, succeeded: true },
        tx,
      );

      // A takeover ends the previous employee's session on this tablet, and both halves are
      // recorded: who left and who arrived (2.8, FR-1304).
      if (input.switch_from_session && previous) {
        await this.sessions.revoke(previous.sessionId, 'switch_user', tx);
        await this.audit.recordAnonymous(
          {
            actor_user_id: previous.userId,
            action: 'switch_user',
            entity_type: 'session',
            entity_id: previous.sessionId,
            entity_label: 'Handed the device over',
            changes: { to_user_id: user.id, to_user: user.display_name },
            request_id: ctx.requestId,
            ip: ctx.ip,
            user_agent: ctx.userAgent,
            related: { user_id: previous.userId },
          },
          tx,
        );
      }

      await this.audit.recordAnonymous(
        {
          actor_user_id: user.id,
          action: 'login',
          entity_type: 'session',
          entity_id: created.session.id,
          entity_label: `Sign-in: ${user.display_name}`,
          changes: {
            shared_device: shared,
            device_label: input.device_label ?? ticket.device_label,
            auth_method: 'ticket_pin',
            device_ticket_id: ticket.id,
            switched_from_user_id: input.switch_from_session ? previous?.userId ?? null : null,
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

  /**
   * Setting or clearing one's own PIN (FR-106). The current password is required, because a PIN
   * is a credential and an unlocked tablet left on a bench must not be enough to mint one.
   */
  async setPin(context: RequestContext, pin: string | null, currentPassword: string): Promise<void> {
    const user = await this.users.findById(context.userId);
    if (!user) throw new ApiError('UNAUTHENTICATED');

    if (!(await this.passwords.verify(user.password_hash, currentPassword))) {
      throw ApiError.validation([
        { path: 'current_password', code: 'INVALID', message_key: 'auth:invalid_credentials', params: {} },
      ]);
    }

    const personalMinimum = await this.settings.get('pin_min_length_personal');
    if (pin !== null) {
      if (!/^\d+$/.test(pin) || pin.length < personalMinimum || pin.length > 6) {
        throw ApiError.validation([
          { path: 'pin', code: 'INVALID', message_key: 'auth:pin_rules', params: { min: personalMinimum, max: 6 } },
        ]);
      }
    }

    const pinHash = pin === null ? null : await this.passwords.hash(pin);
    await this.database.transaction(async (tx) => {
      const updated = await this.users.update(
        user.id,
        user.version,
        { pin_hash: pinHash, pin_length: pin === null ? null : pin.length },
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
          // The PIN itself is never recorded; its **length** is, because "a four-digit PIN was
          // set on a shared tablet" is exactly what History is for. The field is called
          // `pin_length` and not `pin` on purpose: the audit service strips anything named
          // `pin` outright (its `NEVER_LOGGED` guard from I0), which is a guard worth keeping.
          changes: { pin_length: { old: user.pin_length, new: pin === null ? null : pin.length } },
          related: { user_id: user.id },
        },
        tx,
      );
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
   * Unlock keeps the same session and the drafts that belong to it (spec 2.8): the same person
   * proving again that it is still them, with their PIN or their password.
   *
   * Five wrong PINs and only the password will do — counted on the session, because that is
   * whose unlock it is, and cleared the moment the session is unlocked. The session's
   * `auth_method` is **not** rewritten by a PIN unlock: it records how the session was
   * established, which is the question History asks of it (D-034).
   */
  async unlock(
    context: RequestContext,
    session: SessionWithUser,
    credentials: { password?: string; pin?: string },
  ): Promise<void> {
    const user = await this.users.findById(context.userId);
    if (!user) throw new ApiError('UNAUTHENTICATED');

    let method: 'password' | 'pin';
    if (credentials.pin !== undefined) {
      method = 'pin';
      const failures = await this.sessions.pinFailures(session.id);
      if (failures >= MAX_PIN_ATTEMPTS) {
        throw ApiError.validation([
          { path: 'pin', code: 'INVALID', message_key: 'auth:pin_attempts_exhausted', params: {} },
        ]);
      }
      if (!user.pin_hash || !user.pin_length) {
        throw ApiError.validation([
          { path: 'pin', code: 'INVALID', message_key: 'auth:no_pin', params: {} },
        ]);
      }
      const minimum = session.is_shared_device
        ? await this.settings.get('pin_min_length_shared')
        : await this.settings.get('pin_min_length_personal');
      if (user.pin_length < minimum) {
        throw ApiError.validation([
          { path: 'pin', code: 'INVALID', message_key: 'auth:pin_too_short', params: { min: minimum } },
        ]);
      }
      if (!(await this.passwords.verify(user.pin_hash, credentials.pin))) {
        const left = Math.max(0, MAX_PIN_ATTEMPTS - (await this.sessions.registerPinFailure(session.id)));
        throw ApiError.validation([
          { path: 'pin', code: 'INVALID', message_key: 'auth:invalid_pin', params: { attempts_left: left } },
        ]);
      }
    } else {
      method = 'password';
      if (!credentials.password || !(await this.passwords.verify(user.password_hash, credentials.password))) {
        throw ApiError.validation([
          { path: 'password', code: 'INVALID', message_key: 'auth:invalid_credentials', params: {} },
        ]);
      }
    }

    await this.sessions.unlock(session);
    await this.audit.record(context, {
      action: 'unlock',
      entity_type: 'session',
      entity_id: context.sessionId,
      entity_label: 'Screen unlocked',
      changes: { unlocked_with: method },
      related: { user_id: context.userId },
    });
  }

  /**
   * A failed PIN attempt. It is *not* written to `login_attempts`, because that table drives the
   * password lockout of 2.8 and a PIN has its own consequence — the ticket is revoked after five
   * — so mixing them would lock a username out of the Login page because somebody mistyped six
   * digits on a tablet (D-035).
   */
  private async recordPinFailure(userId: string | null, ctx: LoginContext, reason: string): Promise<void> {
    await this.audit.recordAnonymous({
      actor_user_id: userId,
      action: reason === 'pin_attempts_exhausted' ? 'lockout' : 'login_failed',
      entity_type: 'session',
      entity_id: userId ?? 'unknown-ticket',
      entity_label: 'Failed PIN sign-in',
      changes: { reason, auth_method: 'ticket_pin' },
      request_id: ctx.requestId,
      ip: ctx.ip,
      user_agent: ctx.userAgent,
      related: userId ? { user_id: userId } : {},
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

import { Injectable } from '@nestjs/common';
import { PRESETS, assertKnownKeys, diffSets, expandImplied } from '@mizan/permissions';
import type { PresetKey } from '@mizan/permissions';
import { normalizePhone } from '@mizan/text';
import { AuditService, diffOf } from '../audit/audit.service.js';
import { ApiError } from '../common/errors.js';
import type { RequestContext } from '../common/request-context.js';
import { Database } from '../database/pool.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { PasswordService, checkPasswordRules } from '../auth/password.service.js';
import { DeviceTicketService } from '../auth/device-ticket.service.js';
import { SessionService } from '../auth/session.service.js';
import { UsersRepository } from './users.repository.js';
import type { UserFilters } from './users.repository.js';
import { toUserDto } from './user.types.js';
import type { UserDto, UserRole, UserRow } from './user.types.js';

export interface CreateUserInput {
  display_name: string;
  username: string;
  phone?: string | null;
  role: UserRole;
  preset_key?: PresetKey | null;
  /**
   * The exact set this employee starts with, per action per feature.
   *
   * Without it a new employee could only be given one of the three presets and had to be
   * opened and edited to be given anything else — so the screen that decides what somebody may
   * do was not the screen that created them. Absent means "whatever the preset says", which is
   * what every existing caller means (FR-105, FR-204).
   */
  keys?: string[];
  password?: string;
}

export interface UpdateUserInput {
  display_name?: string;
  username?: string;
  phone?: string | null;
  role?: UserRole;
  version: number;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly database: Database,
    private readonly users: UsersRepository,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly tickets: DeviceTicketService,
    private readonly audit: AuditService,
    private readonly authGuard: AuthGuard,
  ) {}

  async list(filters: UserFilters): Promise<{ items: UserDto[]; total: number }> {
    const { rows, total } = await this.users.list(filters);
    return { items: rows.map(toUserDto), total };
  }

  async directory() {
    return this.users.directory();
  }

  async get(id: string): Promise<UserDto> {
    const row = await this.users.findById(id);
    if (!row) throw ApiError.notFound();
    return toUserDto(row);
  }

  /**
   * Creating an employee (FR-201). The temporary password is returned **once**, in the create
   * response only: it is never stored in clear and never written to History (spec 2.4.4).
   */
  async create(context: RequestContext, input: CreateUserInput): Promise<{ user: UserDto; temporary_password: string }> {
    const username = input.username.trim().toLowerCase();
    const phone = input.phone ? normalizePhone(input.phone) : null;

    await this.assertUsernameFree(username);
    if (phone) await this.assertPhoneFree(phone);

    const temporary = input.password ?? this.passwords.generateTemporary();
    const problem = checkPasswordRules(temporary, username);
    if (problem) {
      throw ApiError.validation([
        { path: 'password', code: problem.code, message_key: problem.message_key, params: {} },
      ]);
    }

    const preset = input.preset_key ? PRESETS[input.preset_key] : null;

    /**
     * An admin holds every key implicitly, so a set chosen for one is a contradiction rather
     * than a generosity — the same refusal `setPermissions` gives.
     */
    if (input.keys && input.role === 'admin' && input.keys.length > 0) {
      throw ApiError.validation([
        { path: 'keys', code: 'ADMIN_HOLDS_ALL', message_key: 'errors:field.required', params: {} },
      ]);
    }
    if (input.keys) {
      try {
        assertKnownKeys(input.keys);
      } catch (error) {
        throw ApiError.validation([
          {
            path: 'keys',
            code: 'UNKNOWN_KEY',
            message_key: 'errors:field.required',
            params: { reason: (error as Error).message },
          },
        ]);
      }
    }
    // The chosen set, closed under what each key implies; a preset with no explicit set is
    // exactly the old behaviour.
    const granted =
      input.role === 'admin'
        ? []
        : input.keys
          ? [...expandImplied(input.keys)].sort()
          : preset
            ? [...expandImplied(preset.keys)].sort()
            : [];

    const passwordHash = await this.passwords.hash(temporary);

    const created = await this.database.transaction(async (tx) => {
      const user = await this.users.create(
        {
          username,
          display_name: input.display_name.trim(),
          phone,
          role: input.role,
          password_hash: passwordHash,
          preset_key: preset?.key ?? null,
          preset_version: preset?.version ?? null,
          created_by: context.userId,
        },
        tx,
      );

      // A preset is a starting point, stored as an ordinary set of keys (FR-105) — and so is
      // the set the admin chose on the create screen.
      if (granted.length > 0) {
        await this.users.replacePermissions(user.id, granted, context.userId, tx);
      }

      await this.audit.record(
        context,
        {
          action: 'create',
          entity_type: 'user',
          entity_id: user.id,
          entity_label: `Employee: ${user.display_name}`,
          changes: {
            username: { old: null, new: user.username },
            display_name: { old: null, new: user.display_name },
            role: { old: null, new: user.role },
            preset_key: { old: null, new: user.preset_key },
            // What they may do, in the row that created them: History should not need a second
            // entry to answer "what was this employee given on their first day?" (rule 3).
            permissions: { old: [], new: granted },
          },
          related: { user_id: user.id },
        },
        tx,
      );
      return user;
    });

    return { user: toUserDto(created), temporary_password: temporary };
  }

  async update(context: RequestContext, id: string, input: UpdateUserInput): Promise<UserDto> {
    const existing = await this.requireUser(id);

    if (input.username && input.username.toLowerCase() !== existing.username) {
      await this.assertUsernameFree(input.username.toLowerCase(), id);
    }
    const phone = input.phone === undefined ? undefined : input.phone ? normalizePhone(input.phone) : null;
    if (phone) await this.assertPhoneFree(phone, id);

    // Admin safety: nobody demotes themselves, and the last active admin cannot be demoted
    // by anyone — otherwise the system can be left with no way in (FR-107, spec 2.6.6).
    if (input.role && input.role !== existing.role) {
      if (existing.id === context.userId) throw new ApiError('LAST_ADMIN', { reason: 'self_role' });
      if (existing.role === 'admin' && (await this.users.countActiveAdmins(existing.id)) === 0) {
        throw new ApiError('LAST_ADMIN', { reason: 'last_admin' });
      }
    }

    const patch: Record<string, unknown> = {};
    if (input.display_name !== undefined) patch.display_name = input.display_name.trim();
    if (input.username !== undefined) patch.username = input.username.toLowerCase();
    if (phone !== undefined) patch.phone = phone;
    if (input.role !== undefined) patch.role = input.role;

    return this.database.transaction(async (tx) => {
      const updated = await this.users.update(id, input.version, patch, context.userId, tx);
      if (!updated) throw new ApiError('VERSION_CONFLICT', { current_version: existing.version });

      const changes = diffOf(existing as unknown as Record<string, unknown>, patch, [
        'display_name',
        'username',
        'phone',
        'role',
      ]);
      if (Object.keys(changes).length > 0) {
        await this.audit.record(
          context,
          {
            action: 'update',
            entity_type: 'user',
            entity_id: id,
            entity_label: `Employee: ${updated.display_name}`,
            changes,
            related: { user_id: id },
          },
          tx,
        );
      }
      return toUserDto(updated);
    });
  }

  /** Users are deactivated, never deleted, so every historical row keeps its author (FR-203). */
  async setActive(context: RequestContext, id: string, isActive: boolean, version: number): Promise<UserDto> {
    const existing = await this.requireUser(id);

    if (!isActive) {
      if (existing.id === context.userId) throw new ApiError('LAST_ADMIN', { reason: 'self_deactivate' });
      if (existing.role === 'admin' && (await this.users.countActiveAdmins(existing.id)) === 0) {
        throw new ApiError('LAST_ADMIN', { reason: 'last_admin' });
      }
    }

    return this.database.transaction(async (tx) => {
      const updated = await this.users.update(id, version, { is_active: isActive }, context.userId, tx);
      if (!updated) throw new ApiError('VERSION_CONFLICT', { current_version: existing.version });

      // Deactivation ends their sessions; the guard also refuses an inactive user immediately.
      if (!isActive) {
        await this.sessions.revokeAllForUser(id, 'deactivated', tx);
        // A PIN on a floor tablet must stop working the moment the account does (2.8).
        await this.tickets.revokeAllForUser(id, 'deactivated', tx);
      }

      await this.audit.record(
        context,
        {
          action: 'status_change',
          entity_type: 'user',
          entity_id: id,
          entity_label: `Employee: ${updated.display_name}`,
          changes: { is_active: { old: existing.is_active, new: isActive } },
          related: { user_id: id },
        },
        tx,
      );
      return toUserDto(updated);
    });
  }

  /**
   * An admin reset shows the temporary password once, forces a change at next sign-in and
   * ends every session the user had (FR-108, FR-202).
   */
  async resetPassword(context: RequestContext, id: string): Promise<{ temporary_password: string }> {
    const existing = await this.requireUser(id);
    const temporary = this.passwords.generateTemporary();
    const passwordHash = await this.passwords.hash(temporary);

    await this.database.transaction(async (tx) => {
      const updated = await this.users.update(
        id,
        existing.version,
        { password_hash: passwordHash, must_change_password: true },
        context.userId,
        tx,
      );
      if (!updated) throw new ApiError('VERSION_CONFLICT', { current_version: existing.version });

      await this.sessions.revokeAllForUser(id, 'password_reset', tx);
      // The old ticket proved a password sign-in that no longer means anything (2.8).
      await this.tickets.revokeAllForUser(id, 'password_reset', tx);
      await this.audit.record(
        context,
        {
          action: 'password_reset',
          entity_type: 'user',
          entity_id: id,
          entity_label: `Employee: ${existing.display_name}`,
          note: 'temporary password issued; sessions revoked',
          related: { user_id: id },
        },
        tx,
      );
    });

    return { temporary_password: temporary };
  }

  async permissions(id: string): Promise<{ keys: string[]; preset_key: string | null; effective: string[] }> {
    const user = await this.requireUser(id);
    const keys = await this.users.permissionsOf(id);
    return {
      keys,
      preset_key: user.preset_key,
      // Admins hold everything implicitly and store no rows at all (spec 2.6.1).
      effective: user.role === 'admin' ? [] : [...expandImplied(keys)],
    };
  }

  /**
   * The whole set is replaced in one call and logged as old set → new set (FR-103, FR-204).
   * Simple mode and the Advanced grid both land here; the server does not care which sent it.
   */
  async setPermissions(
    context: RequestContext,
    id: string,
    input: { keys: string[]; preset_key?: PresetKey | null },
  ): Promise<{ keys: string[]; preset_key: string | null }> {
    const user = await this.requireUser(id);
    if (user.role === 'admin') {
      throw ApiError.validation([
        { path: 'keys', code: 'ADMIN_HOLDS_ALL', message_key: 'errors:field.required', params: {} },
      ]);
    }

    try {
      assertKnownKeys(input.keys);
    } catch (error) {
      throw ApiError.validation([
        { path: 'keys', code: 'UNKNOWN_KEY', message_key: 'errors:field.required', params: { reason: (error as Error).message } },
      ]);
    }

    const before = await this.users.permissionsOf(id);
    const after = [...expandImplied(input.keys)].sort();
    const diff = diffSets(before, after);
    const preset = input.preset_key ? PRESETS[input.preset_key] : null;

    await this.database.transaction(async (tx) => {
      await this.users.replacePermissions(id, after, context.userId, tx);
      if (input.preset_key !== undefined) {
        await this.users.update(
          id,
          user.version,
          { preset_key: preset?.key ?? null, preset_version: preset?.version ?? null },
          context.userId,
          tx,
        );
      }
      if (diff.granted.length > 0 || diff.revoked.length > 0 || input.preset_key !== undefined) {
        await this.audit.record(
          context,
          {
            action: 'permission_change',
            entity_type: 'user',
            entity_id: id,
            entity_label: `Employee: ${user.display_name}`,
            changes: {
              permissions: { old: before, new: after },
              granted: diff.granted,
              revoked: diff.revoked,
              preset_key: { old: user.preset_key, new: preset?.key ?? null },
            },
            related: { user_id: id },
          },
          tx,
        );
      }
    });

    // The change takes effect at their next request, with no re-login (FR-103).
    this.authGuard.invalidate(id);
    return { keys: after, preset_key: preset?.key ?? null };
  }

  /**
   * The admin's Sessions tab (FR-1304): where this employee is signed in, and which browsers
   * may sign them in with a PIN. Both lists answer the same question — "who can act as this
   * person right now, and from what" — so they arrive together.
   */
  async sessionsOf(id: string) {
    await this.requireUser(id);
    const [sessions, tickets] = await Promise.all([
      this.sessions.listForUser(id),
      this.tickets.listForUser(id),
    ]);
    return { sessions, device_tickets: tickets };
  }

  async revokeSession(context: RequestContext, id: string, sessionId: string): Promise<void> {
    await this.requireUser(id);
    await this.sessions.revoke(sessionId, 'revoked_by_admin');
    await this.audit.record(context, {
      action: 'logout',
      entity_type: 'session',
      entity_id: sessionId,
      entity_label: 'Session revoked by admin',
      related: { user_id: id },
    });
  }

  /**
   * Take PIN sign-in away from every browser this employee has proved themselves on (2.8): the
   * tablet that left the building, the phone that was lost. Their next sign-in anywhere asks
   * for the password, which issues a fresh ticket — so this is a reset, not a punishment.
   */
  async revokeDeviceTickets(context: RequestContext, id: string): Promise<{ revoked: number }> {
    const user = await this.requireUser(id);
    const revoked = await this.tickets.revokeAllForUser(id, 'revoked_by_admin');
    await this.audit.record(context, {
      action: 'update',
      entity_type: 'user',
      entity_id: id,
      entity_label: `Employee: ${user.display_name}`,
      changes: { device_tickets: { old: revoked, new: 0 } },
      note: 'PIN sign-in revoked on every device',
      related: { user_id: id },
    });
    return { revoked };
  }

  private async requireUser(id: string): Promise<UserRow> {
    const row = await this.users.findById(id);
    if (!row) throw ApiError.notFound();
    return row;
  }

  private async assertUsernameFree(username: string, exceptId?: string): Promise<void> {
    const existing = await this.users.findByUsername(username);
    if (existing && existing.id !== exceptId) {
      throw ApiError.validation([
        { path: 'username', code: 'TAKEN', message_key: 'errors:field.username_taken', params: {} },
      ]);
    }
  }

  private async assertPhoneFree(phone: string, exceptId?: string): Promise<void> {
    const existing = await this.users.findByPhone(phone);
    if (existing && existing.id !== exceptId) {
      throw ApiError.validation([
        { path: 'phone', code: 'TAKEN', message_key: 'errors:field.phone_taken', params: {} },
      ]);
    }
  }
}

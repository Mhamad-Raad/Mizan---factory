import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { EXTRAS, PERMISSIONS, PRESETS } from '@mizan/permissions';
import { AdminOnly, SessionOnly } from '../common/decorators.js';
import { contextOf } from '../common/request-context.js';
import type { RequestWithContext } from '../common/request-context.js';
import { zodBody } from '../common/zod.pipe.js';
import { UsersService } from './users.service.js';

const presetKeys = ['sales', 'warehouse', 'accountant'] as const;

const createSchema = z.object({
  display_name: z.string().min(1).max(120),
  username: z.string().regex(/^[a-zA-Z0-9._]{3,32}$/),
  phone: z.string().max(32).nullish(),
  role: z.enum(['admin', 'employee']),
  preset_key: z.enum(presetKeys).nullish(),
});

const updateSchema = z.object({
  display_name: z.string().min(1).max(120).optional(),
  username: z.string().regex(/^[a-zA-Z0-9._]{3,32}$/).optional(),
  phone: z.string().max(32).nullish(),
  role: z.enum(['admin', 'employee']).optional(),
  version: z.number().int().positive(),
});

const statusSchema = z.object({ version: z.number().int().positive() });

const permissionsSchema = z.object({
  keys: z.array(z.string()).max(200),
  preset_key: z.enum(presetKeys).nullish(),
});

const listSchema = z.object({
  q: z.string().optional(),
  include_inactive: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().positive().optional(),
  page_size: z.coerce.number().int().positive().max(100).optional(),
});

/**
 * User management is admin-only and not delegable (A-28, spec 1.5.2 rule 1), so these routes
 * carry `@AdminOnly()` rather than a permission key. The one exception is the directory,
 * which any signed-in user needs for "Done by" and "Assigned to" pickers (spec 2.7).
 */
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('users/directory')
  @SessionOnly()
  directory() {
    return this.users.directory();
  }

  @Get('permissions/catalog')
  @SessionOnly()
  catalog() {
    return {
      permissions: PERMISSIONS,
      extras: EXTRAS,
    };
  }

  @Get('permissions/presets')
  @SessionOnly()
  presets() {
    return Object.values(PRESETS);
  }

  @Get('users')
  @AdminOnly()
  async list(@Query(zodBody(listSchema)) query: z.infer<typeof listSchema>) {
    return this.users.list({
      q: query.q,
      include_inactive: query.include_inactive === 'true',
      page: query.page,
      page_size: query.page_size,
    });
  }

  @Post('users')
  @AdminOnly()
  @HttpCode(201)
  async create(@Req() request: RequestWithContext, @Body(zodBody(createSchema)) body: z.infer<typeof createSchema>) {
    return this.users.create(contextOf(request), body);
  }

  @Get('users/:id')
  @AdminOnly()
  async get(@Param('id') id: string) {
    return this.users.get(id);
  }

  @Patch('users/:id')
  @AdminOnly()
  async update(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    return this.users.update(contextOf(request), id, body);
  }

  @Post('users/:id/deactivate')
  @AdminOnly()
  async deactivate(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(statusSchema)) body: z.infer<typeof statusSchema>,
  ) {
    return this.users.setActive(contextOf(request), id, false, body.version);
  }

  @Post('users/:id/reactivate')
  @AdminOnly()
  async reactivate(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(statusSchema)) body: z.infer<typeof statusSchema>,
  ) {
    return this.users.setActive(contextOf(request), id, true, body.version);
  }

  @Post('users/:id/reset-password')
  @AdminOnly()
  async resetPassword(@Req() request: RequestWithContext, @Param('id') id: string) {
    return this.users.resetPassword(contextOf(request), id);
  }

  @Get('users/:id/permissions')
  @AdminOnly()
  async permissions(@Param('id') id: string) {
    return this.users.permissions(id);
  }

  @Post('users/:id/permissions')
  @AdminOnly()
  async setPermissions(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(permissionsSchema)) body: z.infer<typeof permissionsSchema>,
  ) {
    return this.users.setPermissions(contextOf(request), id, body);
  }

  @Get('users/:id/sessions')
  @AdminOnly()
  async sessions(@Param('id') id: string) {
    return this.users.sessionsOf(id);
  }

  @Delete('users/:id/sessions/:sessionId')
  @AdminOnly()
  @HttpCode(204)
  async revokeSession(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
  ) {
    await this.users.revokeSession(contextOf(request), id, sessionId);
  }

  /**
   * Take PIN sign-in away from every browser at once (2.9.3). One route rather than one per
   * ticket, because the question an admin actually has is "make the PIN stop working", and
   * revoking one of three tablets leaves the other two (D-036).
   */
  @Delete('users/:id/device-tickets')
  @AdminOnly()
  async revokeDeviceTickets(@Req() request: RequestWithContext, @Param('id') id: string) {
    return this.users.revokeDeviceTickets(contextOf(request), id);
  }
}

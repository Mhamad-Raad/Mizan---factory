import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../common/decorators.js';
import { contextOf } from '../common/request-context.js';
import type { RequestWithContext } from '../common/request-context.js';
import { zodBody } from '../common/zod.pipe.js';
import { pageFields } from '../common/paging.js';
import { DriversService } from './drivers.service.js';

const listSchema = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(['active', 'inactive', 'all']).optional(),
  ...pageFields,
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().max(40).nullish(),
  car_number: z.string().max(50).nullish(),
  notes: z.string().max(2000).nullish(),
  confirm_duplicate_phone: z.boolean().optional(),
});

const updateSchema = createSchema.partial().extend({ version: z.number().int().positive() });
const statusSchema = z.object({
  version: z.number().int().positive(),
  note: z.string().max(2000).nullish(),
});

/**
 * Drivers (D-105). Reading them is `drivers.view`, which writing an order brings with it (the
 * order form picks one); adding is `drivers.create`; editing and deactivating are `drivers.edit`.
 * Nothing here is money, so nothing is stripped.
 */
@Controller()
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  @Get('drivers')
  @RequirePermission('drivers.view')
  async list(@Query(zodBody(listSchema)) query: z.infer<typeof listSchema>) {
    return this.drivers.list(query);
  }

  @Post('drivers')
  @RequirePermission('drivers.create')
  @HttpCode(201)
  async create(
    @Req() request: RequestWithContext,
    @Body(zodBody(createSchema)) body: z.infer<typeof createSchema>,
  ) {
    return this.drivers.create(contextOf(request), body);
  }

  @Get('drivers/:id')
  @RequirePermission('drivers.view')
  async get(@Param('id') id: string) {
    return this.drivers.get(id);
  }

  @Patch('drivers/:id')
  @RequirePermission('drivers.edit')
  async update(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    return this.drivers.update(contextOf(request), id, body);
  }

  @Post('drivers/:id/deactivate')
  @RequirePermission('drivers.edit')
  @HttpCode(200)
  async deactivate(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(statusSchema)) body: z.infer<typeof statusSchema>,
  ) {
    return this.drivers.setActive(contextOf(request), id, false, body);
  }

  @Post('drivers/:id/reactivate')
  @RequirePermission('drivers.edit')
  @HttpCode(200)
  async reactivate(
    @Req() request: RequestWithContext,
    @Param('id') id: string,
    @Body(zodBody(statusSchema)) body: z.infer<typeof statusSchema>,
  ) {
    return this.drivers.setActive(contextOf(request), id, true, body);
  }
}

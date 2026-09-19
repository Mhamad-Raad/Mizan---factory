import { Controller, Get, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission, SessionOnly } from '../common/decorators.js';
import { contextOf, can } from '../common/request-context.js';
import type { RequestWithContext } from '../common/request-context.js';
import { zodBody } from '../common/zod.pipe.js';
import { HistoryRepository } from './history.repository.js';

const listSchema = z.object({
  done_by: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  entity_type: z.string().max(40).optional(),
  entity_id: z.string().max(64).optional(),
  action: z.string().max(40).optional(),
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

@Controller('history')
export class HistoryController {
  constructor(private readonly history: HistoryRepository) {}

  @Get()
  @RequirePermission('history.view')
  async list(@Req() request: RequestWithContext, @Query(zodBody(listSchema)) query: z.infer<typeof listSchema>) {
    const context = contextOf(request);
    // Without `history.view_all` the page shows only the user's own actions. The scope is
    // applied here, over the query, never by the interface (spec 2.6.4).
    const scoped = can(context, 'history.view_all') ? query.done_by : context.userId;
    return this.history.list({ ...query, done_by: scoped });
  }

  @Get('me')
  @SessionOnly()
  async mine(@Req() request: RequestWithContext, @Query(zodBody(listSchema)) query: z.infer<typeof listSchema>) {
    // Every user may always read their own audit trail, even without `history.view`
    // (spec 1.5.2 rule 3) — it is "My activity" in Settings.
    return this.history.list({ ...query, done_by: contextOf(request).userId });
  }
}

import { Controller, Get, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { isoDate } from '../common/schemas.js';
import { RequirePermission, SessionOnly } from '../common/decorators.js';
import { contextOf, can } from '../common/request-context.js';
import type { RequestWithContext } from '../common/request-context.js';
import { zodBody } from '../common/zod.pipe.js';
import { HistoryRepository } from './history.repository.js';
import { stripHistory } from './history-fields.js';
import { cursorField, limitField } from '../common/paging.js';

const listSchema = z.object({
  done_by: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  entity_type: z.string().max(40).optional(),
  entity_id: z.string().max(64).optional(),
  action: z.string().max(40).optional(),
  /** `false` hides signing in and out and screen locks (client review). */
  sessions: z.enum(['true', 'false']).optional(),
  cursor: cursorField,
  limit: limitField,
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
    // The page groups an edit storm into one entry (2.4.5); a record's own History tab does
    // not, because there the whole story is the point.
    const page = await this.history.list({
      ...query,
      sessions: query.sessions !== 'false',
      done_by: scoped,
      group_edits: true,
    });
    return { ...page, items: stripHistory(context, page.items) };
  }

  @Get('me')
  @SessionOnly()
  async mine(@Req() request: RequestWithContext, @Query(zodBody(listSchema)) query: z.infer<typeof listSchema>) {
    // Every user may always read their own audit trail, even without `history.view`
    // (spec 1.5.2 rule 3) — it is "My activity" in Settings.
    const context = contextOf(request);
    const page = await this.history.list({
      ...query,
      sessions: query.sessions !== 'false',
      done_by: context.userId,
    });
    // Their own actions, but not the figures their flags withhold elsewhere.
    return { ...page, items: stripHistory(context, page.items) };
  }
}

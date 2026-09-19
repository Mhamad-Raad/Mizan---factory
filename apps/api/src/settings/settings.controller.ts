import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { z } from 'zod';
import { AdminOnly, SessionOnly } from '../common/decorators.js';
import { contextOf } from '../common/request-context.js';
import type { RequestWithContext } from '../common/request-context.js';
import { zodBody } from '../common/zod.pipe.js';
import { SettingsService } from './settings.service.js';
import { PUBLIC_SETTING_KEYS } from './settings.types.js';

const patchSchema = z.object({
  idle_lock_shared_minutes: z.number().int().min(1).max(120).optional(),
  idle_lock_default_minutes: z.number().int().min(1).max(1440).optional(),
  week_start: z.enum(['sat', 'sun', 'mon']).optional(),
  date_format: z.literal('dd/MM/yyyy').optional(),
})
  // Unknown keys are refused rather than dropped: an admin who types a setting this
  // iteration does not own must be told, not quietly ignored.
  .strict();

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /**
   * Everyone reads the two settings that shape the interface (week start, date format);
   * everything else is admin-only, so the response is filtered by role (FR-1107).
   */
  @Get()
  @SessionOnly()
  async read(@Req() request: RequestWithContext) {
    const all = await this.settings.all();
    if (contextOf(request).role === 'admin') return all;
    return Object.fromEntries(PUBLIC_SETTING_KEYS.map((key) => [key, all[key]]));
  }

  @Patch()
  @AdminOnly()
  async update(@Req() request: RequestWithContext, @Body(zodBody(patchSchema)) body: z.infer<typeof patchSchema>) {
    return this.settings.update(contextOf(request), body);
  }
}

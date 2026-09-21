import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { AdminOnly } from '../common/decorators.js';
import { ApiError } from '../common/errors.js';
import { contextOf } from '../common/request-context.js';
import type { RequestWithContext } from '../common/request-context.js';
import { Req } from '@nestjs/common';
import { zodBody } from '../common/zod.pipe.js';
import { IMPORT_KINDS, ImportsService } from './imports.service.js';
import type { ImportKind } from './imports.service.js';

/**
 * The rows arrive as JSON, not as a file.
 *
 * The browser reads the CSV the admin picked, parses it — quoted commas, a byte-order mark, the
 * Windows line endings Excel writes — and sends the rows. So the API takes structured data and
 * has no CSV parser, no multipart handling and no temporary files to clean up, and the preview
 * can show the admin their own spreadsheet before anything is sent at all.
 */
const rowsSchema = z.object({
  rows: z
    .array(z.record(z.string(), z.union([z.string(), z.null()])))
    // Ten thousand customers is the design point of NFR-13; a file larger than that is a
    // mistake, and a request that large belongs in several files anyway.
    .min(1)
    .max(10_000),
});

@Controller('imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  /** The templates, so the client can offer an empty CSV with the right headers (FR-1312). */
  @Get('templates')
  @AdminOnly()
  templates() {
    return {
      kinds: IMPORT_KINDS.map((kind) => ({ kind, ...this.imports.columnsOf(kind) })),
    };
  }

  /** What the file would do, per row, without doing any of it. */
  @Post(':kind/preview')
  @AdminOnly()
  async preview(@Param('kind') kind: string, @Body(zodBody(rowsSchema)) body: z.infer<typeof rowsSchema>) {
    return this.imports.preview(assertKind(kind), body.rows);
  }

  /**
   * Writes the rows. Admin-only, like every other bulk power in this system, and every row is
   * attributed to the admin who ran it.
   */
  @Post(':kind')
  @AdminOnly()
  async run(
    @Req() request: RequestWithContext,
    @Param('kind') kind: string,
    @Body(zodBody(rowsSchema)) body: z.infer<typeof rowsSchema>,
  ) {
    return this.imports.run(contextOf(request), assertKind(kind), body.rows);
  }
}

function assertKind(kind: string): ImportKind {
  if (!IMPORT_KINDS.includes(kind as ImportKind)) {
    throw ApiError.validation([
      { path: 'kind', code: 'INVALID', message_key: 'imports:unknown_kind', params: { kind } },
    ]);
  }
  return kind as ImportKind;
}

import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * How large a request body this API will read — one number, in one place, used by both the
 * server and the test harness.
 *
 * The default is 100 kB, which is about 1,800 rows of a CSV import, while the import's own
 * schema accepts **10,000** (565 kB of materials, 1.3 MB of opening debts with their notes).
 * The two disagreed silently, and a file over the parser's limit answered `500 INTERNAL` — on
 * the one day this system asks somebody to hand it a large file, at go-live.
 *
 * It lived in `main.ts` alone, which is why no test could see it: the harness builds its own
 * application. So it lives here, applied by both, and `imports.test.ts` sends ten thousand rows
 * through it — the two ends of the promise can no longer drift apart.
 */
export const REQUEST_BODY_LIMIT = '4mb';

export function applyRequestLimits(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: REQUEST_BODY_LIMIT });
}

import { Controller, Get, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { normalizeForSearch, normalizePhone } from '@mizan/text';
import { SessionOnly } from '../common/decorators.js';
import { can, contextOf } from '../common/request-context.js';
import type { RequestWithContext } from '../common/request-context.js';
import { Database } from '../database/pool.js';
import { zodBody } from '../common/zod.pipe.js';

const searchSchema = z.object({ q: z.string().min(1).max(200) });

export interface SearchHit {
  kind: 'item' | 'customer' | 'order' | 'purchase';
  id: string;
  title: string;
  subtitle: string | null;
}

/**
 * Global search (FR-1310, **Proposed — not requested**).
 *
 * Two things make it worth having on a factory floor: "کاوا" typed on an Arabic keyboard finds
 * "كاوا" (2.10.7 normalisation, the same helper the pickers use), and a number typed on its own
 * finds the order or purchase with that number.
 *
 * The route is `@SessionOnly()` because it has no single key of its own: each **section** is
 * included only for a caller who may see that kind of record (2.9.3, "per-resource view keys"),
 * which is checked here with the permission set of the request. A section the caller cannot see
 * is absent, never empty-but-present.
 */
@Controller('search')
export class SearchController {
  constructor(private readonly database: Database) {}

  @Get()
  @SessionOnly()
  async search(
    @Req() request: RequestWithContext,
    @Query(zodBody(searchSchema)) query: z.infer<typeof searchSchema>,
  ): Promise<{ query: string; hits: SearchHit[] }> {
    const context = contextOf(request);
    const text = query.q.trim();
    const normalized = `%${normalizeForSearch(text)}%`;
    const phone = normalizePhone(text);
    const asNumber = Number(text.replace(/\D/g, ''));
    const number = Number.isFinite(asNumber) && asNumber > 0 ? asNumber : null;

    const sections: Promise<SearchHit[]>[] = [];
    if (can(context, 'materials.view')) sections.push(this.items(normalized));
    // One record per business (D-054): a supplier is found here too, for whoever may see suppliers.
    if (can(context, 'customers.view')) sections.push(this.customers(normalized, phone));
    if (number !== null && can(context, 'orders.view')) sections.push(this.orders(number));
    if (number !== null && can(context, 'purchases.view')) sections.push(this.purchases(number));

    const hits = (await Promise.all(sections)).flat();
    return { query: text, hits };
  }

  private async items(normalized: string): Promise<SearchHit[]> {
    const { rows } = await this.database.query<{ id: string; name: string; code: string | null }>(
      `SELECT id, name, code FROM items
        WHERE deleted_at IS NULL AND (name_normalized LIKE $1 OR code ILIKE $1)
        ORDER BY name ASC LIMIT 5`,
      [normalized],
    );
    return rows.map((row) => ({ kind: 'item', id: row.id, title: row.name, subtitle: row.code }));
  }

  /** Every account, for whoever may see accounts — they are nobody's in particular (D-056). */
  private async customers(normalized: string, phone: string): Promise<SearchHit[]> {
    const { rows } = await this.database.query<{ id: string; name: string; phone: string | null }>(
      `SELECT id, name, phone FROM customers
        WHERE deleted_at IS NULL
          AND (name_normalized LIKE $1
               OR ($2::text <> '' AND phone_normalized LIKE '%' || $2 || '%'))
        ORDER BY name ASC LIMIT 5`,
      [normalized, phone],
    );
    return rows.map((row) => ({ kind: 'customer', id: row.id, title: row.name, subtitle: row.phone }));
  }

  private async orders(number: number): Promise<SearchHit[]> {
    const { rows } = await this.database.query<{ id: string; number: string; name: string; order_date: string }>(
      `SELECT o.id, o.number::text AS number, c.name,
              to_char(o.order_date, 'YYYY-MM-DD') AS order_date
         FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.deleted_at IS NULL AND o.number = $1::bigint
        LIMIT 3`,
      [number],
    );
    return rows.map((row) => ({
      kind: 'order',
      id: row.id,
      title: `#${row.number}`,
      subtitle: `${row.name} · ${row.order_date}`,
    }));
  }

  private async purchases(number: number): Promise<SearchHit[]> {
    const { rows } = await this.database.query<{
      id: string;
      number: string;
      name: string | null;
      purchase_date: string;
    }>(
      `SELECT p.id, p.number::text AS number, co.name,
              to_char(p.purchase_date, 'YYYY-MM-DD') AS purchase_date
         FROM purchases p LEFT JOIN customers co ON co.id = p.company_id
        WHERE p.deleted_at IS NULL AND p.number = $1::bigint
        LIMIT 3`,
      [number],
    );
    return rows.map((row) => ({
      kind: 'purchase',
      id: row.id,
      title: `#${row.number}`,
      subtitle: [row.name, row.purchase_date].filter(Boolean).join(' · '),
    }));
  }
}

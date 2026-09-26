import type { RequestContext } from '../common/request-context.js';

const BOUGHT = 'fields.see_bought_price';
const CUSTOMER_BALANCE = 'fields.see_customer_balances';
const COMPANY_BALANCE = 'fields.see_company_balances';

/**
 * Which keys of an audit row's `changes` belong to which field flag, by the kind of record the
 * row is about — the same rules the per-record History tabs apply through `@SensitiveFields`
 * (purchases, materials, orders, damages, customers, companies).
 *
 * They are per kind rather than one list because the same name means different things on
 * different records: `unit_price` on a purchase is a **bought** price and on an order a sale
 * price anyone with the order may read; `balance` on a customer row needs the customer flag and
 * on a company row the company one. The History page and "My activity" read every kind at once,
 * and without these rules they answered what the per-record tabs withhold (security review,
 * finding 7).
 */
const RULES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  purchase: { cost: BOUGHT, unit_price: BOUGHT, line_total: BOUGHT, purchase_total: BOUGHT },
  item: { cost: BOUGHT, bought: BOUGHT, unit_cost_iqd: BOUGHT, unit_cost_usd_cents: BOUGHT },
  damage: { cost: BOUGHT, est_value: BOUGHT },
  order: { cost: BOUGHT, balance: CUSTOMER_BALANCE },
  customer: { cost: BOUGHT, balance: CUSTOMER_BALANCE },
  company: { cost: BOUGHT, balance: COMPANY_BALANCE },
  // An expense is read on the accountant page, which needs `accounts.view`.
  expense: { amount: 'accounts.view' },
};
const DEFAULT_RULES: Readonly<Record<string, string>> = { cost: BOUGHT };

interface Strippable {
  entity_type: string;
  changes: Record<string, unknown>;
  rows?: Strippable[];
}

/** The same entries with every key the caller may not read removed, however deeply nested. */
export function stripHistory<T extends Strippable>(context: RequestContext, entries: T[]): T[] {
  if (context.role === 'admin') return entries;
  const hidden = (entityType: string): Set<string> =>
    new Set(
      Object.entries(RULES[entityType] ?? DEFAULT_RULES)
        .filter(([, flag]) => !context.permissions.has(flag))
        .map(([field]) => field),
    );
  const stripEntry = <E extends Strippable>(entry: E): E => {
    const fields = hidden(entry.entity_type);
    if (fields.size === 0) return entry;
    return {
      ...entry,
      changes: strip(entry.changes, fields) as Record<string, unknown>,
      ...(entry.rows ? { rows: entry.rows.map(stripEntry) } : {}),
    };
  };
  return entries.map(stripEntry);
}

function strip(value: unknown, fields: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => strip(item, fields));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (fields.has(key)) continue;
      out[key] = strip(nested, fields);
    }
    return out;
  }
  return value;
}

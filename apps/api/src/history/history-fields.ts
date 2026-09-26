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
  // `payable` is the supplier side of a business re-based with its settlement currency (D-054).
  customer: { cost: BOUGHT, balance: CUSTOMER_BALANCE, payable: COMPANY_BALANCE },
  company: { cost: BOUGHT, balance: COMPANY_BALANCE },
  // An expense is read on the accountant page, which needs `accounts.view`.
  expense: { amount: 'accounts.view' },
};
const DEFAULT_RULES: Readonly<Record<string, string>> = { cost: BOUGHT };

/** The flag that opens each ledger, whose rows are filed under its owner's kind of record. */
const LEDGER_FLAG: Readonly<Record<string, string>> = {
  customer: CUSTOMER_BALANCE,
  company: COMPANY_BALANCE,
};

/** What a ledger row's History entry says about money: its amount, and the balance around it. */
const LEDGER_AMOUNTS = ['amount_iqd', 'amount_usd_cents', 'balance'] as const;

/**
 * The flags a ledger row's amount needs (security review follow-up, finding 3). A row written
 * to a customer's or a company's ledger carries `changes.entry` with its amount and
 * `changes.balance` before and after, and History read them to anyone with `history.view_all`.
 *
 *  · Every ledger amount needs the flag of that ledger — the Ledger tab asks for the same one.
 *  · An amount that *is* a bought figure needs `fields.see_bought_price` as well: a purchase on a
 *    company's account is the purchase total, and a damage charged to a business is what the
 *    stock cost us (D-062) — so is its reversal, and the payment or credit that settles it.
 *    Read from the row itself: its entry type, and the purchase or damage it names.
 */
function ledgerFlags(entry: Strippable): string[] {
  const flag = LEDGER_FLAG[entry.entity_type];
  const ledgerEntry = entry.changes.entry as { type?: unknown } | undefined;
  if (!flag || !ledgerEntry || typeof ledgerEntry !== 'object') return [];
  const related = entry.related ?? {};
  const bought =
    Boolean(related.damage_id) ||
    ledgerEntry.type === 'purchase' ||
    (ledgerEntry.type === 'reversal' && Boolean(related.purchase_id));
  return bought ? [flag, BOUGHT] : [flag];
}

interface Strippable {
  entity_type: string;
  changes: Record<string, unknown>;
  related?: Record<string, string | null> | null;
  rows?: Strippable[];
}

export interface StripOptions {
  /**
   * Leave the amounts of ledger rows that name this order: on an order's own History tab the
   * payments against it are part of the order, which shows them anyway (`ledger_entries`,
   * paid and remaining) to anyone who may open it.
   */
  ownOrderId?: string;
}

/** The same entries with every key the caller may not read removed, however deeply nested. */
export function stripHistory<T extends Strippable>(
  context: RequestContext,
  entries: T[],
  options: StripOptions = {},
): T[] {
  if (context.role === 'admin') return entries;
  const lacks = (flag: string) => !context.permissions.has(flag);
  const hidden = (entry: Strippable): Set<string> => {
    const fields = new Set(
      Object.entries(RULES[entry.entity_type] ?? DEFAULT_RULES)
        .filter(([, flag]) => lacks(flag))
        .map(([field]) => field),
    );
    const ownOrder =
      options.ownOrderId !== undefined && entry.related?.order_id === options.ownOrderId;
    const needed = ledgerFlags(entry).filter((flag) => !(ownOrder && flag !== BOUGHT));
    if (needed.some(lacks)) for (const field of LEDGER_AMOUNTS) fields.add(field);
    return fields;
  };
  const stripEntry = <E extends Strippable>(entry: E): E => {
    const fields = hidden(entry);
    const rows = entry.rows?.map(stripEntry);
    if (fields.size === 0) return rows ? { ...entry, rows } : entry;
    return {
      ...entry,
      changes: strip(entry.changes, fields) as Record<string, unknown>,
      ...(rows ? { rows } : {}),
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

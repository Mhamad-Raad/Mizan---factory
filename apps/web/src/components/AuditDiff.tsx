import { useTranslation } from 'react-i18next';
import { Icon } from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { DualAmount } from './DualAmount.js';
import { useFormatter } from '../lib/store.js';

/**
 * One audit row's field diff, in the reader's language (FR-902: "the field diff in the user's
 * language — field labels translated, values formatted per locale, amounts in both
 * currencies").
 *
 * The values in `changes` are whatever the write path recorded, so this renderer recognises the
 * shapes the API actually writes — a money pair, a balance before/after, a list of line
 * summaries — and falls back to the value as text for anything else. The fallback is
 * deliberate: a field added by a later iteration must show up as itself rather than break the
 * page, which is the whole point of storing the diff as JSON (2.4.4).
 *
 * "Was → now" is drawn with the registry's own arrow rather than a `→` character, because a
 * character does not mirror: in Kurdish and Arabic the row lays out right to left, so a literal
 * arrow ended up pointing back at the **old** value (spec 2.10.6 point 2). The two values also
 * carry their labels for a screen reader, which otherwise heard two bare numbers in a row.
 */

/** The old → new arrow: mirrored in RTL by the registry, and never read aloud on its own. */
function Became() {
  return <Icon name="next" size={16} />;
}

interface MoneyPair {
  iqd?: number;
  usd_cents?: number;
  amount_iqd?: number;
  amount_usd_cents?: number;
}

function moneyOf(value: unknown): { iqd: number; usd: number } | null {
  if (!value || typeof value !== 'object') return null;
  const pair = value as MoneyPair;
  const iqd = pair.iqd ?? pair.amount_iqd;
  const usd = pair.usd_cents ?? pair.amount_usd_cents;
  if (typeof iqd !== 'number' || typeof usd !== 'number') return null;
  return { iqd, usd };
}

/** `{ amount, currency }` — what an adjustment or a re-basing records. */
function amountOf(value: unknown): { amount: number; currency: Currency } | null {
  if (!value || typeof value !== 'object') return null;
  const shape = value as { amount?: number; currency?: Currency };
  if (typeof shape.amount !== 'number' || !shape.currency) return null;
  return { amount: shape.amount, currency: shape.currency };
}

export function AuditValue({ value }: { value: unknown }) {
  const { t } = useTranslation();
  const formatter = useFormatter();

  if (value === null || value === undefined) return <span className="mz-caption">—</span>;

  const money = moneyOf(value);
  if (money) return <DualAmount amount_iqd={money.iqd} amount_usd_cents={money.usd} />;

  const amount = amountOf(value);
  if (amount) return <span data-tabular>{formatter.money(amount.amount, amount.currency)}</span>;

  if (typeof value === 'boolean') return <span>{value ? t('common:yes') : t('common:no')}</span>;
  if (typeof value === 'number') return <span data-tabular>{formatter.number(value)}</span>;

  if (typeof value === 'string') {
    // A business date formats as one; everything else is the text as recorded.
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return <span>{formatter.date(value)}</span>;
    /*
     * An identifier is a reference, not a reading: thirty-six characters of UUID took over the
     * column on the employee's Activity tab. The first eight are enough to tell two apart, and
     * the whole thing is on the element for whoever needs to quote it.
     */
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      return (
        <span title={value} data-tabular dir="ltr">
          {value.slice(0, 8)}…
        </span>
      );
    }
    return <span>{value}</span>;
  }

  if (Array.isArray(value)) {
    return (
      <span className="mz-caption">
        {value
          .map((entry) => {
            const line = entry as { item?: string; qty_kg?: string | null; qty_count?: number | null };
            if (line && typeof line === 'object' && 'item' in line) {
              const quantity = line.qty_kg ?? (line.qty_count === null ? null : String(line.qty_count));
              return [line.item, quantity].filter(Boolean).join(' · ');
            }
            return JSON.stringify(entry);
          })
          .join(' / ')}
      </span>
    );
  }

  // A nested object with a before/after of its own (the ledger's balance change).
  const nested = value as { before?: unknown; after?: unknown };
  if (nested && (('before' in nested) || ('after' in nested))) {
    return (
      <span className="mz-row" style={{ gap: 'var(--space-2)' }}>
        <span className="mz-visually-hidden">{t('history:old_value')}</span>
        <AuditValue value={nested.before} />
        <Became />
        <span className="mz-visually-hidden">{t('history:new_value')}</span>
        <AuditValue value={nested.after} />
      </span>
    );
  }

  return <span className="mz-caption">{JSON.stringify(value)}</span>;
}

export function AuditDiff({ changes, note }: { changes: Record<string, unknown>; note?: string | null }) {
  const { t } = useTranslation();

  return (
    <div className="mz-stack" style={{ gap: 'var(--space-2)' }}>
      {Object.entries(changes).map(([field, change]) => {
        const pair = change as { old?: unknown; new?: unknown };
        const isPair = pair && typeof pair === 'object' && ('old' in pair || 'new' in pair);
        // An unknown field shows its own name: the diff is data, and the page must not need a
        // translation to render a field somebody added last week.
        const label = t(`history:field.${field}`, { defaultValue: field });

        return (
          <div key={field} className="mz-row mz-row--between" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <span className="mz-caption">{label}</span>
            {isPair ? (
              <span className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <span className="mz-visually-hidden">{t('history:old_value')}</span>
                <AuditValue value={pair.old} />
                <Became />
                <span className="mz-visually-hidden">{t('history:new_value')}</span>
                <AuditValue value={pair.new} />
              </span>
            ) : (
              <AuditValue value={change} />
            )}
          </div>
        );
      })}
      {note ? (
        <p className="mz-caption">
          {t('common:note')}: {note}
        </p>
      ) : null}
    </div>
  );
}

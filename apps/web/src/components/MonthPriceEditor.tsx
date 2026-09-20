import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BottomSheet, Button, TextField } from '@mizan/ui';
import type { Rate } from '@mizan/money';
import { MoneyInput } from './MoneyInput.js';
import type { MoneyValue } from './MoneyInput.js';
import { usePermission } from '../lib/store.js';

export interface MonthPriceEditorProps {
  open: boolean;
  onClose: () => void;
  month: string;
  monthLabel: string;
  rate: Rate;
  /** The pair already stored for this month, so the sheet opens on what is there. */
  initial?: {
    sale?: { amount_iqd: number; amount_usd_cents: number; entered_currency: 'IQD' | 'USD' } | null;
    bought?: { amount_iqd: number; amount_usd_cents: number; entered_currency: 'IQD' | 'USD' } | null;
    note?: string | null;
    version?: number | null;
  };
  saving?: boolean;
  error?: string;
  onSave: (input: {
    sale?: MoneyValue | null;
    bought?: MoneyValue | null;
    note?: string | null;
    version?: number | null;
  }) => void;
}

/**
 * "Set this month's prices" (FR-305, component of 2.10.11): one bought and one sale price,
 * each typed in one currency with the other filled at the global rate and overridable. The
 * bought price is absent for a user without `fields.see_bought_price` — the interface hides
 * what the API already refuses to send.
 */
export function MonthPriceEditor({
  open,
  onClose,
  month,
  monthLabel,
  rate,
  initial,
  saving,
  error,
  onSave,
}: MonthPriceEditorProps) {
  const { t } = useTranslation();
  const maySeeBought = usePermission('fields.see_bought_price');

  const [sale, setSale] = useState<MoneyValue>(toValue(initial?.sale));
  const [bought, setBought] = useState<MoneyValue>(toValue(initial?.bought));
  const [note, setNote] = useState(initial?.note ?? '');

  return (
    <BottomSheet
      title={t('materials:set_prices_for', { month: monthLabel })}
      open={open}
      onClose={onClose}
      closeLabel={t('common:close')}
    >
      <div className="mz-stack">
        <MoneyInput label={t('glossary:sale_price')} value={sale} rate={rate} onChange={setSale} error={error} />
        {maySeeBought ? (
          <MoneyInput label={t('glossary:bought_price')} value={bought} rate={rate} onChange={setBought} />
        ) : null}
        <TextField
          label={t('common:note')}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={2000}
        />
        {/* Editing a past month never moves a line that was already sold: those keep their
            own snapshots, and only new lines and the stock-value reports change (FR-305). */}
        <p className="mz-caption">{t('materials:past_month_warning')}</p>
        <Button
          block
          loading={saving}
          disabled={sale.amount === null && bought.amount === null}
          onClick={() =>
            onSave({
              sale: sale.amount === null ? null : sale,
              bought: maySeeBought && bought.amount !== null ? bought : null,
              note: note.trim() === '' ? null : note.trim(),
              version: initial?.version ?? null,
            })
          }
        >
          {t('common:save')}
        </Button>
        <span className="mz-caption">{month}</span>
      </div>
    </BottomSheet>
  );
}

function toValue(
  pair?: { amount_iqd: number; amount_usd_cents: number; entered_currency: 'IQD' | 'USD' } | null,
): MoneyValue {
  if (!pair) return { amount: null, currency: 'IQD', other_amount: null };
  return {
    amount: pair.entered_currency === 'IQD' ? pair.amount_iqd : pair.amount_usd_cents,
    currency: pair.entered_currency,
    other_amount: null,
  };
}

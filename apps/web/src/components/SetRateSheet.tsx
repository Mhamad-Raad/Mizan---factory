import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BottomSheet, Button, NumberField, TextField } from '@mizan/ui';

/**
 * Set a counterparty's own IQD-per-USD rate (a company's or a customer's). Append-only on the
 * server — a new rate never edits an old one — so this only ever adds the next rate.
 */
export function SetRateSheet({
  title,
  label,
  hint,
  current,
  saving,
  onClose,
  onSave,
}: {
  title: string;
  label: string;
  hint?: string;
  /** The counterparty's own current rate to prefill, or null when they have none yet. */
  current: string | null;
  saving: boolean;
  onClose: () => void;
  onSave: (body: { rate_iqd_per_usd: string; note: string | null }) => void;
}) {
  const { t } = useTranslation();
  const [rate, setRate] = useState(current ?? '');
  const [note, setNote] = useState('');

  return (
    <BottomSheet title={title} open onClose={onClose} closeLabel={t('common:close')}>
      <div className="mz-stack">
        <NumberField
          label={label}
          decimals={4}
          value={rate}
          onChange={(event) => setRate(event.target.value)}
        />
        {hint ? <p className="mz-caption">{hint}</p> : null}
        <TextField
          label={t('common:note')}
          hint={t('common:optional')}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <Button
          block
          loading={saving}
          disabled={rate.trim() === ''}
          onClick={() =>
            onSave({
              rate_iqd_per_usd: rate.trim(),
              note: note.trim() === '' ? null : note.trim(),
            })
          }
        >
          {t('common:save')}
        </Button>
      </div>
    </BottomSheet>
  );
}

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BottomSheet, Button, NumberField, TextAreaField, TextField } from '@mizan/ui';
import { ApiError, apiRequest } from '../lib/api.js';
import { useIdempotencyKey } from '../lib/idempotency.js';
import { errorMessage } from '../lib/errors.js';
import { invalidateHistory } from '../lib/invalidate.js';

/** What the sheet edits of a material: its own details, never its stock, prices or unit. */
export interface EditableMaterial {
  id: string;
  name: string;
  code: string | null;
  notes: string | null;
  min_stock_count?: number | null;
  min_stock_kg?: string | null;
  version: number;
}

/**
 * A material's own details — name, code, low-stock level, notes — changed from its page. Prices
 * are the Monthly prices tab's, what a buy cost is the purchase's, and the unit stays what it was
 * bought in (D-062), so none of those are here. A blank code, level or note clears it.
 */
export function EditMaterialSheet({
  material,
  measure,
  onClose,
  onSaved,
}: {
  material: EditableMaterial;
  /** The measure the material is stocked in: the low-stock level is in the same. */
  measure: 'count' | 'kg';
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(material.name);
  const [code, setCode] = useState(material.code ?? '');
  const [notes, setNotes] = useState(material.notes ?? '');
  const [minStock, setMinStock] = useState(
    measure === 'kg' ? (material.min_stock_kg ?? '') : material.min_stock_count == null ? '' : String(material.min_stock_count),
  );
  const saveKey = useIdempotencyKey();

  const save = useMutation({
    mutationFn: () => {
      const level = minStock.trim();
      return apiRequest(`/items/${material.id}`, {
        method: 'PATCH',
        idempotencyKey: saveKey.key,
        body: {
          version: material.version,
          name: name.trim(),
          code: code.trim() === '' ? null : code.trim(),
          notes: notes.trim() === '' ? null : notes.trim(),
          ...(measure === 'kg'
            ? { min_stock_kg: level === '' ? null : level }
            : { min_stock_count: level === '' ? null : Number(level) }),
        },
      });
    },
    onSuccess: async () => {
      saveKey.renew();
      await queryClient.invalidateQueries({ queryKey: ['items'] });
      await queryClient.invalidateQueries({ queryKey: ['/items'] });
      await invalidateHistory(queryClient);
      onSaved();
    },
  });

  const duplicate = save.error instanceof ApiError ? save.error.fieldError('name') : undefined;
  const otherError = duplicate ? null : errorMessage(t, save.error);
  const ready = name.trim() !== '' && !save.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) save.mutate();
  };

  return (
    <BottomSheet title={t('materials:edit_material')} open onClose={onClose} closeLabel={t('common:close')}>
      <form className="mz-stack" onSubmit={submit} noValidate>
        <div className="mz-form-grid">
          <TextField
            label={t('materials:name')}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              save.reset();
            }}
            maxLength={200}
            error={duplicate ? t('errors:duplicate_material', { name: String(duplicate.params?.name ?? name) }) : undefined}
          />
          <TextField
            label={t('materials:code')}
            hint={t('common:optional')}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            maxLength={40}
          />
          <NumberField
            label={t('materials:min_stock')}
            hint={t('materials:min_stock_hint')}
            unit={measure === 'kg' ? t('common:kg_symbol') : t('common:count_symbol')}
            decimals={measure === 'kg' ? 3 : 0}
            value={minStock}
            onChange={(event) => setMinStock(event.target.value)}
          />
          <div className="mz-form-grid__wide">
            <TextAreaField
              label={t('glossary:notes')}
              hint={t('common:optional')}
              value={notes}
              maxLength={2000}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
        </div>
        <p className="mz-caption">{t('materials:edit_material_prices_hint')}</p>
        {otherError ? (
          <p className="mz-warning" role="alert">
            {otherError}
          </p>
        ) : null}
        <Button type="submit" variant="primary" block loading={save.isPending} disabled={!ready}>
          {t('common:save')}
        </Button>
      </form>
    </BottomSheet>
  );
}

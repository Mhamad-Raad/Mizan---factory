import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, NumberField, SegmentedControl, TextField } from '@mizan/ui';
import { ApiError, apiRequest, newIdempotencyKey } from '../lib/api.js';
import { AppShell } from '../components/AppShell.js';

/**
 * "New material" (FR-301, FR-302): a name and the pricing unit are all that is required, so a
 * material can be created mid-order without leaving the floor. The optional code and low-stock
 * threshold are Proposed — not requested (FR-310).
 */
export function NewMaterialPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [pricingUnit, setPricingUnit] = useState<'per_kg' | 'per_piece'>('per_kg');
  const [code, setCode] = useState('');
  const [minStock, setMinStock] = useState('');
  const [notes, setNotes] = useState('');
  const [idempotencyKey] = useState(newIdempotencyKey);

  const create = useMutation({
    mutationFn: () =>
      apiRequest<{ id: string }>('/items', {
        method: 'POST',
        idempotencyKey,
        body: {
          name: name.trim(),
          pricing_unit: pricingUnit,
          code: code.trim() === '' ? null : code.trim(),
          min_stock_count: pricingUnit === 'per_piece' && minStock.trim() !== '' ? Math.round(Number(minStock)) : null,
          min_stock_kg: pricingUnit === 'per_kg' && minStock.trim() !== '' ? minStock.trim() : null,
          notes: notes.trim() === '' ? null : notes.trim(),
        },
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['items'] });
      navigate(`/materials/${created.id}`, { replace: true });
    },
  });

  const duplicate =
    create.error instanceof ApiError ? create.error.fieldError('name') : undefined;

  return (
    <AppShell title={t('materials:new_material')}>
      <div className="mz-stack">
        <TextField
          label={t('materials:name')}
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
          maxLength={200}
          error={
            duplicate
              ? t('errors:duplicate_material', { name: String(duplicate.params?.name ?? name) })
              : undefined
          }
        />

        <SegmentedControl
          label={t('materials:pricing_unit')}
          value={pricingUnit}
          onChange={setPricingUnit}
          options={[
            { value: 'per_kg', label: t('glossary:per_kg') },
            { value: 'per_piece', label: t('glossary:per_piece') },
          ]}
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
          decimals={pricingUnit === 'per_kg' ? 3 : 0}
          unit={pricingUnit === 'per_kg' ? t('common:kg_symbol') : undefined}
          value={minStock}
          onChange={(event) => setMinStock(event.target.value)}
        />

        <TextField
          label={t('glossary:notes')}
          hint={t('common:optional')}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          maxLength={2000}
        />

        <Button block loading={create.isPending} disabled={name.trim() === ''} onClick={() => create.mutate()}>
          {t('common:save')}
        </Button>
        <Button variant="ghost" onClick={() => navigate('/materials')}>
          {t('glossary:cancel')}
        </Button>
      </div>
    </AppShell>
  );
}

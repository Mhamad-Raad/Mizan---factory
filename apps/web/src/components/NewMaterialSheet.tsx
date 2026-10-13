import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BottomSheet, Button, TextField } from '@mizan/ui';
import { ApiError, apiRequest } from '../lib/api.js';
import { useIdempotencyKey } from '../lib/idempotency.js';
import { errorMessage } from '../lib/errors.js';
import type { ItemRow } from '../pages/MaterialsPage.js';

/**
 * A material named on the spot, from a purchase's material picker (D-090): its name and, if it has
 * one, its code — nothing else, because it is being bought right now. It goes straight onto the
 * purchase as a new line, and the purchase is what says which company it was bought from, what it
 * cost and how many came in; a material is never one company's alone (spec 1.1).
 */
export function NewMaterialSheet({
  initialName,
  companyName,
  onClose,
  onCreated,
}: {
  /** What was typed into the picker's search, so it is not typed twice. */
  initialName: string;
  /** The company the purchase is from, when one is chosen. */
  companyName: string | null;
  onClose: () => void;
  onCreated: (item: ItemRow) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(initialName);
  const [code, setCode] = useState('');
  const createKey = useIdempotencyKey();

  const create = useMutation({
    mutationFn: () =>
      apiRequest<ItemRow>('/items', {
        method: 'POST',
        idempotencyKey: createKey.key,
        // `per_piece` stays the model until the count-only migration, as on the New material page.
        body: { name: name.trim(), pricing_unit: 'per_piece', code: code.trim() === '' ? null : code.trim(), buy: null },
      }),
    onSuccess: async (item) => {
      await queryClient.invalidateQueries({ queryKey: ['items'] });
      await queryClient.invalidateQueries({ queryKey: ['/items'] });
      onCreated(item);
    },
  });

  const duplicate = create.error instanceof ApiError ? create.error.fieldError('name') : undefined;
  const otherError = duplicate ? null : errorMessage(t, create.error);
  const ready = name.trim() !== '' && !create.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) create.mutate();
  };

  return (
    <BottomSheet title={t('materials:new_material')} open onClose={onClose} closeLabel={t('common:close')}>
      <form className="mz-stack" onSubmit={submit} noValidate>
        <p className="mz-muted">
          {companyName ? (
            t('purchases:new_material_from', { name: `⁨${companyName}⁩` })
          ) : (
            t('purchases:new_material_hint')
          )}
        </p>
        <TextField
          label={t('materials:name')}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            create.reset();
          }}
          autoFocus
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
        {otherError ? (
          <p className="mz-warning" role="alert">
            {otherError}
          </p>
        ) : null}
        <Button type="submit" variant="primary" block icon="plus" disabled={!ready}>
          {t('purchases:add_to_purchase')}
        </Button>
      </form>
    </BottomSheet>
  );
}

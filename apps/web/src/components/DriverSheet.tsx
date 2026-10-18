import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BottomSheet, Button, TextAreaField, TextField } from '@mizan/ui';
import { ApiError, apiRequest } from '../lib/api.js';
import { useIdempotencyKey } from '../lib/idempotency.js';
import { invalidateHistory } from '../lib/invalidate.js';
import { errorMessage } from '../lib/errors.js';
import type { DriverRow } from '../lib/drivers.js';

/**
 * A driver, new or edited (D-105): the name, the phone and the car number, and a note. Opened from
 * the Drivers page, a driver's own page, and the order form's driver picker — which hands over what
 * was typed into its search, so the name is not typed twice.
 *
 * A phone another driver already has is a warning, as in the Pallet system: the sheet names who
 * has it and offers to save anyway or — from an order — to choose that driver instead.
 */
export function DriverSheet({
  driver,
  initialName = '',
  onClose,
  onSaved,
  onUseExisting,
}: {
  /** The driver being edited; absent for a new one. */
  driver?: DriverRow;
  initialName?: string;
  onClose: () => void;
  onSaved: (driver: DriverRow) => void;
  /** Offered beside the duplicate-phone warning: take the driver who already has the number. */
  onUseExisting?: (driver: { id: string; name: string }) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(driver?.name ?? initialName);
  const [phone, setPhone] = useState(driver?.phone ?? '');
  const [carNumber, setCarNumber] = useState(driver?.car_number ?? '');
  const [notes, setNotes] = useState(driver?.notes ?? '');
  const saveKey = useIdempotencyKey(`driver:${driver?.id ?? 'new'}`);

  const save = useMutation({
    mutationFn: (confirmDuplicatePhone: boolean) => {
      const body = {
        name: name.trim(),
        phone: phone.trim() === '' ? null : phone.trim(),
        car_number: carNumber.trim() === '' ? null : carNumber.trim(),
        notes: notes.trim() === '' ? null : notes.trim(),
        ...(confirmDuplicatePhone ? { confirm_duplicate_phone: true } : {}),
      };
      return driver
        ? apiRequest<DriverRow>(`/drivers/${driver.id}`, {
            method: 'PATCH',
            body: { ...body, version: driver.version },
            idempotencyKey: saveKey.key,
          })
        : apiRequest<DriverRow>('/drivers', { method: 'POST', body, idempotencyKey: saveKey.key });
    },
    onSuccess: async (saved) => {
      saveKey.renew();
      await queryClient.invalidateQueries({ queryKey: ['drivers'] });
      await queryClient.invalidateQueries({ queryKey: ['/drivers'] });
      await invalidateHistory(queryClient);
      onSaved(saved);
    },
  });

  const phoneError = save.error instanceof ApiError ? save.error.fieldError('phone') : undefined;
  const duplicates =
    phoneError?.code === 'DUPLICATE_PHONE'
      ? ((phoneError.params?.drivers as { id: string; name: string }[] | undefined) ?? [])
      : [];
  const otherError = duplicates.length > 0 ? null : errorMessage(t, save.error);
  const ready = name.trim() !== '' && !save.isPending;
  // Any change to what is typed forgets the last answer, so the warning is about this phone.
  const edit = (set: (value: string) => void, value: string) => {
    save.reset();
    set(value);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) save.mutate(false);
  };

  return (
    <BottomSheet
      title={driver ? t('drivers:edit_driver') : t('drivers:new_driver')}
      open
      onClose={onClose}
      closeLabel={t('common:close')}
      wide
    >
      <form className="mz-form-grid" onSubmit={submit} noValidate>
        <div className="mz-form-grid__wide">
          <TextField
            label={t('drivers:name')}
            value={name}
            autoFocus
            maxLength={200}
            onChange={(event) => edit(setName, event.target.value)}
          />
        </div>
        <TextField
          label={t('drivers:phone')}
          hint={t('common:optional')}
          type="tel"
          inputMode="tel"
          maxLength={40}
          value={phone}
          onChange={(event) => edit(setPhone, event.target.value)}
        />
        <TextField
          label={t('drivers:car_number')}
          hint={t('common:optional')}
          // A plate is mostly Latin and digits: it reads in its own direction, not the page's.
          dir="auto"
          maxLength={50}
          value={carNumber}
          onChange={(event) => edit(setCarNumber, event.target.value)}
        />
        <div className="mz-form-grid__wide">
          <TextAreaField
            label={t('glossary:notes')}
            hint={t('common:optional')}
            maxLength={2000}
            value={notes}
            onChange={(event) => edit(setNotes, event.target.value)}
          />
        </div>

        {duplicates.length > 0 ? (
          <div className="mz-warning mz-form-grid__wide" role="alert">
            <div className="mz-stack" style={{ gap: 'var(--space-2)' }}>
              <strong>{t('drivers:duplicate_title')}</strong>
              <span>
                {t('drivers:duplicate_body')}{' '}
                {duplicates.map((other, index) => (
                  <span key={other.id}>
                    {index > 0 ? ' · ' : ''}
                    <bdi>{other.name}</bdi>
                  </span>
                ))}
              </span>
              <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <Button
                  type="button"
                  variant="secondary"
                  loading={save.isPending}
                  onClick={() => save.mutate(true)}
                >
                  {t('drivers:save_anyway')}
                </Button>
                {onUseExisting && duplicates[0] ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => onUseExisting(duplicates[0] as { id: string; name: string })}
                  >
                    {t('drivers:use_existing', { name: `⁨${duplicates[0].name}⁩` })}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
        {otherError ? (
          <p className="mz-field__error mz-form-grid__wide" role="alert">
            {otherError}
          </p>
        ) : null}

        <div className="mz-form-grid__wide">
          <Button
            type="submit"
            block
            loading={save.isPending && duplicates.length === 0}
            disabled={!ready || duplicates.length > 0}
          >
            {driver ? t('common:save') : t('drivers:new_driver')}
          </Button>
        </div>
      </form>
    </BottomSheet>
  );
}

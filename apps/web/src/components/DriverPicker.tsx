import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { driverCaption } from '../lib/drivers.js';
import type { DriverRow } from '../lib/drivers.js';
import { usePermission } from '../lib/store.js';
import { DriverSheet } from './DriverSheet.js';
import { PickerSheet } from './PickerSheet.js';

export interface PickedDriver {
  id: string;
  name: string;
}

/**
 * Choosing a driver (D-105, D-106): the active drivers, searched by name, phone or plate, with
 * "New driver" at the foot for whoever may add one — what was typed becomes the new driver's name,
 * and a phone another driver has offers that driver instead. `onClear`, when given, adds "Remove"
 * above the search, for a document that already has a driver.
 */
export function DriverPickerSheet({
  onClose,
  onPicked,
  onClear,
}: {
  onClose: () => void;
  onPicked: (driver: PickedDriver) => void;
  onClear?: () => void;
}) {
  const { t } = useTranslation();
  const mayCreate = usePermission('drivers.create');
  const [naming, setNaming] = useState<string | null>(null);

  if (naming !== null) {
    return (
      <DriverSheet
        initialName={naming}
        onClose={onClose}
        onSaved={onPicked}
        onUseExisting={onPicked}
      />
    );
  }

  return (
    <PickerSheet
      title={t('orders:choose_driver')}
      open
      onClose={onClose}
      path="/drivers"
      icon="drivers"
      searchLabel={t('drivers:search_placeholder')}
      emptyTitle={t('drivers:empty')}
      header={
        onClear ? (
          <Button
            variant="secondary"
            icon="close"
            onClick={onClear}
            style={{ alignSelf: 'flex-start' }}
          >
            {t('orders:remove_driver')}
          </Button>
        ) : undefined
      }
      toItem={(row: never) => {
        const driver = row as unknown as DriverRow;
        return { id: driver.id, title: driver.name, subtitle: driverCaption(driver) };
      }}
      onPick={(id, row) => onPicked({ id, name: (row as unknown as DriverRow).name })}
      footer={
        mayCreate
          ? (typed) => (
              <Button variant="secondary" icon="plus" block onClick={() => setNaming(typed)}>
                {t('drivers:new_driver')}
              </Button>
            )
          : undefined
      }
    />
  );
}

/**
 * The Driver field of the order and purchase forms (D-105, D-106): a button showing who is chosen,
 * "Remove" beside it, and a line under it saying what a driver is for here. A driver handed in by
 * id alone — a new sale opened from a driver's page — is named from the API.
 */
export function DriverField({
  driverId,
  driverName,
  hint,
  onChange,
}: {
  driverId: string | null;
  driverName: string | null;
  hint: string;
  onChange: (driver: PickedDriver | null) => void;
}) {
  const { t } = useTranslation();
  const mayPick = usePermission('drivers.view');
  const [picking, setPicking] = useState(false);
  const linked = useQuery({
    queryKey: ['drivers', driverId],
    queryFn: () => apiRequest<DriverRow>(`/drivers/${driverId}`),
    enabled: Boolean(driverId) && driverName === null && mayPick,
  });
  const label = driverName ?? linked.data?.name ?? null;

  // Whoever may not read the drivers still sees the one a document already has.
  if (!mayPick && !driverId) return null;

  return (
    <div className="mz-field">
      <span className="mz-field__label">{t('glossary:driver')}</span>
      <span className="mz-filter-panel__company">
        <Button
          variant="secondary"
          icon="drivers"
          disabled={!mayPick}
          onClick={() => setPicking(true)}
        >
          <bdi>{driverId ? (label ?? '…') : t('orders:choose_driver')}</bdi>
        </Button>
        {driverId ? (
          <Button variant="ghost" onClick={() => onChange(null)}>
            {t('orders:remove_driver')}
          </Button>
        ) : null}
      </span>
      <span className="mz-field__hint">{hint}</span>
      {picking ? (
        <DriverPickerSheet
          onClose={() => setPicking(false)}
          onPicked={(driver) => {
            setPicking(false);
            onChange(driver);
          }}
        />
      ) : null}
    </div>
  );
}

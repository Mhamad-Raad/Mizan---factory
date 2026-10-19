import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Icon } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { useIdempotencyKey } from '../lib/idempotency.js';
import { errorMessage } from '../lib/errors.js';
import { invalidateHistory } from '../lib/invalidate.js';
import { usePermission } from '../lib/store.js';
import { DriverPickerSheet } from './DriverPicker.js';
import type { PickedDriver } from './DriverPicker.js';

/**
 * The driver line of an order's or a purchase's page (D-105, D-106): who takes it or brought it,
 * a way to the driver's page for whoever may open it, and — beside the name, for whoever may edit
 * the document — "Change", which sets the driver on its own without rewriting the document.
 */
export function DocumentDriver({
  kind,
  id,
  version,
  driverId,
  driverName,
  editable,
}: {
  kind: 'order' | 'purchase';
  id: string;
  version: number;
  driverId: string | null;
  driverName: string | null;
  /** The document is not void. */
  editable: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const maySeeDrivers = usePermission('drivers.view');
  const mayEdit = usePermission(kind === 'order' ? 'orders.edit' : 'purchases.edit');
  const mayChange = editable && mayEdit && maySeeDrivers;
  const [picking, setPicking] = useState(false);
  const key = useIdempotencyKey(`driver:${kind}:${id}`);

  const change = useMutation({
    mutationFn: (driver: PickedDriver | null) =>
      apiRequest(`/${kind === 'order' ? 'orders' : 'purchases'}/${id}/driver`, {
        method: 'PUT',
        body: { driver_id: driver?.id ?? null, version },
        idempotencyKey: key.key,
      }),
    onSuccess: async () => {
      key.renew();
      await queryClient.invalidateQueries({
        queryKey: [kind === 'order' ? 'orders' : 'purchases'],
      });
      await queryClient.invalidateQueries({ queryKey: ['trade'] });
      await queryClient.invalidateQueries({ queryKey: ['drivers'] });
      await invalidateHistory(queryClient);
    },
    // Someone else changed the document meanwhile, or the driver was just deactivated: the page
    // reloads it, so a second try carries the current version (review D-114).
    onError: () =>
      queryClient.invalidateQueries({ queryKey: [kind === 'order' ? 'orders' : 'purchases'] }),
  });
  // The sheet closes on a choice; the line shows the save and any refusal where it can be seen.
  const choose = (driver: PickedDriver | null) => {
    setPicking(false);
    change.mutate(driver);
  };
  const error = errorMessage(t, change.error);

  if (!driverId && !mayChange) return null;

  return (
    <>
      <span
        className="mz-caption"
        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}
      >
        <Icon name="drivers" size={14} />
        {t('glossary:driver')}:{' '}
        {driverId && driverName ? (
          maySeeDrivers ? (
            <Link to={`/drivers/${driverId}`} className="mz-quiet-link">
              <bdi>{driverName}</bdi>
            </Link>
          ) : (
            <bdi>{driverName}</bdi>
          )
        ) : (
          <span className="mz-muted">—</span>
        )}
        {mayChange ? (
          <button
            type="button"
            className="mz-link-button"
            style={{ marginInlineStart: 'var(--space-2)' }}
            disabled={change.isPending}
            aria-busy={change.isPending}
            onClick={() => {
              change.reset();
              setPicking(true);
            }}
          >
            {driverId ? t('orders:change_driver') : t('orders:choose_driver')}
          </button>
        ) : null}
      </span>
      {error ? (
        <span className="mz-field__error" role="alert">
          {error}
        </span>
      ) : null}
      {picking ? (
        <DriverPickerSheet
          onClose={() => setPicking(false)}
          onPicked={choose}
          onClear={driverId ? () => choose(null) : undefined}
        />
      ) : null}
    </>
  );
}

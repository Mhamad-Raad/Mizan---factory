import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, NumberField, TextField } from '@mizan/ui';
import { apiRequest, newIdempotencyKey } from '../lib/api.js';
import { errorMessage } from '../lib/errors.js';
import { usePageTitle } from '../lib/page-title.js';
import { useApp, useFormatter, usePermission } from '../lib/store.js';
import { AppearanceCards } from '../components/Appearance.js';
import { Pager } from '../components/Pager.js';
import { useKeepPageInRange, usePaging } from '../lib/paging.js';

/**
 * Settings (FR-1101 to FR-1107): how the app looks on this device, and the system's exchange
 * rate. The password moved to Me; the admin's "System" card was taken out at the client's request
 * (its values stay as they are on the server). Numbers always render in
 * Western digits (see store.ts formatterFor), so there is no per-device numerals choice.
 */
export function SettingsPage() {
  const { t } = useTranslation();
  const persisted = useApp((state) => state.preferencesPersisted);
  const user = useApp((state) => state.user);
  const maySetRate = usePermission('settings.set_global_rate');

  usePageTitle(t('settings:title'));

  return (
    <>
      <div className="mz-stack">
        {/* A browser that cannot keep preferences says so once, above everything they affect. */}
        {!persisted ? (
          <Card>
            <p className="mz-field__error" role="alert">
              {t('settings:storage_unavailable')}
            </p>
          </Card>
        ) : null}

        {/*
         * Language, theme and text size as pictures rather than words: the arrangement the
         * client asked to be copied from the item-management system (`Appearance.tsx`). Each
         * choice is per device (FR-1103), and the app bar offers the same three lists.
         */}
        <AppearanceCards />

        {/* A user who may set the rate sees that card even without the rest (spec 3.3). */}
        {user?.role === 'admin' || maySetRate ? <GlobalRateCard /> : null}
      </div>
    </>
  );
}


interface GlobalRate {
  current: { rate_iqd_per_usd: string; effective_from: string } | null;
  total: number;
  items: {
    id: string;
    rate_iqd_per_usd: string;
    effective_from: string;
    note: string | null;
    created_by_name: string | null;
  }[];
}

/**
 * The global default rate (FR-1106): the customer-side rate every order and payment is filled
 * with, its full history, and the prompt when it has not been touched for a few days. A user
 * who holds only `settings.set_global_rate` sees this card and nothing else of the system
 * settings (spec 3.3).
 */
function GlobalRateCard() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  // The rate's history is paged like every list (D-058); `['global-rate']` still invalidates it.
  const paging = usePaging({ storageKey: 'global-rates', prefix: 'rates_' });
  const rates = useQuery({
    queryKey: ['global-rate', 'history', paging.page, paging.pageSize],
    queryFn: () => apiRequest<GlobalRate>(`/settings/global-rates?${paging.query}`),
    placeholderData: keepPreviousData,
  });
  useKeepPageInRange(paging, rates);

  const save = useMutation({
    mutationFn: () =>
      apiRequest<GlobalRate['current']>('/settings/global-rates', {
        method: 'POST',
        body: {
          rate_iqd_per_usd: value.trim(),
          note: note.trim() === '' ? null : note.trim(),
        },
        idempotencyKey: newIdempotencyKey(),
      }),
    // A new attempt clears the last one's "Rate saved", so it never stands next to a refusal.
    onMutate: () => setMessage(null),
    onSuccess: async () => {
      setValue('');
      setNote('');
      setMessage(t('settings:rate_saved'));
      await queryClient.invalidateQueries({ queryKey: ['global-rate'] });
      // A company without its own rate is valued at this one.
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
  });
  const saveError = errorMessage(t, save.error);

  return (
    <Card>
      <div className="mz-stack">
        <h2 className="mz-heading">{t('glossary:global_default_rate')}</h2>

        {rates.data?.current ? (
          <p data-tabular>
            {formatter.rate(rates.data.current.rate_iqd_per_usd)}
            <span className="mz-caption" style={{ display: 'block' }}>
              {t('settings:rate_since', {
                time: formatter.timestamp(new Date(rates.data.current.effective_from)),
              })}
            </span>
          </p>
        ) : (
          <p className="mz-field__error">{t('settings:no_rate_yet')}</p>
        )}

        <NumberField
          label={t('settings:new_rate')}
          hint={t('settings:new_rate_hint')}
          decimals={4}
          value={value}
          error={saveError ?? undefined}
          onChange={(event) => setValue(event.target.value)}
        />
        <TextField
          label={t('common:note')}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />

        <Button
          block
          loading={save.isPending}
          disabled={value.trim() === ''}
          onClick={() => save.mutate()}
        >
          {t('settings:set_rate')}
        </Button>

        {(rates.data?.items ?? []).length > 0 ? (
          <ul className="mz-list">
            {(rates.data?.items ?? []).map((row) => (
              <li key={row.id} className="mz-list__item">
                <span className="mz-list__body">
                  <span className="mz-list__title" data-tabular>
                    {formatter.rate(row.rate_iqd_per_usd)}
                  </span>
                  <span className="mz-caption">
                    {formatter.timestamp(new Date(row.effective_from))}
                    {row.created_by_name ? ` · ${row.created_by_name}` : ''}
                    {row.note ? ` · ${row.note}` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <Pager
          page={paging.page}
          pageSize={paging.pageSize}
          total={rates.data?.total ?? 0}
          onPage={paging.setPage}
          onPageSize={paging.setPageSize}
        />

        {message ? <p className="mz-muted">{message}</p> : null}
      </div>
    </Card>
  );
}


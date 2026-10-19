import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, TextField } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { BUSINESS_QUERY_KEY, shrinkLogo } from '../lib/business.js';
import type { Business } from '../lib/business.js';
import { errorMessage } from '../lib/errors.js';
import { useIdempotencyKey } from '../lib/idempotency.js';
import { invalidateHistory } from '../lib/invalidate.js';
import { QueryStates } from './states.js';

/**
 * Settings → Receipt details (D-108), for the admin: the name, phone and address every receipt is
 * headed with, and the logo beside them — the Pallet system's factory details. The logo is made
 * receipt-sized in the browser before it is sent, so any photo or scan will do.
 */
export function BusinessCard() {
  const { t } = useTranslation();
  const business = useQuery({
    queryKey: BUSINESS_QUERY_KEY,
    queryFn: () => apiRequest<Business>('/settings/business'),
  });

  return (
    <Card>
      <div className="mz-stack">
        <div>
          <h2 className="mz-heading">{t('settings:business_title')}</h2>
          <p className="mz-muted">{t('settings:business_hint')}</p>
        </div>
        <QueryStates query={business} skeletonLines={4}>
          {business.data ? <BusinessForm initial={business.data} /> : null}
        </QueryStates>
      </div>
    </Card>
  );
}

function BusinessForm({ initial }: { initial: Business }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(initial.name ?? '');
  const [phone, setPhone] = useState(initial.phone ?? '');
  const [address, setAddress] = useState(initial.address ?? '');
  const [saved, setSaved] = useState(false);
  const [logoProblem, setLogoProblem] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const saveKey = useIdempotencyKey(`business:${name}:${phone}:${address}`);
  const logoKey = useIdempotencyKey();

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: BUSINESS_QUERY_KEY });
    await invalidateHistory(queryClient);
  };

  const save = useMutation({
    mutationFn: () =>
      apiRequest('/settings', {
        method: 'PATCH',
        idempotencyKey: saveKey.key,
        body: {
          business_name: name.trim() === '' ? null : name.trim(),
          business_phone: phone.trim() === '' ? null : phone.trim(),
          business_address: address.trim() === '' ? null : address.trim(),
        },
      }),
    onMutate: () => setSaved(false),
    onSuccess: async () => {
      saveKey.renew();
      setSaved(true);
      await refresh();
    },
  });

  const logo = useMutation({
    mutationFn: (dataUrl: string | null) =>
      apiRequest('/settings/business/logo', {
        method: dataUrl ? 'PUT' : 'DELETE',
        idempotencyKey: logoKey.key,
        body: dataUrl ? { data_url: dataUrl } : {},
      }),
    onSuccess: async () => {
      logoKey.renew();
      await refresh();
    },
  });

  const choose = async (picked: File | undefined) => {
    setLogoProblem(null);
    logo.reset();
    if (!picked) return;
    try {
      logo.mutate(await shrinkLogo(picked));
    } catch (problem) {
      setLogoProblem(
        problem instanceof Error && problem.message === 'too_large'
          ? t('settings:logo_too_large')
          : t('settings:logo_unreadable'),
      );
    } finally {
      // The same file chosen again must still fire a change.
      if (file.current) file.current.value = '';
    }
  };

  const edit = (set: (value: string) => void, value: string) => {
    setSaved(false);
    save.reset();
    set(value);
  };

  const logoError = logoProblem ?? errorMessage(t, logo.error);

  return (
    <div className="mz-form-grid">
      <div
        className="mz-form-grid__wide mz-row"
        style={{ gap: 'var(--space-4)', alignItems: 'center', flexWrap: 'wrap' }}
      >
        {initial.logo ? (
          <img
            src={initial.logo}
            alt={t('settings:logo')}
            style={{ maxBlockSize: '4.5rem', maxInlineSize: '9rem', objectFit: 'contain' }}
          />
        ) : (
          <span className="mz-muted">{t('settings:no_logo')}</span>
        )}
        <span className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Button
            variant="secondary"
            icon="plus"
            loading={logo.isPending}
            onClick={() => file.current?.click()}
          >
            {initial.logo ? t('settings:logo_change') : t('settings:logo_add')}
          </Button>
          {initial.logo ? (
            <Button variant="ghost" onClick={() => logo.mutate(null)} disabled={logo.isPending}>
              {t('settings:logo_remove')}
            </Button>
          ) : null}
        </span>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(event) => void choose(event.target.files?.[0])}
        />
      </div>
      {logoError ? (
        <p className="mz-field__error mz-form-grid__wide" role="alert">
          {logoError}
        </p>
      ) : null}

      <div className="mz-form-grid__wide">
        <TextField
          label={t('settings:business_name')}
          hint={t('settings:business_name_hint')}
          value={name}
          maxLength={200}
          onChange={(event) => edit(setName, event.target.value)}
        />
      </div>
      <TextField
        label={t('customers:phone')}
        hint={t('common:optional')}
        type="tel"
        inputMode="tel"
        value={phone}
        maxLength={40}
        onChange={(event) => edit(setPhone, event.target.value)}
      />
      <TextField
        label={t('customers:address')}
        hint={t('common:optional')}
        value={address}
        maxLength={500}
        onChange={(event) => edit(setAddress, event.target.value)}
      />
      {errorMessage(t, save.error) ? (
        <p className="mz-field__error mz-form-grid__wide" role="alert">
          {errorMessage(t, save.error)}
        </p>
      ) : null}
      <div
        className="mz-form-grid__wide mz-row"
        style={{ gap: 'var(--space-3)', alignItems: 'center' }}
      >
        <Button loading={save.isPending} onClick={() => save.mutate()}>
          {t('common:save')}
        </Button>
        {saved ? <span className="mz-muted">{t('settings:business_saved')}</span> : null}
      </div>
    </div>
  );
}

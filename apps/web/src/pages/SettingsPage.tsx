import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, NumberField, SegmentedControl, TextField, Toggle } from '@mizan/ui';
import { apiRequest, newIdempotencyKey } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { useApp, useFormatter, usePermission } from '../lib/store.js';
import { AppearanceCards } from '../components/Appearance.js';

/**
 * Settings (FR-1101 to FR-1107): appearance (language, theme, text size) is per device,
 * "My account" holds the password, and "System" is admin-only. Numbers always render in
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

        <AccountCard />

        {/* A user who may set the rate sees that card even without the rest (spec 3.3). */}
        {user?.role === 'admin' || maySetRate ? <GlobalRateCard /> : null}
        {user?.role === 'admin' ? <SystemCard /> : null}
      </div>
    </>
  );
}

function AccountCard() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () =>
      apiRequest('/auth/change-password', { method: 'POST', body: { current, new: next } }),
    onSuccess: () => {
      setMessage(t('auth:password_changed'));
      setError(null);
      setCurrent('');
      setNext('');
      setRepeat('');
    },
    onError: () => setError(t('auth:invalid_credentials')),
  });

  const mismatch = repeat.length > 0 && repeat !== next;

  return (
    <Card>
      <div className="mz-stack">
        <h2 className="mz-heading">{t('settings:my_account')}</h2>
        <TextField
          label={t('auth:current_password')}
          type="password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          autoComplete="current-password"
        />
        <TextField
          label={t('auth:new_password')}
          type="password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          autoComplete="new-password"
        />
        <TextField
          label={t('auth:confirm_password')}
          type="password"
          value={repeat}
          onChange={(event) => setRepeat(event.target.value)}
          error={mismatch ? t('errors:field.passwords_do_not_match') : undefined}
          autoComplete="new-password"
        />
        {error ? (
          <p className="mz-field__error" role="alert">
            {error}
          </p>
        ) : null}
        {message ? <p className="mz-muted">{message}</p> : null}
        <Button
          block
          loading={change.isPending}
          disabled={!current || !next || mismatch}
          onClick={() => change.mutate()}
        >
          {t('auth:change_password')}
        </Button>
      </div>
    </Card>
  );
}

interface SystemSettings {
  idle_lock_shared_minutes: number;
  idle_lock_default_minutes: number;
  week_start: 'sat' | 'sun' | 'mon';
  date_format: 'dd/MM/yyyy';
  /** Iteration 1: the rules selling is subject to (FR-1107, A-34). */
  allow_negative_stock: boolean;
  default_customer_currency: 'IQD' | 'USD';
  settle_tolerance_iqd: number;
  settle_tolerance_usd_cents: number;
}

interface GlobalRate {
  current: { rate_iqd_per_usd: string; effective_from: string } | null;
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

  const rates = useQuery({
    queryKey: ['global-rate'],
    queryFn: () => apiRequest<GlobalRate>('/settings/global-rates'),
  });

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
    onSuccess: async () => {
      setValue('');
      setNote('');
      setMessage(t('settings:rate_saved'));
      await queryClient.invalidateQueries({ queryKey: ['global-rate'] });
    },
  });

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

        {message ? <p className="mz-muted">{message}</p> : null}
      </div>
    </Card>
  );
}

function SystemCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => apiRequest<SystemSettings>('/settings'),
  });

  const save = useMutation({
    mutationFn: (patch: Partial<SystemSettings>) =>
      apiRequest<SystemSettings>('/settings', { method: 'PATCH', body: patch }),
    onSuccess: async () => {
      setMessage(t('settings:system_saved'));
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  if (!settings.data) return null;

  return (
    <Card>
      <div className="mz-stack">
        <h2 className="mz-heading">{t('settings:system')}</h2>

        {/* Go-live import (FR-1312, Proposed — not requested): admin-only, like this card. */}
        <Link to="/import" className="mz-button mz-button--ghost">
          {t('imports:title')}
        </Link>

        <TextField
          label={t('settings:idle_lock_shared')}
          type="number"
          inputMode="numeric"
          defaultValue={settings.data.idle_lock_shared_minutes}
          onBlur={(event) => save.mutate({ idle_lock_shared_minutes: Number(event.target.value) })}
        />
        <TextField
          label={t('settings:idle_lock_default')}
          type="number"
          inputMode="numeric"
          defaultValue={settings.data.idle_lock_default_minutes}
          onBlur={(event) => save.mutate({ idle_lock_default_minutes: Number(event.target.value) })}
        />
        <SegmentedControl
          label={t('settings:week_start')}
          value={settings.data.week_start}
          onChange={(value) => save.mutate({ week_start: value })}
          options={[
            { value: 'sat', label: t('settings:week_start_sat') },
            { value: 'sun', label: t('settings:week_start_sun') },
            { value: 'mon', label: t('settings:week_start_mon') },
          ]}
        />

        {/* Iteration 1: the selling rules. Each one is a rule an employee's form obeys, so
            each one is visible to them through `GET /settings` (FR-1107). */}
        <Toggle
          label={t('settings:allow_negative_stock')}
          hint={t('settings:allow_negative_stock_hint')}
          checked={settings.data.allow_negative_stock}
          onChange={(checked) => save.mutate({ allow_negative_stock: checked })}
        />
        <SegmentedControl
          label={t('settings:default_customer_currency')}
          value={settings.data.default_customer_currency}
          onChange={(value) => save.mutate({ default_customer_currency: value })}
          options={[
            { value: 'IQD', label: t('glossary:iqd') },
            { value: 'USD', label: t('glossary:usd') },
          ]}
        />
        <div className="mz-grid-2">
          <NumberField
            label={t('settings:settle_tolerance_iqd')}
            unit={t('common:iqd_symbol')}
            defaultValue={settings.data.settle_tolerance_iqd}
            onBlur={(event) => save.mutate({ settle_tolerance_iqd: Number(event.target.value) })}
          />
          <NumberField
            label={t('settings:settle_tolerance_usd')}
            defaultValue={settings.data.settle_tolerance_usd_cents}
            onBlur={(event) =>
              save.mutate({ settle_tolerance_usd_cents: Number(event.target.value) })
            }
          />
        </div>
        {message ? <p className="mz-muted">{message}</p> : null}
      </div>
    </Card>
  );
}

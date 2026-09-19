import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, SegmentedControl, TextField, Toggle } from '@mizan/ui';
import { LANGUAGE_NAMES, LOCALES } from '@mizan/i18n';
import type { Locale } from '@mizan/i18n';
import { apiRequest } from '../lib/api.js';
import { AppShell } from '../components/AppShell.js';
import { useApp, useFormatter } from '../lib/store.js';
import type { FontScale, Theme } from '../lib/preferences.js';

/**
 * Settings (FR-1101 to FR-1107): "This device" holds what the client asked to be saved in the
 * browser, "My account" holds the password, and "System" is admin-only. The device card says
 * plainly that these settings belong to the device, which matters on a shared tablet.
 */
export function SettingsPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const preferences = useApp((state) => state.preferences);
  const setPreference = useApp((state) => state.setPreference);
  const persisted = useApp((state) => state.preferencesPersisted);
  const user = useApp((state) => state.user);

  return (
    <AppShell title={t('settings:title')}>
      <div className="mz-stack">
        <Card>
          <div className="mz-stack">
            <h2 className="mz-heading">{t('settings:this_device')}</h2>
            <p className="mz-muted">{t('settings:this_device_hint')}</p>
            {!persisted ? (
              <p className="mz-field__error" role="alert">
                {t('settings:storage_unavailable')}
              </p>
            ) : null}

            <SegmentedControl
              label={t('settings:language')}
              value={preferences.lang}
              onChange={(value: Locale) => setPreference('lang', value)}
              options={LOCALES.map((locale) => ({ value: locale, label: LANGUAGE_NAMES[locale] }))}
            />

            <SegmentedControl
              label={t('settings:theme')}
              value={preferences.theme}
              onChange={(value: Theme) => setPreference('theme', value)}
              options={[
                { value: 'light', label: t('settings:theme_light') },
                { value: 'dark', label: t('settings:theme_dark') },
                { value: 'auto', label: t('settings:theme_auto') },
              ]}
            />

            <SegmentedControl
              label={t('settings:font_size')}
              value={String(preferences.fontScale)}
              onChange={(value) => setPreference('fontScale', Number(value) as FontScale)}
              options={[
                { value: '0.875', label: t('settings:font_small') },
                { value: '1', label: t('settings:font_default') },
                { value: '1.125', label: t('settings:font_large') },
                { value: '1.25', label: t('settings:font_xlarge') },
              ]}
            />
            {/* A live preview, so the stepper is judged on real text (spec 3.7.3). */}
            <p data-tabular>{t('settings:font_preview')}</p>

            <SegmentedControl
              label={t('settings:numerals')}
              value={preferences.numerals === 'latn' ? 'latn' : 'eastern'}
              onChange={(value) =>
                setPreference('numerals', value === 'latn' ? 'latn' : preferences.lang === 'ar-IQ' ? 'arab' : 'arabext')
              }
              options={[
                { value: 'latn', label: t('settings:numerals_western') },
                { value: 'eastern', label: t('settings:numerals_eastern') },
              ]}
            />
            <p className="mz-muted" data-tabular>
              {formatter.money(801_250, 'IQD')} · {formatter.date('2026-09-18')}
            </p>

            <Toggle
              label={t('settings:shared_device')}
              hint={t('settings:shared_device_hint')}
              checked={preferences.sharedDevice}
              onChange={(next) => setPreference('sharedDevice', next)}
            />
            <TextField
              label={t('settings:device_label')}
              placeholder={t('settings:device_label_placeholder')}
              value={preferences.deviceLabel ?? ''}
              onChange={(event) => setPreference('deviceLabel', event.target.value)}
            />
            <p className="mz-caption">{t('settings:saved_on_this_device')}</p>
          </div>
        </Card>

        <AccountCard />

        {user?.role === 'admin' ? <SystemCard /> : null}
      </div>
    </AppShell>
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
    mutationFn: () => apiRequest('/auth/change-password', { method: 'POST', body: { current, new: next } }),
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
        {message ? <p className="mz-muted">{message}</p> : null}
      </div>
    </Card>
  );
}

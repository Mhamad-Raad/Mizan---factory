import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, DateField, NumberField, SegmentedControl, TextField, Toggle } from '@mizan/ui';
import { LANGUAGE_NAMES, LOCALES, directionOf } from '@mizan/i18n';
import { ApiError, apiRequest, newIdempotencyKey } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { useApp, useFormatter, usePermission } from '../lib/store.js';
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
  const maySetRate = usePermission('settings.set_global_rate');

  usePageTitle(t('settings:title'));

  return (
    <>
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

            {/*
              * Language and theme as choices you can see rather than words in a strip.
              *
              * A language is named in its own script and says which way its screens read; a
              * theme shows what it looks like — a swatch of the surface, the text and the
              * primary colour it would give you — because "Dark" is a word and the choice is a
              * picture. Both are still one tap, and both are per device (FR-1103).
              */}
            <fieldset className="mz-choice-group">
              <legend className="mz-field__label">{t('settings:language')}</legend>
              <p className="mz-field__hint">{t('settings:language_hint')}</p>
              <div className="mz-choices">
                {LOCALES.map((locale) => (
                  <label key={locale} className="mz-choice" lang={locale}>
                    <input
                      type="radio"
                      name="mizan-language"
                      className="mz-choice__input"
                      checked={preferences.lang === locale}
                      onChange={() => setPreference('lang', locale)}
                    />
                    <span className="mz-choice__body">
                      <span className="mz-choice__title">{LANGUAGE_NAMES[locale]}</span>
                      <span className="mz-choice__hint" dir="ltr">
                        {directionOf(locale) === 'rtl' ? 'RTL' : 'LTR'}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="mz-choice-group">
              <legend className="mz-field__label">{t('settings:theme')}</legend>
              <div className="mz-choices">
                {(
                  [
                    { value: 'light', label: t('settings:theme_light'), hint: t('settings:theme_light_hint') },
                    { value: 'dark', label: t('settings:theme_dark'), hint: t('settings:theme_dark_hint') },
                    { value: 'auto', label: t('settings:theme_auto'), hint: t('settings:theme_auto_hint') },
                  ] as { value: Theme; label: string; hint: string }[]
                ).map((option) => (
                  <label key={option.value} className="mz-choice">
                    <input
                      type="radio"
                      name="mizan-theme"
                      className="mz-choice__input"
                      checked={preferences.theme === option.value}
                      onChange={() => setPreference('theme', option.value)}
                    />
                    <span className="mz-choice__body">
                      {/* What it looks like, not only what it is called. */}
                      <span className={`mz-swatch mz-swatch--${option.value}`} aria-hidden="true">
                        <span className="mz-swatch__bar" />
                        <span className="mz-swatch__line" />
                        <span className="mz-swatch__line mz-swatch__line--short" />
                      </span>
                      <span className="mz-choice__title">{option.label}</span>
                      <span className="mz-choice__hint">{option.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

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

        <PinCard />
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

/**
 * My PIN (FR-106). A PIN is optional and personal: it unlocks this employee's own session, and
 * on a browser where they have signed in with their password it also signs them in from the
 * lock screen. Setting one asks for the password, because an unlocked tablet on a bench must
 * not be enough to mint a credential.
 */
function PinCard() {
  const { t } = useTranslation();
  const user = useApp((state) => state.user);
  const preferences = useApp((state) => state.preferences);
  const queryClient = useQueryClient();

  const [pin, setPin] = useState('');
  const [repeat, setRepeat] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A PIN set on a personal phone may be too short for a shared tablet, so the form asks for
  // what *this* device needs and says why.
  const minimum = preferences.sharedDevice ? preferences.pinPolicy.shared : preferences.pinPolicy.personal;

  const save = useMutation({
    mutationFn: (next: string | null) =>
      apiRequest('/auth/pin', { method: 'POST', body: { pin: next, current_password: password } }),
    onSuccess: async (_result, next) => {
      setMessage(next === null ? t('auth:pin_removed') : t('auth:pin_set'));
      setError(null);
      setPin('');
      setRepeat('');
      setPassword('');
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (caught) => {
      setMessage(null);
      if (caught instanceof ApiError) {
        const field = caught.fields?.[0];
        setError(field ? t(field.message_key, field.params) : t('auth:invalid_credentials'));
      } else setError(t('errors:INTERNAL'));
    },
  });

  const mismatch = repeat.length > 0 && repeat !== pin;
  const tooShort = pin.length > 0 && pin.length < minimum;

  return (
    <Card>
      <div className="mz-stack">
        <h2 className="mz-heading">{t('auth:pin')}</h2>
        <p className="mz-caption">{t('auth:pin_hint')}</p>

        <TextField
          label={t('auth:pin')}
          type="password"
          inputMode="numeric"
          dir="ltr"
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
          error={tooShort ? t('auth:pin_rules', { min: minimum, max: 6 }) : undefined}
          autoComplete="off"
        />
        <TextField
          label={t('auth:repeat_pin')}
          type="password"
          inputMode="numeric"
          dir="ltr"
          value={repeat}
          onChange={(event) => setRepeat(event.target.value.replace(/\D/g, '').slice(0, 6))}
          error={mismatch ? t('auth:pin_mismatch') : undefined}
          autoComplete="off"
        />
        <TextField
          label={t('auth:current_password')}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
        />

        {error ? (
          <p className="mz-field__error" role="alert">
            {error}
          </p>
        ) : null}
        {message ? <p className="mz-muted">{message}</p> : null}

        <Button
          block
          loading={save.isPending}
          disabled={!password || pin.length < minimum || mismatch}
          onClick={() => save.mutate(pin)}
        >
          {user?.has_pin ? t('auth:change_pin') : t('auth:set_pin')}
        </Button>
        {user?.has_pin ? (
          <Button
            variant="ghost"
            block
            loading={save.isPending}
            disabled={!password}
            onClick={() => save.mutate(null)}
          >
            {t('auth:remove_pin')}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

interface SystemSettings {
  idle_lock_shared_minutes: number;
  idle_lock_default_minutes: number;
  week_start: 'sat' | 'sun' | 'mon';
  date_format: 'dd/MM/yyyy';
  /** Iteration 1: the rules selling is subject to (FR-1107, FR-1109, A-34). */
  allow_negative_stock: boolean;
  default_customer_currency: 'IQD' | 'USD';
  rate_guard_percent: number;
  settle_tolerance_iqd: number;
  settle_tolerance_usd_cents: number;
  order_edit_window_days: number | null;
  allow_edit_after_payment: boolean;
  locked_through: string | null;
  rate_stale_days: number;
  /** Iteration 5: the shared-tablet rules (FR-106, 2.8). */
  pin_min_length_shared: number;
  pin_min_length_personal: number;
  allow_pin_switch_on_shared: boolean;
}

interface GlobalRate {
  current: { rate_iqd_per_usd: string; effective_from: string; is_stale: boolean } | null;
  items: { id: string; rate_iqd_per_usd: string; effective_from: string; note: string | null; created_by_name: string | null }[];
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
  const [guard, setGuard] = useState<{ previous: string; next: string; percent: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const rates = useQuery({
    queryKey: ['global-rate'],
    queryFn: () => apiRequest<GlobalRate>('/settings/global-rates'),
  });

  const save = useMutation({
    mutationFn: (confirm: boolean) =>
      apiRequest<GlobalRate['current']>('/settings/global-rates', {
        method: 'POST',
        body: { rate_iqd_per_usd: value.trim(), note: note.trim() === '' ? null : note.trim(), confirm },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      setValue('');
      setNote('');
      setGuard(null);
      setMessage(t('settings:rate_saved'));
      await queryClient.invalidateQueries({ queryKey: ['global-rate'] });
    },
    onError: (error) => {
      // ±20 % (the `rate_guard_percent` setting) asks for a confirmation rather than
      // refusing: a typo of 13,100 for 1,310 would value every later document at a tenth.
      if (error instanceof ApiError && error.code === 'RATE_GUARD') {
        setGuard({
          previous: String(error.params.previous ?? ''),
          next: String(error.params.next ?? ''),
          percent: Number(error.params.percent ?? 0),
        });
      }
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
              {t('settings:rate_since', { time: formatter.timestamp(new Date(rates.data.current.effective_from)) })}
            </span>
          </p>
        ) : (
          <p className="mz-field__error">{t('settings:no_rate_yet')}</p>
        )}

        {rates.data?.current?.is_stale ? (
          <div className="mz-warning" role="status">
            {t('settings:rate_stale', { rate: formatter.rate(rates.data.current.rate_iqd_per_usd) })}
          </div>
        ) : null}

        <NumberField
          label={t('settings:new_rate')}
          hint={t('settings:new_rate_hint')}
          decimals={4}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <TextField label={t('common:note')} value={note} onChange={(event) => setNote(event.target.value)} />

        {guard ? (
          <div className="mz-warning" role="alert">
            {t('settings:rate_guard', { previous: guard.previous, next: guard.next, percent: guard.percent })}
          </div>
        ) : null}

        <Button
          block
          loading={save.isPending}
          disabled={value.trim() === ''}
          onClick={() => save.mutate(guard !== null)}
        >
          {guard ? t('glossary:confirm') : t('settings:set_rate')}
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
            onBlur={(event) => save.mutate({ settle_tolerance_usd_cents: Number(event.target.value) })}
          />
        </div>
        <NumberField
          label={t('settings:rate_guard_percent')}
          defaultValue={settings.data.rate_guard_percent}
          onBlur={(event) => save.mutate({ rate_guard_percent: Number(event.target.value) })}
        />
        <NumberField
          label={t('settings:order_edit_window')}
          hint={t('settings:order_edit_window_hint')}
          defaultValue={settings.data.order_edit_window_days ?? ''}
          onBlur={(event) =>
            save.mutate({
              order_edit_window_days: event.target.value.trim() === '' ? null : Number(event.target.value),
            })
          }
        />
        <Toggle
          label={t('settings:allow_edit_after_payment')}
          hint={t('settings:allow_edit_after_payment_hint')}
          checked={settings.data.allow_edit_after_payment}
          onChange={(checked) => save.mutate({ allow_edit_after_payment: checked })}
        />

        {/* Proposed — not requested (FR-1109): the period lock. */}
        <DateField
          label={t('settings:locked_through')}
          hint={t('settings:locked_through_hint')}
          defaultValue={settings.data.locked_through ?? ''}
          onBlur={(event) =>
            save.mutate({ locked_through: event.target.value.trim() === '' ? null : event.target.value })
          }
        />
        <NumberField
          label={t('settings:rate_stale_days')}
          hint={t('settings:rate_stale_days_hint')}
          defaultValue={settings.data.rate_stale_days}
          onBlur={(event) => save.mutate({ rate_stale_days: Number(event.target.value) })}
        />

        {/* Iteration 5: what a PIN must be, and whether one may sign anybody in on a tablet
            everybody holds (FR-106). Turning the switch off leaves passwords only. */}
        <div className="mz-grid-2">
          <NumberField
            label={t('settings:pin_min_shared')}
            hint={t('settings:pin_min_shared_hint')}
            defaultValue={settings.data.pin_min_length_shared}
            onBlur={(event) => save.mutate({ pin_min_length_shared: Number(event.target.value) })}
          />
          <NumberField
            label={t('settings:pin_min_personal')}
            defaultValue={settings.data.pin_min_length_personal}
            onBlur={(event) => save.mutate({ pin_min_length_personal: Number(event.target.value) })}
          />
        </div>
        <Toggle
          label={t('settings:allow_pin_switch')}
          hint={t('settings:allow_pin_switch_hint')}
          checked={settings.data.allow_pin_switch_on_shared}
          onChange={(checked) => save.mutate({ allow_pin_switch_on_shared: checked })}
        />

        {message ? <p className="mz-muted">{message}</p> : null}
      </div>
    </Card>
  );
}

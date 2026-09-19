import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Card, PasswordField } from '@mizan/ui';
import { ApiError, apiRequest } from '../lib/api.js';
import { useApp } from '../lib/store.js';

/** A user flagged "must change password" goes here before anything else (FR-101). */
export function ChangePasswordPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useApp((state) => state.user);
  const setSession = useApp((state) => state.setSession);
  const permissions = useApp((state) => state.permissions);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = repeat.length > 0 && repeat !== next;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiRequest('/auth/change-password', { method: 'POST', body: { current, new: next } });
      if (user) setSession({ user: { ...user, must_change_password: false }, permissions: [...permissions] });
      navigate('/');
    } catch (caught) {
      if (caught instanceof ApiError && caught.fields[0]) {
        setError(t(caught.fields[0].message_key, { min: 8, ...(caught.fields[0].params ?? {}) }));
      } else setError(t('errors:INTERNAL'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mz-app">
      <header className="mz-header">
        <h1 className="mz-header__title">{t('auth:must_change_password_title')}</h1>
      </header>
      <main className="mz-main">
        <Card>
          <form className="mz-stack" onSubmit={submit} noValidate>
            <p className="mz-muted">{t('auth:must_change_password_body')}</p>
            <PasswordField
              label={t('auth:current_password')}
              showLabel={t('auth:show_password')}
              hideLabel={t('auth:hide_password')}
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              autoComplete="current-password"
              required
            />
            <PasswordField
              label={t('auth:new_password')}
              showLabel={t('auth:show_password')}
              hideLabel={t('auth:hide_password')}
              value={next}
              onChange={(event) => setNext(event.target.value)}
              autoComplete="new-password"
              required
            />
            <PasswordField
              label={t('auth:confirm_password')}
              showLabel={t('auth:show_password')}
              hideLabel={t('auth:hide_password')}
              value={repeat}
              onChange={(event) => setRepeat(event.target.value)}
              error={mismatch ? t('errors:field.passwords_do_not_match') : undefined}
              autoComplete="new-password"
              required
            />
            {error ? (
              <p className="mz-field__error" role="alert">
                {error}
              </p>
            ) : null}
            <Button type="submit" block loading={busy} disabled={!current || !next || mismatch}>
              {t('auth:change_password')}
            </Button>
          </form>
        </Card>
      </main>
    </div>
  );
}

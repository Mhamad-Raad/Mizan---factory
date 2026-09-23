import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Card, MizanMark, PasswordField, TextField } from '@mizan/ui';
import { ApiError, NetworkError, apiRequest } from '../lib/api.js';
import { useApp } from '../lib/store.js';
import type { SessionUser } from '../lib/store.js';
import { readRecentUsers, rememberUser } from '../lib/preferences.js';
import { LanguageChips } from '../components/LanguageChips.js';

interface LoginResponse {
  user: SessionUser;
  permissions: string[];
  /** The device ticket for this browser, handed over once per password sign-in (FR-106). */
  device_ticket?: string | null;
}

/**
 * Sign in without e-mail (FR-101): two fields and one button, usable one-handed at 360 px in
 * all three languages. A wrong username and a wrong password give the same message.
 */
export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setSession = useApp((state) => state.setSession);
  const preferences = useApp((state) => state.preferences);

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await apiRequest<LoginResponse>('/auth/login', {
        method: 'POST',
        body: {
          username_or_phone: identifier,
          password,
          is_shared_device: preferences.sharedDevice,
          device_label: preferences.deviceLabel ?? null,
          // The ticket this browser already holds for this name, so the server retires it
          // rather than leaving one live ticket per sign-in (FR-106).
          replaces_ticket:
            readRecentUsers().find((entry) => entry.username === identifier.trim().toLowerCase())?.ticket ?? null,
        },
      });
      setSession({ user: response.user, permissions: response.permissions });
      rememberUser({
        username: response.user.username,
        displayName: response.user.display_name,
        lastAt: new Date().toISOString(),
        lang: preferences.lang,
        // The ticket this browser was just handed: what lets this employee's PIN unlock or
        // sign in here for the next seven days (FR-106).
        ticket: response.device_ticket ?? null,
        hasPin: response.user.has_pin,
      });
      navigate(response.user.must_change_password ? '/change-password' : '/');
    } catch (caught) {
      if (caught instanceof NetworkError) setError(t('errors:NETWORK'));
      else if (caught instanceof ApiError) {
        if (caught.code === 'RATE_LIMITED') {
          setError(t('auth:locked_out', { minutes: caught.params.minutes as number }));
        } else if (caught.params.reason === 'deactivated') {
          setError(t('auth:account_deactivated'));
        } else {
          setError(t('auth:invalid_credentials'));
        }
      } else setError(t('errors:INTERNAL'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mz-app mz-app--doorway">
      {/* A plum band with the mark above the form, so a shared tablet's screen says which
          application this is before a word is read (spec 3.2.5, FR-1311). */}
      <header className="mz-login-band">
        <MizanMark size={64} title={t('common:app_name')} />
        <p className="mz-login-band__name">{t('common:app_name')}</p>
      </header>
      <main className="mz-main mz-main--narrow">
        <Card>
          <form className="mz-stack" onSubmit={submit} noValidate>
            <h2 className="mz-title">{t('auth:sign_in')}</h2>

            <TextField
              label={t('auth:username_or_phone')}
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              required
            />
            <PasswordField
              label={t('auth:password')}
              showLabel={t('auth:show_password')}
              hideLabel={t('auth:hide_password')}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />

            {error ? (
              <p className="mz-field__error" role="alert">
                {error}
              </p>
            ) : null}

            <Button type="submit" block loading={busy} disabled={!identifier || !password}>
              {t('auth:sign_in')}
            </Button>
          </form>
        </Card>

        <div style={{ marginBlockStart: 'var(--space-4)', display: 'flex', justifyContent: 'center' }}>
          <LanguageChips />
        </div>
      </main>
    </div>
  );
}

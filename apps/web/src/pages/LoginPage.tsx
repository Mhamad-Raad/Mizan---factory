import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, PasswordField, TextField } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { signInError } from '../lib/signInError.js';
import type { SignInError } from '../lib/signInError.js';
import { useApp } from '../lib/store.js';
import type { SessionUser } from '../lib/store.js';
import { rememberUser } from '../lib/preferences.js';
import { Doorway } from '../components/Doorway.js';

interface LoginResponse {
  user: SessionUser;
  permissions: string[];
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
  const [error, setError] = useState<SignInError | null>(null);
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
        },
      });
      setSession({ user: response.user, permissions: response.permissions });
      rememberUser({
        username: response.user.username,
        displayName: response.user.display_name,
        lastAt: new Date().toISOString(),
        lang: preferences.lang,
      });
      navigate(response.user.must_change_password ? '/change-password' : '/');
    } catch (caught) {
      setError(signInError(t, caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Doorway subtitle={t('auth:sign_in_subtitle')}>
      <form className="mz-stack" onSubmit={submit} noValidate>
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
            {error.message}
          </p>
        ) : null}
        {error?.warning ? (
          <div className="mz-warning" role="status">
            {error.warning}
          </div>
        ) : null}

        <Button type="submit" block loading={busy} disabled={!identifier || !password}>
          {t('auth:sign_in')}
        </Button>
      </form>
    </Doorway>
  );
}

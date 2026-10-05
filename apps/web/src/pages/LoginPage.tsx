import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Button, PasswordField, TextField } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { signInError } from '../lib/signInError.js';
import type { SignInError } from '../lib/signInError.js';
import { useApp } from '../lib/store.js';
import type { SessionUser } from '../lib/store.js';
import { rememberUser } from '../lib/preferences.js';
import { SESSION_IDLE_MINUTES } from '@mizan/permissions';
import { clearIdleNotice, hasIdleNotice, startActivity } from '../lib/idleSignOut.js';
import { clearPendingSignOut, forgetPreviousUser, idleSignOutSettled } from '../lib/signOut.js';
import { useFormatter } from '../lib/store.js';
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
  const queryClient = useQueryClient();
  const formatter = useFormatter();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<SignInError | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // An idle sign-out on its way would clear the cookie this sign-in is about to set, were
      // it answered second. Out of reach, the sign-in below fails and says so.
      await idleSignOutSettled().catch(() => undefined);
      const response = await apiRequest<LoginResponse>('/auth/login', {
        method: 'POST',
        body: {
          username_or_phone: identifier,
          password,
          is_shared_device: preferences.sharedDevice,
          device_label: preferences.deviceLabel ?? null,
        },
      });
      // Whatever the last person left on this device — cached answers, drafts — goes before the
      // new session's first screen, however their session ended (2.10.2).
      forgetPreviousUser(queryClient, response.user.id);
      clearIdleNotice();
      clearPendingSignOut();
      startActivity();
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
    <Doorway subtitle={t('auth:sign_in_subtitle')} tabTitle={t('auth:sign_in')}>
      <form className="mz-stack" onSubmit={submit} noValidate>
        {/* Why the user is looking at this page, when the idle sign-out sent them here (D-078). */}
        {hasIdleNotice() && !error ? (
          <div className="mz-warning" role="status">
            {t('auth:idle_signed_out', { minutes: formatter.number(SESSION_IDLE_MINUTES) })}
          </div>
        ) : null}
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

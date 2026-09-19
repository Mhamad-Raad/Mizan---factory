import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Avatar, Button, Card, MizanMark, PasswordField } from '@mizan/ui';
import { ApiError, apiRequest } from '../lib/api.js';
import { useApp } from '../lib/store.js';
import { LanguageChips } from '../components/LanguageChips.js';

/**
 * The lock screen (FR-106). In Iteration 0 the password is the only way back in; the PIN pad
 * and the recent-user switcher arrive with I5, which is why this screen stays deliberately
 * small rather than being written now and rewritten then.
 */
export function LockPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useApp((state) => state.user);
  const setLocked = useApp((state) => state.setLocked);
  const clearSession = useApp((state) => state.clearSession);

  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const unlock = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiRequest('/auth/unlock', { method: 'POST', body: { password } });
      setLocked(false);
      setPassword('');
      navigate('/');
    } catch (caught) {
      setError(caught instanceof ApiError ? t('auth:invalid_credentials') : t('errors:INTERNAL'));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await apiRequest('/auth/logout', { method: 'POST' });
    clearSession();
    navigate('/login');
  };

  return (
    <div className="mz-app">
      <header className="mz-login-band">
        <MizanMark size={64} title={t('common:app_name')} />
        <p className="mz-login-band__name">{t('common:app_name')}</p>
      </header>
      <main className="mz-main">
        <Card>
          <div className="mz-stack">
            <div className="mz-row">
              <Avatar name={user?.display_name ?? '?'} />
              <div>
                <p className="mz-heading">{user?.display_name}</p>
                <p className="mz-muted">{t('auth:locked_title')}</p>
              </div>
            </div>

            <form className="mz-stack" onSubmit={unlock} noValidate>
              <PasswordField
                label={t('auth:password')}
                hint={t('auth:unlock_with_password')}
                showLabel={t('auth:show_password')}
                hideLabel={t('auth:hide_password')}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                autoFocus
                required
              />
              {error ? (
                <p className="mz-field__error" role="alert">
                  {error}
                </p>
              ) : null}
              <Button type="submit" block loading={busy} disabled={!password}>
                {t('auth:unlock')}
              </Button>
              <Button variant="ghost" block onClick={() => void signOut()}>
                {t('auth:sign_out')}
              </Button>
            </form>

            <LanguageChips />
          </div>
        </Card>
      </main>
    </div>
  );
}

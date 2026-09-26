import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Avatar, Button, PasswordField } from '@mizan/ui';
import { Doorway } from '../components/Doorway.js';
import { apiRequest } from '../lib/api.js';
import { signInError } from '../lib/signInError.js';
import type { SignInError } from '../lib/signInError.js';
import { clearAllDrafts } from '../lib/drafts.js';
import { useMotionAllowed, staggerDelay } from '../lib/motion.js';
import { readRecentUsers, rememberUser } from '../lib/preferences.js';
import type { RecentUser } from '../lib/preferences.js';
import { useApp } from '../lib/store.js';
import type { SessionUser } from '../lib/store.js';

interface SwitchResponse {
  user: SessionUser;
  permissions: string[];
}

/**
 * The lock screen (spec 3.3, flow 3.5.8).
 *
 * Two employees share one tablet, so this screen answers two questions. "Still me?" — the
 * password on the **same** session, which keeps the drafts. "Somebody else?" — the last three
 * people who signed in on this browser, each asked for their password. Taking over ends the
 * previous session and its drafts, because those belonged to the employee who walked away.
 */
export function LockPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useApp((state) => state.user);
  const preferences = useApp((state) => state.preferences);

  const setLocked = useApp((state) => state.setLocked);
  const setSession = useApp((state) => state.setSession);
  const setPreference = useApp((state) => state.setPreference);
  const clearSession = useApp((state) => state.clearSession);

  /** Read once: the list must not shuffle under the thumb while somebody is tapping it. */
  const recent = useMemo(
    () => readRecentUsers().filter((entry) => entry.username !== user?.username),
    [user?.username],
  );

  /** Who is being asked for a credential: the signed-in user, or somebody taking over. */
  const [switching, setSwitching] = useState<RecentUser | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<SignInError | null>(null);
  const [busy, setBusy] = useState(false);

  const motion = useMotionAllowed();
  const shared = preferences.sharedDevice;

  const reset = (): void => {
    setPassword('');
    setError(null);
  };

  const choose = (entry: RecentUser | null): void => {
    reset();
    setSwitching(entry);
  };

  /** Unlock this session — the same session, so drafts survive (2.8). */
  const unlock = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await apiRequest('/auth/unlock', { method: 'POST', body: { password } });
      setLocked(false);
      reset();
      navigate('/');
    } catch (caught) {
      setError(signInError(t, caught));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Hand the tablet to somebody else. Their language comes with them (FR-1103), and the
   * previous employee's drafts go with their session (2.10.2).
   */
  const takeOver = async (entry: RecentUser): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await apiRequest<SwitchResponse>('/auth/login', {
        method: 'POST',
        body: {
          username_or_phone: entry.username,
          password,
          is_shared_device: shared,
          device_label: preferences.deviceLabel ?? null,
        },
      });

      clearAllDrafts();
      // Their own language, as they left it on this device, before the first screen paints.
      setPreference('lang', entry.lang);
      setSession({ user: response.user, permissions: response.permissions, isLocked: false });
      rememberUser({
        username: response.user.username,
        displayName: response.user.display_name,
        lastAt: new Date().toISOString(),
        lang: entry.lang,
      });
      reset();
      navigate(response.user.must_change_password ? '/change-password' : '/');
    } catch (caught) {
      setError(signInError(t, caught));
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = (event: FormEvent): void => {
    event.preventDefault();
    if (switching) void takeOver(switching);
    else void unlock();
  };

  const signOut = async (): Promise<void> => {
    await apiRequest('/auth/logout', { method: 'POST' });
    clearAllDrafts();
    clearSession();
    navigate('/login');
  };

  const who = switching ?? {
    displayName: user?.display_name ?? '?',
    username: user?.username ?? '',
  };

  return (
    <Doorway>
      <div className="mz-stack">
        <div className="mz-row">
          <Avatar name={who.displayName} />
          <div>
            <p className="mz-heading">{who.displayName}</p>
            <p className="mz-muted">{switching ? t('auth:switch_user') : t('auth:locked_title')}</p>
          </div>
        </div>

        <form className="mz-stack" onSubmit={submitPassword} noValidate>
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
              {error.message}
            </p>
          ) : null}
          {error?.warning ? (
            <div className="mz-warning" role="status">
              {error.warning}
            </div>
          ) : null}
          <Button type="submit" block loading={busy} disabled={!password}>
            {switching ? t('auth:sign_in') : t('auth:unlock')}
          </Button>
        </form>

        {recent.length > 0 ? (
          <div className="mz-stack" style={{ gap: 'var(--space-2)' }}>
            <p className="mz-caption">{t('auth:recent_users')}</p>
            <ul className="mz-list">
              {(switching
                ? [{ username: '', displayName: who.displayName } as RecentUser]
                : recent
              ).map((entry, index) => (
                <li
                  key={entry.username || 'current'}
                  className={motion ? 'mz-switcher__card' : undefined}
                  style={{
                    ['--mz-stagger' as string]: staggerDelay(index, recent.length, motion),
                  }}
                >
                  <button
                    type="button"
                    className="mz-list__item mz-list__item--interactive"
                    style={{
                      inlineSize: '100%',
                      background: 'none',
                      border: 0,
                      textAlign: 'start',
                    }}
                    onClick={() => choose(switching ? null : entry)}
                    disabled={busy}
                  >
                    <span className="mz-list__body">
                      <span className="mz-list__title">
                        {switching
                          ? t('auth:signed_in_as', { name: user?.display_name ?? '' })
                          : entry.displayName}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <Button variant="ghost" block onClick={() => void signOut()}>
          {t('auth:sign_out')}
        </Button>
      </div>
    </Doorway>
  );
}

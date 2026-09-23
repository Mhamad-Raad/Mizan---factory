import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Avatar, Button, Card, MizanMark, PasswordField, PinPad } from '@mizan/ui';
import { ApiError, apiRequest } from '../lib/api.js';
import { clearAllDrafts } from '../lib/drafts.js';
import { useMotionAllowed, staggerDelay } from '../lib/motion.js';
import { forgetTicket, readRecentUsers, rememberUser } from '../lib/preferences.js';
import type { RecentUser } from '../lib/preferences.js';
import { useApp } from '../lib/store.js';
import type { SessionUser } from '../lib/store.js';
import { LanguageChips } from '../components/LanguageChips.js';

interface SwitchResponse {
  user: SessionUser;
  permissions: string[];
  device_ticket?: string | null;
}

/**
 * The lock screen (FR-106, spec 3.3, flow 3.5.8).
 *
 * Two employees share one tablet, so this screen answers two questions. "Still me?" — the PIN
 * pad, or the password, on the **same** session, which keeps the drafts. "Somebody else?" — the
 * last three people who signed in on this browser, each offered their PIN when this browser
 * still holds a ticket for them, and their password otherwise. Taking over ends the previous
 * session and its drafts, because those belonged to the employee who walked away.
 *
 * Everything the PIN can do here depends on a ticket in this browser's storage, so every
 * refusal is explained rather than silently swallowed: "sign in with your password on this
 * device first" is a different sentence from "wrong PIN", and an employee standing at a bench
 * needs to know which of the two they are looking at.
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
  const [pin, setPin] = useState('');
  const [password, setPassword] = useState('');
  const [usePassword, setUsePassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const motion = useMotionAllowed();
  const shared = preferences.sharedDevice;
  // The policy this browser last saw, because a locked session cannot ask the server (D-038).
  const pinLength = shared ? preferences.pinPolicy.shared : preferences.pinPolicy.personal;
  const pinSwitchAllowed = !shared || preferences.pinPolicy.switchOnShared;

  const ownPinAvailable = Boolean(user?.has_pin);
  const switchPinAvailable = Boolean(switching?.ticket && switching?.hasPin !== false && pinSwitchAllowed);

  const reset = (): void => {
    setPin('');
    setPassword('');
    setError(null);
  };

  const choose = (entry: RecentUser | null): void => {
    reset();
    setUsePassword(false);
    setSwitching(entry);
  };

  /** Unlock this session — the same session, so drafts survive (2.8). */
  const unlock = async (credential: { pin?: string; password?: string }): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await apiRequest('/auth/unlock', { method: 'POST', body: credential });
      setLocked(false);
      reset();
      navigate('/');
    } catch (caught) {
      setPin('');
      if (caught instanceof ApiError) {
        const field = caught.fields?.[0];
        setError(field ? t(field.message_key, field.params) : t('auth:invalid_credentials'));
      } else setError(t('errors:INTERNAL'));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Hand the tablet to somebody else. Their language comes with them (FR-1103), and the
   * previous employee's drafts go with their session (2.10.2).
   */
  const takeOver = async (entry: RecentUser, credential: { pin?: string; password?: string }): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const body =
        credential.pin !== undefined
          ? {
              ticket: entry.ticket,
              pin: credential.pin,
              is_shared_device: shared,
              device_label: preferences.deviceLabel ?? null,
              switch_from_session: true,
            }
          : {
              username_or_phone: entry.username,
              password: credential.password,
              is_shared_device: shared,
              device_label: preferences.deviceLabel ?? null,
              replaces_ticket: entry.ticket ?? null,
            };
      const response = await apiRequest<SwitchResponse>('/auth/login', { method: 'POST', body });

      clearAllDrafts();
      // Their own language, as they left it on this device, before the first screen paints.
      setPreference('lang', entry.lang);
      setSession({ user: response.user, permissions: response.permissions, isLocked: false });
      rememberUser({
        username: response.user.username,
        displayName: response.user.display_name,
        lastAt: new Date().toISOString(),
        lang: entry.lang,
        ticket: response.device_ticket ?? undefined,
        hasPin: response.user.has_pin,
      });
      reset();
      navigate(response.user.must_change_password ? '/change-password' : '/');
    } catch (caught) {
      setPin('');
      if (caught instanceof ApiError) {
        const reason = caught.params.reason as string | undefined;
        if (reason === 'ticket_invalid' || reason === 'pin_attempts_exhausted') {
          // The ticket is gone; the password is the way in, and the pad must stop pretending.
          forgetTicket(entry.username);
          setSwitching({ ...entry, ticket: null });
          setUsePassword(true);
          setError(t(reason === 'ticket_invalid' ? 'auth:ticket_invalid' : 'auth:pin_attempts_exhausted'));
        } else if (reason === 'pin_switch_disabled') {
          setUsePassword(true);
          setError(t('auth:pin_switch_disabled'));
        } else if (reason === 'no_pin') {
          setUsePassword(true);
          setError(t('auth:no_pin'));
        } else if (reason === 'pin_too_short') {
          setUsePassword(true);
          setError(t('auth:pin_too_short', { min: caught.params.min as number }));
        } else if (reason === 'deactivated') {
          setError(t('auth:account_deactivated'));
        } else if (caught.code === 'RATE_LIMITED') {
          setError(t('auth:locked_out', { minutes: caught.params.minutes as number }));
        } else if (reason === 'invalid_pin') {
          const left = caught.params.attempts_left as number | undefined;
          setError(left === undefined ? t('auth:invalid_pin') : `${t('auth:invalid_pin')} · ${t('auth:attempts_left', { count: left })}`);
        } else setError(t('auth:invalid_credentials'));
      } else setError(t('errors:INTERNAL'));
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = (event: FormEvent): void => {
    event.preventDefault();
    if (switching) void takeOver(switching, { password });
    else void unlock({ password });
  };

  const signOut = async (): Promise<void> => {
    await apiRequest('/auth/logout', { method: 'POST' });
    clearAllDrafts();
    clearSession();
    navigate('/login');
  };

  const showPinPad = switching ? switchPinAvailable && !usePassword : ownPinAvailable && !usePassword;
  const who = switching ?? { displayName: user?.display_name ?? '?', username: user?.username ?? '' };

  return (
    <div className="mz-app mz-app--doorway">
      <header className="mz-login-band">
        <MizanMark size={64} title={t('common:app_name')} />
        <p className="mz-login-band__name">{t('common:app_name')}</p>
      </header>
      <main className="mz-main mz-main--narrow">
        <Card>
          <div className="mz-stack">
            <div className="mz-row">
              <Avatar name={who.displayName} />
              <div>
                <p className="mz-heading">{who.displayName}</p>
                <p className="mz-muted">{switching ? t('auth:switch_user') : t('auth:locked_title')}</p>
              </div>
            </div>

            {showPinPad ? (
              <div className={motion ? 'mz-pinpad--flip' : undefined}>
              <PinPad
                value={pin}
                onChange={(next) => {
                  setPin(next);
                  setError(null);
                }}
                onComplete={(complete) => {
                  if (switching) void takeOver(switching, { pin: complete });
                  else void unlock({ pin: complete });
                }}
                length={pinLength}
                label={t('auth:unlock_with_pin')}
                hint={t('auth:pin_hint')}
                error={error ?? undefined}
                backspaceLabel={t('common:back')}
                disabled={busy}
              />
              </div>
            ) : (
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
                    {error}
                  </p>
                ) : null}
                <Button type="submit" block loading={busy} disabled={!password}>
                  {switching ? t('auth:sign_in') : t('auth:unlock')}
                </Button>
              </form>
            )}

            {/* The other credential, when this employee has both available on this browser. */}
            {(switching ? switchPinAvailable : ownPinAvailable) ? (
              <Button
                variant="ghost"
                block
                onClick={() => {
                  reset();
                  setUsePassword((current) => !current);
                }}
              >
                {showPinPad ? t('auth:use_password_instead') : t('auth:use_pin_instead')}
              </Button>
            ) : null}

            {recent.length > 0 ? (
              <div className="mz-stack" style={{ gap: 'var(--space-2)' }}>
                <p className="mz-caption">{t('auth:recent_users')}</p>
                <ul className="mz-list">
                  {(switching ? [{ username: '', displayName: who.displayName } as RecentUser] : recent).map(
                    (entry, index) => (
                      <li
                        key={entry.username || 'current'}
                        className={motion ? 'mz-switcher__card' : undefined}
                        style={{ ['--mz-stagger' as string]: staggerDelay(index, recent.length, motion) }}
                      >
                        <button
                          type="button"
                          className="mz-list__item mz-list__item--interactive"
                          style={{ inlineSize: '100%', background: 'none', border: 0, textAlign: 'start' }}
                          onClick={() => choose(switching ? null : entry)}
                          disabled={busy}
                        >
                          <span className="mz-list__body">
                            <span className="mz-list__title">
                              {switching ? t('auth:signed_in_as', { name: user?.display_name ?? '' }) : entry.displayName}
                            </span>
                            {!switching && !entry.ticket ? (
                              <span className="mz-caption">{t('auth:password')}</span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    ),
                  )}
                </ul>
              </div>
            ) : null}

            <Button variant="ghost" block onClick={() => void signOut()}>
              {t('auth:sign_out')}
            </Button>

            <LanguageChips />
          </div>
        </Card>
      </main>
    </div>
  );
}

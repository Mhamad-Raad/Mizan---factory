import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Chip, TextField } from '@mizan/ui';
import { ApiError, apiRequest } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { passwordChangeError } from '../lib/signInError.js';
import { QueryStates } from '../components/states.js';
import { useApp, useFormatter } from '../lib/store.js';
import { recordName } from '../lib/record-names.js';

interface Profile {
  id: string;
  display_name: string;
  username: string;
  phone: string | null;
  role: 'admin' | 'employee';
  version: number;
  last_login_at?: string | null;
}

interface MyAction {
  id: string;
  occurred_at: string;
  action: string;
  entity_type: string;
  entity_label: string;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase() || '·';
}

/**
 * Me (client review): the signed-in person's own page, opened from the account menu — who they
 * are, the name and phone they may change themselves, their password, and what they did lately.
 * Username and role stay with the admin (Users); the look of the app stays in Settings.
 */
export function MePage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const profile = useQuery({ queryKey: ['me', 'profile'], queryFn: () => apiRequest<Profile>('/me/profile') });
  const recent = useQuery({
    queryKey: ['history', 'me', 'recent'],
    queryFn: () => apiRequest<{ items: MyAction[] }>('/history/me?sessions=false&limit=8'),
  });

  usePageTitle(t('settings:me_title'));
  const data = profile.data;
  // Kept here, not in the form: the form starts afresh after a save, the confirmation should not.
  const [saved, setSaved] = useState(false);

  return (
    <div className="mz-stack mz-me">
      <QueryStates query={profile}>
        {data ? (
          <>
            <Card className="mz-me__head">
              <span className="mz-me__avatar" aria-hidden="true">
                {initialsOf(data.display_name)}
              </span>
              <div className="mz-stack" style={{ gap: 'var(--space-1)' }}>
                <h2 className="mz-title">
                  <bdi>{data.display_name}</bdi>
                </h2>
                <span className="mz-caption" dir="ltr">
                  @{data.username}
                  {data.phone ? ` · ${data.phone}` : ''}
                </span>
                <span>
                  <Chip tone={data.role === 'admin' ? 'primary' : 'neutral'}>
                    {data.role === 'admin' ? t('glossary:admin') : t('glossary:employee')}
                  </Chip>
                </span>
              </div>
            </Card>

            <div className="mz-me__grid">
              {/* Keyed by version: after a save the form starts again from what was stored. */}
              <ProfileCard key={data.version} profile={data} saved={saved} onSaved={setSaved} />
              <PasswordCard />
            </div>
          </>
        ) : null}
      </QueryStates>

      <Card>
        <div className="mz-row mz-row--between">
          <h2 className="mz-heading">{t('settings:me_recent')}</h2>
          <Link to="/history?preset=all" className="mz-button mz-button--ghost">
            {t('settings:me_all_history')}
          </Link>
        </div>
        <QueryStates query={recent} isEmpty={(recent.data?.items.length ?? 0) === 0} emptyTitle={t('settings:me_no_recent')} skeletonLines={3}>
          <ul className="mz-list">
            {(recent.data?.items ?? []).map((row) => (
              <li key={row.id} className="mz-list__item">
                <span className="mz-list__body">
                  <span className="mz-list__title">
                    {t(`history:action.${row.action}`, { defaultValue: row.action })} ·{' '}
                    <bdi>{recordName(row.entity_type, row.entity_label, t, formatter.identifier)}</bdi>
                  </span>
                  <span className="mz-caption">{formatter.timestamp(new Date(row.occurred_at))}</span>
                </span>
              </li>
            ))}
          </ul>
        </QueryStates>
      </Card>
    </div>
  );
}

/** The two things anyone may change about themselves: their name and their phone. */
function ProfileCard({
  profile,
  saved,
  onSaved,
}: {
  profile: Profile;
  saved: boolean;
  onSaved: (saved: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const user = useApp((state) => state.user);
  const [name, setName] = useState(profile.display_name);
  const [phone, setPhone] = useState(profile.phone ?? '');
  const setSaved = onSaved;

  const save = useMutation({
    mutationFn: () =>
      apiRequest<Profile>('/me/profile', {
        method: 'PATCH',
        body: { display_name: name.trim(), phone: phone.trim() || null, version: profile.version },
      }),
    onSuccess: async (updated) => {
      setSaved(true);
      // The name in the sidebar is the session's: it changes the moment the name does.
      if (user) useApp.setState({ user: { ...user, display_name: updated.display_name } });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });

  const changed = name.trim() !== profile.display_name || (phone.trim() || null) !== (profile.phone ?? null);
  const error =
    save.error instanceof ApiError ? t(save.error.messageKey, { defaultValue: t('errors:VALIDATION_FAILED') }) : null;

  return (
    <Card>
      <form
        className="mz-stack"
        onSubmit={(event) => {
          event.preventDefault();
          setSaved(false);
          save.mutate();
        }}
      >
        <div>
          <h2 className="mz-heading">{t('settings:me_profile')}</h2>
          <p className="mz-caption">{t('settings:me_profile_hint')}</p>
        </div>
        <TextField
          label={t('settings:me_name')}
          value={name}
          maxLength={120}
          required
          autoComplete="name"
          onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
          }}
        />
        <TextField
          label={t('settings:me_phone')}
          value={phone}
          maxLength={32}
          type="tel"
          inputMode="tel"
          dir="ltr"
          autoComplete="tel"
          hint={t('settings:me_phone_hint')}
          onChange={(event) => {
            setPhone(event.target.value);
            setSaved(false);
          }}
        />
        {error ? (
          <p className="mz-field__error" role="alert">
            {error}
          </p>
        ) : null}
        {saved ? <p className="mz-muted">{t('settings:me_saved')}</p> : null}
        <Button type="submit" loading={save.isPending} disabled={!changed || name.trim() === ''}>
          {t('settings:me_save')}
        </Button>
      </form>
    </Card>
  );
}

/** The password, asked for twice, after the current one (FR-1102). */
function PasswordCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () => apiRequest('/auth/change-password', { method: 'POST', body: { current, new: next } }),
    onSuccess: async () => {
      setMessage(t('auth:password_changed'));
      setError(null);
      setCurrent('');
      setNext('');
      setRepeat('');
      // The change moved the account's version: the profile form must start from the new one,
      // or its next save is refused as somebody else's edit.
      await queryClient.invalidateQueries({ queryKey: ['me', 'profile'] });
    },
    onError: (caught) => {
      setMessage(null);
      setError(passwordChangeError(t, caught));
    },
  });

  const mismatch = repeat.length > 0 && repeat !== next;

  return (
    <Card>
      <form
        className="mz-stack"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          change.mutate();
        }}
      >
        <div>
          <h2 className="mz-heading">{t('settings:me_password')}</h2>
          <p className="mz-caption">{t('settings:me_password_hint')}</p>
        </div>
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
        <Button type="submit" loading={change.isPending} disabled={!current || !next || repeat !== next}>
          {t('auth:change_password')}
        </Button>
      </form>
    </Card>
  );
}

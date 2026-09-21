import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  EXTRAS,
  PAGES,
  PERMISSIONS,
  PRESETS,
  applyExtra,
  applyPreset,
  diffSets,
  extraState,
  isCustomisedBeyondExtras,
  setKey,
} from '@mizan/permissions';
import type { ExtraKey, PresetKey } from '@mizan/permissions';
import { Button, Card, Chip, ErrorState, SegmentedControl, Skeleton, Tabs, TextField, Toggle } from '@mizan/ui';
import { ApiError, apiRequest } from '../lib/api.js';
import { AppShell } from '../components/AppShell.js';
import { QueryStates } from '../components/states.js';
import { useFormatter } from '../lib/store.js';

interface UserDetail {
  id: string;
  username: string;
  display_name: string;
  phone: string | null;
  role: 'admin' | 'employee';
  is_active: boolean;
  preset_key: PresetKey | null;
  last_login_at: string | null;
  version: number;
}

interface AuditRow {
  id: string;
  occurred_at: string;
  action: string;
  entity_label: string;
  note: string | null;
}

type TabKey = 'details' | 'permissions' | 'sessions' | 'activity';

export function UserDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabKey>('details');

  const user = useQuery({
    queryKey: ['user', id],
    queryFn: () => apiRequest<UserDetail>(`/users/${id}`),
  });

  if (user.isPending) {
    return (
      <AppShell title={t('users:title')}>
        <Skeleton lines={8} />
      </AppShell>
    );
  }
  if (user.isError || !user.data) {
    return (
      <AppShell title={t('users:title')}>
        <ErrorState title={t('common:not_found_title')} body={t('common:not_found_body')} />
      </AppShell>
    );
  }

  return (
    <AppShell title={user.data.display_name}>
      <div className="mz-stack">
        <Tabs
          label={t('users:title')}
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'details', label: t('users:tab_details') },
            { value: 'permissions', label: t('users:tab_permissions') },
            { value: 'sessions', label: t('settings:sessions') },
            { value: 'activity', label: t('users:tab_activity') },
          ]}
        />
        {tab === 'details' ? <DetailsTab user={user.data} /> : null}
        {tab === 'permissions' ? <PermissionsTab user={user.data} /> : null}
        {tab === 'sessions' ? <SessionsTab userId={user.data.id} /> : null}
        {tab === 'activity' ? <ActivityTab userId={user.data.id} /> : null}
      </div>
    </AppShell>
  );
}

function DetailsTab({ user }: { user: UserDetail }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(user.display_name);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      apiRequest<UserDetail>(`/users/${user.id}`, {
        method: 'PATCH',
        body: { display_name: displayName, version: user.version },
      }),
    onSuccess: async () => {
      setNotice(t('common:copied'));
      await queryClient.invalidateQueries({ queryKey: ['user', user.id] });
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (caught: unknown) => {
      // The last-admin rules are explained inline rather than as a bare failure (spec 3.3).
      if (caught instanceof ApiError && caught.code === 'LAST_ADMIN') {
        setError(
          caught.params.reason === 'self_role' ? t('users:cannot_change_own_role') : t('errors:LAST_ADMIN'),
        );
      } else if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') {
        setError(t('common:conflict_title'));
      } else setError(t('errors:INTERNAL'));
    },
  });

  const setActive = useMutation({
    mutationFn: (next: boolean) =>
      apiRequest(`/users/${user.id}/${next ? 'reactivate' : 'deactivate'}`, {
        method: 'POST',
        body: { version: user.version },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['user', user.id] });
    },
    onError: (caught: unknown) => {
      if (caught instanceof ApiError && caught.code === 'LAST_ADMIN') {
        setError(
          caught.params.reason === 'self_deactivate'
            ? t('users:cannot_deactivate_self')
            : t('errors:LAST_ADMIN'),
        );
      } else setError(t('errors:INTERNAL'));
    },
  });

  const resetPassword = useMutation({
    mutationFn: () =>
      apiRequest<{ temporary_password: string }>(`/users/${user.id}/reset-password`, { method: 'POST' }),
    onSuccess: (response) => setTemporaryPassword(response.temporary_password),
  });

  return (
    <Card>
      <div className="mz-stack">
        <TextField
          label={t('users:display_name')}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <p className="mz-muted" dir="ltr">
          {user.username}
        </p>
        <p className="mz-caption">
          {t('users:last_sign_in')}:{' '}
          {user.last_login_at ? formatter.timestamp(new Date(user.last_login_at)) : t('users:never_signed_in')}
        </p>

        {error ? (
          <p className="mz-field__error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? <p className="mz-muted">{notice}</p> : null}

        <Button block loading={save.isPending} onClick={() => save.mutate()}>
          {t('common:save')}
        </Button>

        <Button
          variant="secondary"
          block
          loading={setActive.isPending}
          onClick={() => setActive.mutate(!user.is_active)}
        >
          {user.is_active ? t('users:deactivate') : t('users:reactivate')}
        </Button>

        <Button variant="secondary" block loading={resetPassword.isPending} onClick={() => resetPassword.mutate()}>
          {t('users:reset_password')}
        </Button>

        {temporaryPassword ? (
          <div className="mz-banner">
            <span>
              {t('auth:temporary_password')}:{' '}
              <strong dir="ltr" data-tabular>
                {temporaryPassword}
              </strong>{' '}
              — {t('auth:temporary_password_once')} {t('users:sessions_ended')}
            </span>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * The permissions editor in **simple mode** (FR-204, wireframe 3.4.4): a preset and the six
 * everyday extras, each of which can be on, off or *partly* on. The Advanced grid is I5, and
 * the screen says so rather than pretending the set is fully editable here.
 */
function PermissionsTab({ user }: { user: UserDetail }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const permissions = useQuery({
    queryKey: ['user-permissions', user.id],
    queryFn: () => apiRequest<{ keys: string[]; preset_key: PresetKey | null }>(`/users/${user.id}/permissions`),
  });

  /**
   * The saved set is the source of truth; `draft` holds the admin's unsaved edits and is
   * cleared on save. Copying the query into state with an effect would silently keep showing
   * a stale set after a refetch, which on a permissions screen is the wrong kind of wrong.
   */
  const [draft, setDraft] = useState<{ keys: string[]; preset: PresetKey | 'none' } | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<string | null>(null);

  const keys = draft?.keys ?? permissions.data?.keys ?? null;
  const preset = draft?.preset ?? permissions.data?.preset_key ?? 'none';

  const save = useMutation({
    mutationFn: () =>
      apiRequest(`/users/${user.id}/permissions`, {
        method: 'POST',
        body: { keys: keys ?? [], preset_key: preset === 'none' ? null : preset },
      }),
    onSuccess: async () => {
      setDraft(null);
      setNotes([]);
      await queryClient.invalidateQueries({ queryKey: ['user-permissions', user.id] });
    },
  });

  const changeCount = useMemo(() => {
    if (!permissions.data || !keys) return 0;
    const diff = diffSets(permissions.data.keys, keys);
    return diff.granted.length + diff.revoked.length;
  }, [permissions.data, keys]);

  if (user.role === 'admin') {
    return (
      <Card>
        <p>{t('glossary:admin')} — {t('permissions:simple_mode')}</p>
        <p className="mz-muted">{t('errors:field.required')}</p>
      </Card>
    );
  }

  if (permissions.isPending || !keys) return <Skeleton lines={8} />;

  const customised = isCustomisedBeyondExtras(keys, preset === 'none' ? null : preset);

  return (
    <Card>
      <div className="mz-stack">
        <SegmentedControl
          label={t('glossary:preset')}
          value={preset}
          onChange={(next) => {
            const applied = next === 'none' ? { keys: new Set(keys) } : applyPreset(keys, next);
            setDraft({ keys: [...applied.keys], preset: next });
            setNotes([]);
          }}
          options={[
            { value: 'sales', label: t('permissions:preset.sales') },
            { value: 'warehouse', label: t('permissions:preset.warehouse') },
            { value: 'accountant', label: t('permissions:preset.accountant') },
            { value: 'none', label: t('permissions:preset.none') },
          ]}
        />

        <h3 className="mz-heading">{t('permissions:extras')}</h3>
        {EXTRAS.map((extra) => {
          const state = extraState(keys, extra.key as ExtraKey);
          return (
            <Toggle
              key={extra.key}
              label={t(`permissions:extra.${extra.key}`)}
              hint={state === 'partly' ? t('permissions:state_partly') : undefined}
              checked={state === 'on' ? true : state === 'partly' ? 'mixed' : false}
              onChange={(next) => {
                const result = applyExtra(keys, extra.key as ExtraKey, next);
                if (result.blockedBy) {
                  setBlocked(t('permissions:blocked_by', { keys: result.blockedBy.join(', ') }));
                  return;
                }
                setBlocked(null);
                setDraft({ keys: [...result.keys], preset });
                setNotes([
                  ...(result.alsoGranted.length > 0
                    ? [t('permissions:also_granted', { keys: result.alsoGranted.join(', ') })]
                    : []),
                  ...(result.alsoRevoked.length > 0
                    ? [t('permissions:also_revoked', { keys: result.alsoRevoked.join(', ') })]
                    : []),
                ]);
              }}
            />
          );
        })}

        {blocked ? (
          <p className="mz-field__error" role="alert">
            {blocked}
          </p>
        ) : null}
        {notes.map((note) => (
          <p key={note} className="mz-field__hint">
            {note}
          </p>
        ))}

        {customised ? <Chip tone="warning" icon="warning">{t('permissions:customised_in_advanced')}</Chip> : null}

        {/* The full grid, folded away (FR-204, wireframe 3.4.4): the simple editor covers the
            three roles this factory has, and the grid is for the rare one it does not. */}
        <details className="mz-disclosure">
          <summary className="mz-disclosure__summary">{t('settings:advanced_permissions')}</summary>
          <p className="mz-caption">{t('settings:advanced_permissions_hint')}</p>
          <PermissionGrid
            keys={keys}
            onChange={(next, note) => {
              setBlocked(null);
              setDraft({ keys: next, preset });
              setNotes(note ? [note] : []);
            }}
          />
        </details>

        <div className="mz-row mz-row--between">
          <span className="mz-muted">{t('permissions:n_changes', { count: changeCount })}</span>
          <Button
            loading={save.isPending}
            disabled={changeCount === 0 && preset === (permissions.data?.preset_key ?? 'none')}
            onClick={() => save.mutate()}
          >
            {t('permissions:save')}
          </Button>
        </div>

        <p className="mz-caption">
          {PRESETS[preset === 'none' ? 'sales' : preset] && preset !== 'none'
            ? `${t('glossary:preset')}: ${t(`permissions:preset.${preset}`)}`
            : ''}
        </p>
      </div>
    </Card>
  );
}

/**
 * Every key, grouped by the screen it belongs to (FR-204, wireframe 3.4.4).
 *
 * Turning a key on turns on what it implies, and the row says so — an admin who grants "record
 * a payment" should see that "see customer balances" came with it rather than discover it
 * later. Turning one off takes away the keys that cannot stand without it, for the same reason.
 */
function PermissionGrid({
  keys,
  onChange,
}: {
  keys: readonly string[];
  onChange: (keys: string[], note: string | null) => void;
}) {
  const { t } = useTranslation();
  const granted = useMemo(() => new Set(keys), [keys]);

  return (
    <div className="mz-stack">
      {PAGES.map((page) => (
        <div key={page} className="mz-stack" style={{ gap: 'var(--space-2)' }}>
          <h4 className="mz-caption">{t(`permissions:page.${page}`, { defaultValue: page })}</h4>
          {PERMISSIONS.filter((definition) => definition.page === page).map((definition) => {
            const on = granted.has(definition.key);
            return (
              <Toggle
                key={definition.key}
                label={t(`permissions:${definition.labelKey}`, { defaultValue: definition.key })}
                hint={
                  definition.implies.length > 0
                    ? t('settings:implied_by', { key: definition.implies.join(', ') })
                    : undefined
                }
                checked={on}
                onChange={(next) => {
                  const result = setKey(keys, definition.key, next);
                  const alsoGranted =
                    result.alsoGranted.length > 0
                      ? t('permissions:also_granted', { keys: result.alsoGranted.join(', ') })
                      : null;
                  const alsoRevoked =
                    result.alsoRevoked.length > 0
                      ? t('permissions:also_revoked', { keys: result.alsoRevoked.join(', ') })
                      : null;
                  onChange([...result.keys], alsoGranted ?? alsoRevoked);
                }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

interface SessionRow {
  id: string;
  is_locked: boolean;
  is_shared_device: boolean;
  auth_method: 'password' | 'ticket_pin';
  device_label: string | null;
  last_seen_at: string;
}

interface TicketRow {
  id: string;
  device_label: string | null;
  is_shared_device: boolean;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}

/**
 * The Sessions tab (FR-1304, spec 2.8): where this employee is signed in, and which browsers
 * may sign them in with a PIN. Both answer the same question — who can act as this person right
 * now, and from what — so they sit on one screen, and both can be taken away from here.
 */
function SessionsTab({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  const sessions = useQuery({
    queryKey: ['user-sessions', userId],
    queryFn: () =>
      apiRequest<{ sessions: SessionRow[]; device_tickets: TicketRow[] }>(`/users/${userId}/sessions`),
  });

  const revokeSession = useMutation({
    mutationFn: (sessionId: string) =>
      apiRequest(`/users/${userId}/sessions/${sessionId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['user-sessions', userId] });
    },
  });

  const revokeTickets = useMutation({
    mutationFn: () => apiRequest(`/users/${userId}/device-tickets`, { method: 'DELETE' }),
    onSuccess: async () => {
      setMessage(t('settings:pin_devices_revoked'));
      await queryClient.invalidateQueries({ queryKey: ['user-sessions', userId] });
    },
  });

  const live = (sessions.data?.device_tickets ?? []).filter((ticket) => ticket.revoked_at === null);

  return (
    <QueryStates query={sessions} skeletonLines={6}>
      <div className="mz-stack">
        <Card>
          <div className="mz-stack">
            <h3 className="mz-heading">{t('settings:sessions')}</h3>
            <p className="mz-caption">{t('settings:sessions_hint')}</p>
            {(sessions.data?.sessions ?? []).length === 0 ? (
              <p className="mz-muted">{t('history:empty')}</p>
            ) : null}
            {(sessions.data?.sessions ?? []).map((session) => (
              <div key={session.id} className="mz-stack" style={{ gap: 'var(--space-1)' }}>
                <span className="mz-list__title">
                  {session.device_label ?? t('settings:session_unlabelled')}
                </span>
                <span className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  {session.is_shared_device ? <Chip>{t('settings:session_shared')}</Chip> : null}
                  {session.is_locked ? <Chip>{t('settings:session_locked')}</Chip> : null}
                  <Chip tone={session.auth_method === 'ticket_pin' ? 'warning' : 'neutral'}>
                    {session.auth_method === 'ticket_pin' ? t('auth:pin') : t('auth:password')}
                  </Chip>
                </span>
                <span className="mz-caption">
                  {t('settings:session_last_seen', {
                    when: formatter.timestamp(new Date(session.last_seen_at)),
                  })}
                </span>
                <Button
                  variant="ghost"
                  loading={revokeSession.isPending}
                  onClick={() => revokeSession.mutate(session.id)}
                >
                  {t('settings:session_revoke')}
                </Button>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <div className="mz-stack">
            <h3 className="mz-heading">{t('settings:pin_devices')}</h3>
            {live.length === 0 ? <p className="mz-muted">{t('settings:pin_devices_empty')}</p> : null}
            {(sessions.data?.device_tickets ?? []).map((ticket) => (
              <div key={ticket.id} className="mz-stack" style={{ gap: 'var(--space-1)' }}>
                <span className="mz-list__title">
                  {ticket.device_label ?? t('settings:session_unlabelled')}
                </span>
                <span className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  {ticket.is_shared_device ? <Chip>{t('settings:session_shared')}</Chip> : null}
                  {ticket.revoked_at ? (
                    <Chip tone="warning">{t('settings:pin_device_revoked')}</Chip>
                  ) : (
                    <Chip>
                      {t('settings:pin_device_expires', { date: formatter.date(ticket.expires_at.slice(0, 10)) })}
                    </Chip>
                  )}
                </span>
              </div>
            ))}
            {message ? <p className="mz-muted">{message}</p> : null}
            {live.length > 0 ? (
              <Button
                variant="secondary"
                block
                loading={revokeTickets.isPending}
                onClick={() => revokeTickets.mutate()}
              >
                {t('settings:pin_devices_revoke')}
              </Button>
            ) : null}
          </div>
        </Card>
      </div>
    </QueryStates>
  );
}

function ActivityTab({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const activity = useQuery({
    queryKey: ['user-activity', userId],
    queryFn: () => apiRequest<{ items: AuditRow[] }>(`/history?done_by=${userId}&limit=50`),
  });

  if (activity.isPending) return <Skeleton lines={6} />;
  if (activity.isError) return <ErrorState title={t('common:error_title')} body={t('common:error_body')} />;
  if (!activity.data || activity.data.items.length === 0) return <Card>{t('history:empty')}</Card>;

  return (
    <ul className="mz-list">
      {activity.data.items.map((row) => (
        <li key={row.id} className="mz-list__item">
          <span className="mz-list__body">
            <span className="mz-list__title">
              {t(`history:action.${row.action}`, row.action)} · {row.entity_label}
            </span>
            <span className="mz-caption">{formatter.timestamp(new Date(row.occurred_at))}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

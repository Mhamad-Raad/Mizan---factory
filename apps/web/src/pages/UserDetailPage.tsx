import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { diffSets } from '@mizan/permissions';
import type { PresetKey } from '@mizan/permissions';
import {
  Button,
  Card,
  Chip,
  ErrorState,
  Icon,
  SegmentedControl,
  Skeleton,
  StickyFooter,
  Tabs,
  TextField,
} from '@mizan/ui';
import { ApiError, apiRequest } from '../lib/api.js';
import { PermissionEditor } from '../components/PermissionEditor.js';
import type { PermissionSelection } from '../components/PermissionEditor.js';
import { AuditDiff } from '../components/AuditDiff.js';
import { useIsWide } from '../lib/wide.js';
import { usePageTitle } from '../lib/page-title.js';
import { QueryStates } from '../components/states.js';
import { useApp, useFormatter } from '../lib/store.js';

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
  entity_type: string;
  entity_label: string;
  /** Field by field, old → new: what the row actually says happened (rule 3). */
  changes: Record<string, unknown> | null;
  note: string | null;
}

type TabKey = 'details' | 'sessions' | 'activity';

export function UserDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabKey>('details');

  const user = useQuery({
    queryKey: ['user', id],
    queryFn: () => apiRequest<UserDetail>(`/users/${id}`),
  });

  usePageTitle(user.data?.display_name ?? t('users:title'));

  if (user.isPending) {
    return (
      <>
        <Skeleton lines={8} />
      </>
    );
  }
  if (user.isError || !user.data) {
    return (
      <>
        <ErrorState title={t('common:not_found_title')} body={t('common:not_found_body')} />
      </>
    );
  }

  return (
    <>
      <div className="mz-stack">
        <Tabs
          label={t('users:title')}
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'details', label: t('users:tab_details') },
            { value: 'sessions', label: t('settings:sessions') },
            { value: 'activity', label: t('users:tab_activity') },
          ]}
        />
        {tab === 'details' ? <DetailsTab user={user.data} /> : null}
        {tab === 'sessions' ? <SessionsTab userId={user.data.id} /> : null}
        {tab === 'activity' ? <ActivityTab userId={user.data.id} /> : null}
      </div>
    </>
  );
}

/**
 * The same screen as New employee, filled in (the client's note).
 *
 * It used to be a name field and three buttons, with what the employee may *do* on a tab of
 * its own — so an admin changing somebody's job had to remember that the answer was in two
 * places. It is one screen now: the four fields the create form has, the same permission
 * matrix, and one Save that writes whichever of the two actually changed. The account's own
 * actions — deactivate, reset the password — are a separate card, because creating an employee
 * has no such actions and they are not part of "the details".
 */
function DetailsTab({ user }: { user: UserDetail }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const queryClient = useQueryClient();
  const currentUser = useApp((state) => state.user);

  const [displayName, setDisplayName] = useState(user.display_name);
  const [username, setUsername] = useState(user.username);
  const [phone, setPhone] = useState(user.phone ?? '');
  const [role, setRole] = useState<'admin' | 'employee'>(user.role);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);

  const permissions = useQuery({
    queryKey: ['user-permissions', user.id],
    queryFn: () => apiRequest<{ keys: string[]; preset_key: PresetKey | null }>(`/users/${user.id}/permissions`),
    enabled: user.role === 'employee',
  });

  /**
   * The saved set is the source of truth; `draft` holds the admin's unsaved edits and is
   * cleared on save. Copying the query into state with an effect would silently keep showing a
   * stale set after a refetch, which on a permissions screen is the wrong kind of wrong.
   */
  const [draft, setDraft] = useState<PermissionSelection | null>(null);
  const keys = draft?.keys ?? permissions.data?.keys ?? [];
  const preset = draft?.preset ?? permissions.data?.preset_key ?? 'none';

  const detailsChanged =
    displayName !== user.display_name ||
    username !== user.username ||
    (phone || null) !== (user.phone ?? null) ||
    role !== user.role;
  const permissionsChanged = useMemo(() => {
    if (!permissions.data || !draft) return false;
    const diff = diffSets(permissions.data.keys, draft.keys);
    return diff.granted.length + diff.revoked.length > 0 || draft.preset !== (permissions.data.preset_key ?? 'none');
  }, [permissions.data, draft]);

  const save = useMutation({
    mutationFn: async () => {
      setError(null);
      // Details first: a role change decides whether permissions may be written at all.
      if (detailsChanged) {
        await apiRequest<UserDetail>(`/users/${user.id}`, {
          method: 'PATCH',
          body: {
            display_name: displayName,
            username,
            phone: phone || null,
            role,
            version: user.version,
          },
        });
      }
      if (permissionsChanged && role === 'employee') {
        await apiRequest(`/users/${user.id}/permissions`, {
          method: 'POST',
          body: { keys, preset_key: preset === 'none' ? null : preset },
        });
      }
    },
    onSuccess: async () => {
      setDraft(null);
      setNotice(t('users:saved'));
      await queryClient.invalidateQueries({ queryKey: ['user', user.id] });
      await queryClient.invalidateQueries({ queryKey: ['user-permissions', user.id] });
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
      await queryClient.invalidateQueries({ queryKey: ['users'] });
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
    <div className="mz-stack">
      <Card>
        <div className="mz-stack">
          <div className="mz-form-grid">
            <TextField
              label={t('users:display_name')}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
            <TextField
              label={t('users:username')}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              dir="ltr"
            />
            <TextField
              label={t('users:phone')}
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              type="tel"
              inputMode="tel"
            />
            <SegmentedControl
              label={t('users:role')}
              value={role}
              onChange={setRole}
              options={[
                { value: 'employee', label: t('glossary:employee') },
                { value: 'admin', label: t('glossary:admin') },
              ]}
            />
          </div>
          <p className="mz-caption">
            {t('users:last_sign_in')}:{' '}
            {user.last_login_at ? formatter.timestamp(new Date(user.last_login_at)) : t('users:never_signed_in')}
          </p>
        </div>
      </Card>

      {role === 'employee' ? (
        <Card>
          <div className="mz-stack">
            <h2 className="mz-heading">{t('glossary:permissions')}</h2>
            {permissions.isPending ? (
              <Skeleton lines={6} />
            ) : (
              <PermissionEditor
                value={{ keys, preset }}
                onChange={(next) => setDraft({ keys: next.keys, preset: next.preset })}
              />
            )}
          </div>
        </Card>
      ) : (
        <Card>
          {/* An admin holds every key, so there is nothing to choose (FR-105). */}
          <p className="mz-muted">{t('permissions:admin_holds_all')}</p>
        </Card>
      )}

      {error ? (
        <p className="mz-field__error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="mz-muted">{notice}</p> : null}

      <Card>
        <div className="mz-stack">
          <h2 className="mz-heading">{t('users:account')}</h2>
          <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button
              variant="secondary"
              loading={setActive.isPending}
              disabled={user.id === currentUser?.id}
              onClick={() => setActive.mutate(!user.is_active)}
            >
              {user.is_active ? t('users:deactivate') : t('users:reactivate')}
            </Button>
            <Button variant="secondary" loading={resetPassword.isPending} onClick={() => resetPassword.mutate()}>
              {t('users:reset_password')}
            </Button>
          </div>

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
      <StickyFooter>
        <Button
          block
          loading={save.isPending}
          disabled={!detailsChanged && !permissionsChanged}
          onClick={() => save.mutate()}
        >
          {t('common:save')}
        </Button>
      </StickyFooter>
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
/**
 * Where this employee is signed in, and which browsers may sign them in with a PIN (2.8).
 *
 * Small cards rather than a column of stacked rows (the client's note): a session is a device
 * somebody is holding — its name, whether it is shared, whether it is locked, how it signed in
 * and when it was last used — and half a dozen of those read better side by side than as a
 * list where every entry is the width of the screen.
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
        <section className="mz-stack" style={{ gap: 'var(--space-2)' }}>
          <h2 className="mz-heading">{t('settings:sessions')}</h2>
          <p className="mz-caption">{t('settings:sessions_hint')}</p>
          {(sessions.data?.sessions ?? []).length === 0 ? (
            <p className="mz-muted">{t('history:empty')}</p>
          ) : (
            <div className="mz-devices">
              {(sessions.data?.sessions ?? []).map((session) => (
                <article key={session.id} className="mz-device">
                  <span className="mz-device__badge" aria-hidden="true">
                    <Icon name={session.is_shared_device ? 'users' : 'user'} size={20} />
                  </span>
                  <div className="mz-device__body">
                    <h3 className="mz-device__title">
                      <bdi>{session.device_label ?? t('settings:session_unlabelled')}</bdi>
                    </h3>
                    <p className="mz-device__facts">
                      <span>
                        {session.is_shared_device ? t('settings:session_shared') : t('settings:session_personal')}
                      </span>
                      <span>{session.auth_method === 'ticket_pin' ? t('auth:pin') : t('auth:password')}</span>
                      <span>
                        {t('settings:session_last_seen', {
                          when: formatter.timestamp(new Date(session.last_seen_at)),
                        })}
                      </span>
                    </p>
                  </div>
                  <Chip tone={session.is_locked ? 'warning' : 'success'} icon={session.is_locked ? 'lock' : 'check'}>
                    {session.is_locked ? t('settings:session_locked') : t('settings:session_active')}
                  </Chip>
                  <Button
                    variant="ghost"
                    loading={revokeSession.isPending}
                    onClick={() => revokeSession.mutate(session.id)}
                  >
                    {t('settings:session_revoke')}
                  </Button>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="mz-stack" style={{ gap: 'var(--space-2)' }}>
          <h2 className="mz-heading">{t('settings:pin_devices')}</h2>
          {live.length === 0 ? <p className="mz-muted">{t('settings:pin_devices_empty')}</p> : null}
          {(sessions.data?.device_tickets ?? []).length > 0 ? (
            <div className="mz-devices">
              {(sessions.data?.device_tickets ?? []).map((ticket) => (
                <article key={ticket.id} className="mz-device">
                  <span className="mz-device__badge" aria-hidden="true">
                    <Icon name="lock" size={20} />
                  </span>
                  <div className="mz-device__body">
                    <h3 className="mz-device__title">
                      <bdi>{ticket.device_label ?? t('settings:session_unlabelled')}</bdi>
                    </h3>
                    <p className="mz-device__facts">
                      <span>
                        {ticket.is_shared_device ? t('settings:session_shared') : t('settings:session_personal')}
                      </span>
                      {ticket.last_used_at ? (
                        <span>
                          {t('settings:session_last_seen', {
                            when: formatter.timestamp(new Date(ticket.last_used_at)),
                          })}
                        </span>
                      ) : null}
                    </p>
                  </div>
                  {ticket.revoked_at ? (
                    <Chip tone="danger" icon="close">
                      {t('settings:pin_device_revoked')}
                    </Chip>
                  ) : (
                    <Chip tone="success" icon="check">
                      {t('settings:pin_device_expires', {
                        date: formatter.date(ticket.expires_at.slice(0, 10)),
                      })}
                    </Chip>
                  )}
                </article>
              ))}
            </div>
          ) : null}
          {message ? <p className="mz-muted">{message}</p> : null}
          {live.length > 0 ? (
            <div className="mz-row">
              <Button variant="secondary" loading={revokeTickets.isPending} onClick={() => revokeTickets.mutate()}>
                {t('settings:pin_devices_revoke')}
              </Button>
            </div>
          ) : null}
        </section>
      </div>
    </QueryStates>
  );
}

/**
 * What this employee has done: when, what kind of action, to which record, and what changed
 * (the client's note) — the same four questions the History page answers, asked of one person.
 *
 * Paged by **keyset**, not by offset: each page carries the timestamp and id of its last row
 * and the next asks for "older than that", which the index answers in the same time whether
 * the employee has done fifty things or five million (the first page of four million audit rows
 * measures 4.4 ms). A page is twenty-five rows and the button asks for the next one — nothing
 * here can ask the server for everything somebody has ever done.
 */
function ActivityTab({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const wide = useIsWide();

  const activity = useInfiniteQuery({
    queryKey: ['user-activity', userId],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ done_by: userId, limit: '25' });
      if (pageParam) params.set('cursor', String(pageParam));
      return apiRequest<{ items: AuditRow[]; next_cursor: string | null }>(`/history?${params.toString()}`);
    },
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });

  const rows = activity.data?.pages.flatMap((page) => page.items) ?? [];
  const action = (row: AuditRow) => t(`history:action.${row.action}`, { defaultValue: row.action });
  const kind = (row: AuditRow) => t(`history:entity.${row.entity_type}`, { defaultValue: row.entity_type });
  const hasDetail = (row: AuditRow) => Boolean(row.changes && Object.keys(row.changes).length > 0) || Boolean(row.note);

  return (
    <QueryStates query={activity} isEmpty={rows.length === 0} emptyTitle={t('history:empty')} skeletonLines={8}>
      <div className="mz-stack">
        {wide ? (
          /* An activity row leads nowhere — it is a record of something that happened, not a
             link to a screen — so this is a plain table rather than `DataList`. */
          <div className="mz-table-wrap">
            <table className="mz-table">
              <thead>
                <tr>
                  <th scope="col">{t('common:date')}</th>
                  <th scope="col">{t('history:action_column')}</th>
                  <th scope="col">{t('users:record')}</th>
                  <th scope="col">{t('users:what_changed')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{formatter.timestamp(new Date(row.occurred_at))}</td>
                    <td>
                      <Chip tone={toneOfAction(row.action)}>{action(row)}</Chip>
                    </td>
                    <td>
                      <span className="mz-cell__body">
                        <bdi>{row.entity_label}</bdi>
                        <span className="mz-caption">{kind(row)}</span>
                      </span>
                    </td>
                    <td>
                      {row.changes && Object.keys(row.changes).length > 0 ? (
                        <AuditDiff changes={row.changes} note={row.note} />
                      ) : row.note ? (
                        <span className="mz-caption">{row.note}</span>
                      ) : (
                        <span className="mz-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          /*
           * On a tablet and below: what happened, when, to which record — and the detail behind
           * a disclosure. Pouring every diff into every row made twenty-five sign-ins into a
           * wall of "Device ticket / Shared device / No", which is the client's "horrible".
           */
          <div className="mz-entries">
            {rows.map((row) => (
              <article key={row.id} className="mz-entry">
                <div className="mz-entry__head">
                  <Chip tone={toneOfAction(row.action)}>{action(row)}</Chip>
                  <span className="mz-entry__when">{formatter.timestamp(new Date(row.occurred_at))}</span>
                </div>
                <p className="mz-entry__record">
                  <bdi>{row.entity_label}</bdi> <span className="mz-entry__kind">· {kind(row)}</span>
                </p>
                {hasDetail(row) ? (
                  <details className="mz-entry__details">
                    <summary className="mz-entry__summary">{t('users:what_changed')}</summary>
                    <div className="mz-entry__body">
                      {row.changes && Object.keys(row.changes).length > 0 ? (
                        <AuditDiff changes={row.changes} note={row.note} />
                      ) : (
                        <p className="mz-caption">{row.note}</p>
                      )}
                    </div>
                  </details>
                ) : null}
              </article>
            ))}
          </div>
        )}

        {activity.hasNextPage ? (
          <div className="mz-row">
            <Button
              variant="secondary"
              loading={activity.isFetchingNextPage}
              onClick={() => void activity.fetchNextPage()}
            >
              {t('common:more')}
            </Button>
          </div>
        ) : null}
      </div>
    </QueryStates>
  );
}

/** A void reads as a warning, a creation as ordinary: colour is never the only carrier (NFR-10). */
function toneOfAction(action: string): 'neutral' | 'warning' | 'danger' {
  if (action === 'void' || action === 'delete') return 'danger';
  if (action === 'reverse' || action === 'lockout' || action === 'login_failed') return 'warning';
  return 'neutral';
}

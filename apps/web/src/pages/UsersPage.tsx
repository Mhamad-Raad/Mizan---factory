import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Avatar, Chip, Icon, TextField, Toggle } from '@mizan/ui';
import { PRESETS } from '@mizan/permissions';
import type { PresetKey } from '@mizan/permissions';
import { apiRequest } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { useFormatter } from '../lib/store.js';
import { DataList } from '../components/DataList.js';
import { QueryStates } from '../components/states.js';

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  phone: string | null;
  role: 'admin' | 'employee';
  is_active: boolean;
  must_change_password: boolean;
  has_pin: boolean;
  last_login_at: string | null;
  preset_key: string | null;
}

/**
 * Who works here, and what the admin needs to know at a glance (FR-206).
 *
 * This page is the admin's alone — the route is `@AdminOnly` and the sidebar does not offer it
 * to anybody else — so it is where an employee is created and where what they may do is
 * changed. The list itself answers four questions without opening anybody: who they are, how to
 * reach them, what they can do, and whether they have ever signed in. On a desktop that is a
 * table; on a phone the same four in a card (`DataList`).
 */
export function UsersPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [query, setQuery] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);

  const users = useQuery({
    queryKey: ['users', query, includeInactive],
    queryFn: () =>
      apiRequest<{ items: UserRow[]; total: number }>(
        `/users?q=${encodeURIComponent(query)}&include_inactive=${includeInactive}`,
      ),
  });

  usePageTitle(t('users:title'));
  const rows = users.data?.items ?? [];

  /** What they may do, in the words the permission editor uses: a preset, or a custom set. */
  const roleOf = (user: UserRow): string => {
    if (user.role === 'admin') return t('glossary:admin');
    const preset = user.preset_key ? PRESETS[user.preset_key as PresetKey] : null;
    return preset ? t(`permissions:preset.${preset.key}`) : t('permissions:preset.none');
  };

  const signedIn = (user: UserRow) =>
    user.last_login_at ? formatter.timestamp(new Date(user.last_login_at)) : t('users:never_signed_in');

  /**
   * The column always says something, because a blank cell in a table reads as missing data
   * rather than as "nothing to report". Whether they are an admin is the Role column's to say,
   * so it is not repeated here.
   */
  const flags = (user: UserRow) => (
    <span className="mz-row" style={{ gap: 'var(--space-1)', flexWrap: 'wrap' }}>
      {user.is_active ? (
        <Chip tone="success" icon="check">
          {t('common:active')}
        </Chip>
      ) : (
        <Chip tone="danger" icon="close">
          {t('common:deactivated')}
        </Chip>
      )}
      {user.is_active && user.must_change_password ? (
        <Chip tone="warning" icon="warning">
          {t('users:must_change_password')}
        </Chip>
      ) : null}
      {user.has_pin ? <Chip icon="lock">{t('users:pin_set')}</Chip> : null}
    </span>
  );

  return (
    <div className="mz-stack">
      <div className="mz-toolbar">
        <div className="mz-toolbar__filters">
          <div className="mz-toolbar__search">
            <TextField
              label={t('common:search')}
              placeholder={t('users:search_placeholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              type="search"
              inputMode="search"
            />
          </div>
          <Toggle
            label={t('users:show_deactivated')}
            checked={includeInactive}
            onChange={setIncludeInactive}
          />
        </div>

        {/* A link styled as a button, not a button inside a link: nesting them is invalid
            HTML and gives screen readers two overlapping controls. */}
        <Link to="/users/new" className="mz-button mz-button--primary mz-button--block">
          <Icon name="plus" />
          {t('users:new_user')}
        </Link>
      </div>

      <QueryStates query={users} isEmpty={rows.length === 0} emptyTitle={t('users:empty')}>
        <DataList
          rows={rows}
          rowKey={(user) => user.id}
          href={(user) => `/users/${user.id}`}
          columns={[
            {
              header: t('users:display_name'),
              cell: (user) => (
                <span className="mz-cell">
                  <Avatar name={user.display_name} />
                  <span className="mz-cell__body">
                    <bdi>{user.display_name}</bdi>
                    <span className="mz-caption" dir="ltr">
                      <bdi>{user.username}</bdi>
                    </span>
                  </span>
                </span>
              ),
            },
            {
              header: t('users:phone'),
              cell: (user) =>
                user.phone ? (
                  // A number is dialled, so it is a link on a phone and plain text on a desk.
                  <a href={`tel:${user.phone}`} dir="ltr">
                    <bdi>{user.phone}</bdi>
                  </a>
                ) : (
                  <span className="mz-muted">—</span>
                ),
            },
            { header: t('users:role'), cell: roleOf },
            { header: t('users:last_sign_in'), secondary: true, cell: signedIn },
            { header: t('users:status'), cell: flags },
          ]}
          card={(user) => (
            <>
              <Avatar name={user.display_name} />
              <span className="mz-list__body">
                <span className="mz-list__title">
                  <bdi>{user.display_name}</bdi>
                </span>
                <span className="mz-caption" style={{ display: 'block' }} dir="ltr">
                  <bdi>{user.username}</bdi>
                  {user.phone ? ` · ${user.phone}` : ''}
                </span>
                <span className="mz-caption">
                  {roleOf(user)} · {signedIn(user)}
                </span>
              </span>
              {flags(user)}
            </>
          )}
        />
      </QueryStates>

      {rows.length > 0 ? (
        <p className="mz-caption">{t('users:employee_count', { count: users.data?.total ?? rows.length })}</p>
      ) : null}
    </div>
  );
}

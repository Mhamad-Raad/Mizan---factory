import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Avatar, Button, Chip, EmptyState, ErrorState, Icon, Skeleton, TextField, Toggle } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { useFormatter } from '../lib/store.js';

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: 'admin' | 'employee';
  is_active: boolean;
  last_login_at: string | null;
  preset_key: string | null;
}

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

  return (
    <>
      <div className="mz-stack">
        <TextField
          label={t('common:search')}
          placeholder={t('users:search_placeholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          type="search"
          inputMode="search"
        />
        <Toggle
          label={t('users:show_deactivated')}
          checked={includeInactive}
          onChange={setIncludeInactive}
        />

        {/* A link styled as a button, not a button inside a link: nesting them is invalid
            HTML and gives screen readers two overlapping controls. */}
        <Link to="/users/new" className="mz-button mz-button--primary mz-button--block">
          <Icon name="plus" />
          {t('users:new_user')}
        </Link>

        {users.isPending ? <Skeleton lines={6} /> : null}

        {users.isError ? (
          <ErrorState
            title={t('common:error_title')}
            body={t('common:error_body')}
            action={
              <Button variant="secondary" onClick={() => void users.refetch()}>
                {t('common:retry')}
              </Button>
            }
          />
        ) : null}

        {users.data && users.data.items.length === 0 ? <EmptyState title={t('users:empty')} /> : null}

        {users.data && users.data.items.length > 0 ? (
          <ul className="mz-list">
            {users.data.items.map((user) => (
              <li key={user.id}>
                <Link to={`/users/${user.id}`} className="mz-list__item mz-list__item--interactive">
                  <Avatar name={user.display_name} />
                  <span className="mz-list__body">
                    <span className="mz-list__title"><bdi>{user.display_name}</bdi></span>
                    <span className="mz-caption" style={{ display: 'block' }} dir="ltr">
                      <bdi>{user.username}</bdi>
                    </span>
                    <span className="mz-caption">
                      {user.last_login_at
                        ? formatter.timestamp(new Date(user.last_login_at))
                        : t('users:never_signed_in')}
                    </span>
                  </span>
                  <span className="mz-row" style={{ gap: 'var(--space-1)' }}>
                    {user.role === 'admin' ? <Chip tone="primary" icon="shield">{t('glossary:admin')}</Chip> : null}
                    {!user.is_active ? <Chip icon="close">{t('common:deactivated')}</Chip> : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </>
  );
}

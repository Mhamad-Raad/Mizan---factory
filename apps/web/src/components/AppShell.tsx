import { NavLink, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Icon, IconButton, MizanMark } from '@mizan/ui';
import type { IconName } from '@mizan/ui';
import { useApp } from '../lib/store.js';
import { apiRequest } from '../lib/api.js';

interface Destination {
  to: string;
  labelKey: string;
  icon: IconName;
  permission?: string;
  adminOnly?: boolean;
}

/**
 * The bottom tab bar is computed from the permission set (spec 2.6.3): an employee never sees
 * a tab that would refuse them. The first four permitted destinations are shown, then More —
 * the order is the one specification 3.3 gives.
 */
const DESTINATIONS: Destination[] = [
  { to: '/orders', labelKey: 'orders:title', icon: 'orders', permission: 'orders.view' },
  { to: '/materials', labelKey: 'glossary:materials', icon: 'materials', permission: 'materials.view' },
  { to: '/customers', labelKey: 'customers:title', icon: 'customers', permission: 'customers.view' },
  { to: '/users', labelKey: 'glossary:users', icon: 'users', adminOnly: true },
  { to: '/history', labelKey: 'glossary:history', icon: 'history', permission: 'history.view' },
  { to: '/settings', labelKey: 'glossary:settings', icon: 'settings' },
];

/** Four tabs fit a 360 px phone; the rest live behind "More" (spec 3.3). */
const VISIBLE_TABS = 4;

export function AppShell({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useApp((state) => state.user);
  const permissions = useApp((state) => state.permissions);
  const isOnline = useApp((state) => state.isOnline);
  const setLocked = useApp((state) => state.setLocked);

  const permitted = DESTINATIONS.filter((destination) => {
    if (destination.adminOnly) return user?.role === 'admin';
    if (destination.permission) return user?.role === 'admin' || permissions.has(destination.permission);
    return true;
  });
  const visible = permitted.slice(0, VISIBLE_TABS);
  const more = permitted.slice(VISIBLE_TABS);

  const lock = async () => {
    await apiRequest('/auth/lock', { method: 'POST' });
    setLocked(true);
    navigate('/lock');
  };

  return (
    <div className="mz-app">
      <header className="mz-header">
        <MizanMark size={26} />
        <h1 className="mz-header__title">{title}</h1>
        <IconButton icon="lock" label={t('auth:lock_now')} onClick={() => void lock()} />
      </header>

      {!isOnline ? (
        <div className="mz-offline" role="status">
          <Icon name="warning" size={16} />
          {t('common:offline_body')}
        </div>
      ) : null}

      <main className="mz-main">{children}</main>

      <nav className="mz-tabbar" aria-label={t('common:more')}>
        {visible.map((destination) => (
          <NavLink key={destination.to} to={destination.to} className="mz-tabbar__item">
            <Icon name={destination.icon} />
            {t(destination.labelKey)}
          </NavLink>
        ))}
        {more.length > 0 ? (
          <NavLink to={more[0]?.to ?? '/settings'} className="mz-tabbar__item">
            <Icon name="more" />
            {t('common:more')}
          </NavLink>
        ) : null}
      </nav>
    </div>
  );
}

import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BottomSheet, Icon, IconButton, MizanMark } from '@mizan/ui';
import type { IconName } from '@mizan/ui';
import { useApp } from '../lib/store.js';
import { apiRequest } from '../lib/api.js';

type NavGroup = 'daily' | 'records' | 'insight' | 'admin';

interface Destination {
  to: string;
  labelKey: string;
  icon: IconName;
  /** Which part of the work this belongs to; the sidebar groups by it, the phone bar ignores it. */
  group: NavGroup;
  permission?: string;
  adminOnly?: boolean;
}

/** The order the sidebar shows the groups in, with the label above each. */
const GROUPS: { key: NavGroup; labelKey: string }[] = [
  { key: 'daily', labelKey: 'common:nav_daily' },
  { key: 'records', labelKey: 'common:nav_records' },
  { key: 'insight', labelKey: 'common:nav_insight' },
  { key: 'admin', labelKey: 'common:nav_admin' },
];

/**
 * The bottom tab bar is computed from the permission set (spec 2.6.3): an employee never sees
 * a tab that would refuse them. The first four permitted destinations are shown, then More —
 * the order is the one specification 3.3 gives.
 */
const DESTINATIONS: Destination[] = [
  // The phone bar takes the first four of these, in this order, as specification 3.3 fixes it.
  { to: '/orders', labelKey: 'orders:title', icon: 'orders', group: 'daily', permission: 'orders.view' },
  { to: '/materials', labelKey: 'glossary:materials', icon: 'materials', group: 'records', permission: 'materials.view' },
  { to: '/customers', labelKey: 'customers:title', icon: 'customers', group: 'records', permission: 'customers.view' },
  { to: '/companies', labelKey: 'companies:title', icon: 'companies', group: 'records', permission: 'companies.view' },
  { to: '/damages', labelKey: 'damages:tab_label', icon: 'warning', group: 'daily', permission: 'damages.view' },
  { to: '/purchases', labelKey: 'purchases:title', icon: 'purchases', group: 'daily', permission: 'purchases.view' },
  { to: '/reports', labelKey: 'reports:title', icon: 'orders', group: 'insight', permission: 'reports.view' },
  { to: '/dashboard', labelKey: 'dashboard:title', icon: 'materials', group: 'daily', permission: 'dashboard.view' },
  { to: '/search', labelKey: 'search:title', icon: 'search', group: 'insight' },
  { to: '/users', labelKey: 'glossary:users', icon: 'users', group: 'admin', adminOnly: true },
  { to: '/history', labelKey: 'glossary:history', icon: 'history', group: 'insight', permission: 'history.view' },
  { to: '/settings', labelKey: 'glossary:settings', icon: 'settings', group: 'admin' },
];

/**
 * Four tabs fit a 360 px phone; the rest live behind "More" (spec 3.3).
 *
 * On a desktop there is no such shortage, so every destination is in the sidebar and "More"
 * is not rendered at all — the same list, laid out by the stylesheet rather than by a second
 * component, so a destination can never appear in one and be forgotten in the other.
 */
const VISIBLE_TABS = 4;

/**
 * The shell: header, navigation, and a hole where the screen goes.
 *
 * It used to be a component each page wrapped itself in, which meant the page *owned* the
 * chrome — so a screen still loading took the sidebar, the header and the navigation down with
 * it and the whole window blinked on every tab. It is a layout route now: this renders once,
 * outlives every navigation, and only its `children` — the content column — are replaced.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useApp((state) => state.user);
  const permissions = useApp((state) => state.permissions);
  const isOnline = useApp((state) => state.isOnline);
  const setLocked = useApp((state) => state.setLocked);
  const clearSession = useApp((state) => state.clearSession);
  /** The lock screen is for a device other people pick up; a desk does not need it. */
  const isSharedDevice = useApp((state) => state.preferences.sharedDevice);
  const [moreOpen, setMoreOpen] = useState(false);
  const title = useApp((state) => state.pageTitle);
  const collapsed = useApp((state) => state.preferences.sidebarCollapsed ?? false);
  const setPreference = useApp((state) => state.setPreference);

  const permitted = DESTINATIONS.filter((destination) => {
    if (destination.adminOnly) return user?.role === 'admin';
    if (destination.permission) return user?.role === 'admin' || permissions.has(destination.permission);
    return true;
  });
  const visible = permitted.slice(0, VISIBLE_TABS);
  const more = permitted.slice(VISIBLE_TABS);

  const signOut = async () => {
    await apiRequest('/auth/logout', { method: 'POST' });
    clearSession();
    navigate('/login');
  };

  const lock = async () => {
    await apiRequest('/auth/lock', { method: 'POST' });
    setLocked(true);
    navigate('/lock');
  };

  return (
    <div className="mz-app mz-app--shell" data-sidebar={collapsed ? 'collapsed' : 'open'}>
      <header className="mz-header">
        <MizanMark size={26} />
        <h1 className="mz-header__title">
          {/* A name may be Latin inside an RTL header, so it carries its own direction (2.10.6). */}
          <bdi>{title}</bdi>
        </h1>
        {/*
          * The padlock is for a tablet somebody else will pick up, so it is shown on a device
          * marked shared and nowhere else. On a desk it was the only way out of the
          * application, which is why nobody could tell what it was for; signing out now lives
          * in the sidebar, where it belongs.
          */}
        {isSharedDevice ? (
          <IconButton icon="lock" label={t('auth:lock_now')} onClick={() => void lock()} />
        ) : null}
      </header>

      {!isOnline ? (
        <div className="mz-offline" role="status">
          <Icon name="warning" size={16} />
          {t('common:offline_body')}
        </div>
      ) : null}

      <main className="mz-main">{children}</main>

      <nav className="mz-tabbar" aria-label={t('common:more')}>
        {/* ── the sidebar, on a screen with room for one ─────────────────────────── */}
        <div className="mz-sidebar__brand">
          <MizanMark size={24} />
          <span className="mz-sidebar__brand-name">{t('common:app_name')}</span>
        </div>

        {GROUPS.map((group) => {
          const items = permitted.filter((destination) => destination.group === group.key);
          if (items.length === 0) return null;
          return (
            <div key={group.key} className="mz-sidebar__group">
              <p className="mz-sidebar__label">{t(group.labelKey)}</p>
              {items.map((destination) => (
                <NavLink
                  key={destination.to}
                  to={destination.to}
                  className="mz-tabbar__item mz-tabbar__item--sidebar"
                  title={collapsed ? t(destination.labelKey) : undefined}
                >
                  <Icon name={destination.icon} />
                  <span className="mz-tabbar__label">{t(destination.labelKey)}</span>
                </NavLink>
              ))}
            </div>
          );
        })}

        {/* Who is signed in, and the two ways out — which used to exist only on the lock
            screen, so a desktop had no way to sign out at all. */}
        <div className="mz-sidebar__footer">
          <button
            type="button"
            className="mz-tabbar__item mz-tabbar__item--sidebar"
            aria-expanded={!collapsed}
            title={collapsed ? t('common:expand_sidebar') : undefined}
            aria-label={collapsed ? t('common:expand_sidebar') : t('common:collapse_sidebar')}
            onClick={() => setPreference('sidebarCollapsed', !collapsed)}
          >
            {/* Both mirror in RTL by the registry's own rule, so the arrow points at the edge
                the sidebar is about to move to, in either direction (2.10.6 point 2). */}
            <Icon name={collapsed ? 'chevron' : 'back'} />
            <span className="mz-tabbar__label">{t('common:collapse_sidebar')}</span>
          </button>

          <p className="mz-sidebar__label">{t('common:signed_in_as')}</p>
          <p className="mz-sidebar__user">
            <bdi>{user?.display_name ?? ''}</bdi>
          </p>
          {isSharedDevice ? (
            <button
              type="button"
              className="mz-tabbar__item mz-tabbar__item--sidebar"
              title={collapsed ? t('auth:lock_now') : undefined}
              onClick={() => void lock()}
            >
              <Icon name="lock" />
              <span className="mz-tabbar__label">{t('auth:lock_now')}</span>
            </button>
          ) : null}
          <button
            type="button"
            className="mz-tabbar__item mz-tabbar__item--sidebar"
            title={collapsed ? t('auth:sign_out') : undefined}
            onClick={() => void signOut()}
          >
            <Icon name="logout" />
            <span className="mz-tabbar__label">{t('auth:sign_out')}</span>
          </button>
        </div>

        {/* ── the phone bar: four tabs and More (spec 3.3) ───────────────────────── */}
        {visible.map((destination) => (
          <NavLink key={destination.to} to={destination.to} className="mz-tabbar__item mz-tabbar__item--tab">
            <Icon name={destination.icon} />
            {t(destination.labelKey)}
          </NavLink>
        ))}
        {more.length > 0 ? (
          <button
            type="button"
            className="mz-tabbar__item mz-tabbar__item--tab mz-tabbar__more"
            onClick={() => setMoreOpen(true)}
          >
            <Icon name="more" />
            {t('common:more')}
          </button>
        ) : null}
      </nav>

      {moreOpen ? (
        <BottomSheet title={t('common:more')} open onClose={() => setMoreOpen(false)} closeLabel={t('common:close')}>
          <ul className="mz-list">
            {more.map((destination) => (
              <li key={destination.to}>
                <NavLink
                  to={destination.to}
                  className="mz-list__item mz-list__item--interactive"
                  onClick={() => setMoreOpen(false)}
                >
                  <span className="mz-list__body">
                    <span className="mz-list__title">
                      <Icon name={destination.icon} /> {t(destination.labelKey)}
                    </span>
                  </span>
                  <Icon name="chevron" />
                </NavLink>
              </li>
            ))}
          </ul>
        </BottomSheet>
      ) : null}
    </div>
  );
}

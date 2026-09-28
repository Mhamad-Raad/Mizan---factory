import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, ErrorState } from '@mizan/ui';
import { usePermission } from '../lib/store.js';
import { usePageTitle } from '../lib/page-title.js';

/**
 * Navigation items, primary buttons and row actions are **absent**, not disabled, when the
 * user lacks the permission (FR-104). The API refuses them regardless.
 */
export function Can({ permission, children }: { permission: string; children: ReactNode }) {
  return usePermission(permission) ? <>{children}</> : null;
}

/**
 * A screen the user may not open, reached by a link, a bookmark or a typed address (FR-104). It
 * says so — rather than letting the screen ask and show "check your connection" for every
 * refusal — and offers the way to the user's own first page.
 */
export function NoAccess() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Its own name in the header and the tab, not the last page's (review).
  usePageTitle(t('common:no_access_title'));
  return (
    <ErrorState
      title={t('common:no_access_title')}
      body={t('common:forbidden_body')}
      action={<Button onClick={() => navigate('/', { replace: true })}>{t('common:go_home')}</Button>}
    />
  );
}

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, EmptyState, ErrorState, Skeleton } from '@mizan/ui';
import { NetworkError } from '../lib/api.js';

export interface QueryStatesProps {
  query: {
    isPending: boolean;
    isError: boolean;
    error?: unknown;
    refetch: () => void;
  };
  /** True when the request succeeded and there is nothing to show (spec 3.3). */
  isEmpty?: boolean;
  emptyTitle?: string;
  emptyBody?: string;
  emptyAction?: ReactNode;
  skeletonLines?: number;
  children: ReactNode;
}

/**
 * The four states every page owes the user (spec 3.3, Definition of done item 8): a skeleton
 * while loading, an empty state that says what to do next, an error state with Retry, and —
 * when the request never left the device — the offline wording instead of a server error.
 *
 * It lives in one component so no screen can forget one of them.
 */
export function QueryStates({
  query,
  isEmpty,
  emptyTitle,
  emptyBody,
  emptyAction,
  skeletonLines = 6,
  children,
}: QueryStatesProps) {
  const { t } = useTranslation();

  if (query.isPending) return <Skeleton lines={skeletonLines} />;

  if (query.isError) {
    const offline = query.error instanceof NetworkError;
    return (
      <ErrorState
        title={offline ? t('common:offline_title') : t('common:error_title')}
        body={offline ? t('common:offline_body') : t('common:error_body')}
        action={
          <Button variant="secondary" onClick={() => query.refetch()}>
            {t('common:retry')}
          </Button>
        }
      />
    );
  }

  if (isEmpty) {
    return <EmptyState title={emptyTitle ?? t('common:empty_title')} body={emptyBody} action={emptyAction} />;
  }

  return <>{children}</>;
}

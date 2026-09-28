import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, EmptyState, ErrorState, Skeleton } from '@mizan/ui';
import { ApiError, NetworkError } from '../lib/api.js';

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
  /**
   * A skeleton shaped like the finished screen, where the plain lines would be much shorter than
   * what replaces them — the page then jumps as it arrives (layout shift, NFR-03).
   */
  skeleton?: ReactNode;
  children: ReactNode;
}

/**
 * The four states every page owes the user (spec 3.3, Definition of done item 8): a skeleton
 * while loading, an empty state that says what to do next, an error state with Retry, and —
 * when the request never left the device — the offline wording instead of a server error.
 *
 * A refusal is not a failure: 403 says the user may not see this and 404 that it is not there,
 * and neither offers Retry, which would only ask the same question again. Before this a missing
 * permission read "check your connection".
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
  skeleton,
  children,
}: QueryStatesProps) {
  const { t } = useTranslation();

  if (query.isPending) return <>{skeleton ?? <Skeleton lines={skeletonLines} />}</>;

  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 403) {
      return <ErrorState title={t('common:forbidden_title')} body={t('common:forbidden_body')} />;
    }
    if (query.error instanceof ApiError && query.error.status === 404) {
      return <ErrorState title={t('common:not_found_title')} body={t('common:not_found_body')} />;
    }
    const offline = query.error instanceof NetworkError;
    return (
      <ErrorState
        title={offline ? t('common:offline_title') : t('common:error_title')}
        // Nothing is on the screen in place of this, so "showing what was loaded last" is not
        // true here: the page has not been loaded on this device yet.
        body={offline ? t('common:offline_not_loaded') : t('common:error_body')}
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

/** One grey block of a given height, for skeletons shaped like what they stand in for. */
export function SkeletonBlock({ height, width = '100%' }: { height: string; width?: string }) {
  return <div className="mz-skeleton" aria-hidden="true" style={{ blockSize: height, inlineSize: width }} />;
}

/**
 * Rows of a list while it loads, each the height of a finished row (a title and a caption), so
 * the list does not jump when its entries arrive.
 */
export function RowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="mz-stack" aria-hidden="true" style={{ gap: 0 }}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="mz-skeleton-row">
          <SkeletonBlock height="1rem" width="55%" />
          <SkeletonBlock height="0.75rem" width="35%" />
        </div>
      ))}
    </div>
  );
}

/** A card of form fields while it loads: a label and a control each, the size of the real ones. */
export function FieldsSkeleton({ fields = 4, title = true }: { fields?: number; title?: boolean }) {
  return (
    <Card>
      <div className="mz-stack" aria-hidden="true">
        {title ? <SkeletonBlock height="1.25rem" width="40%" /> : null}
        {Array.from({ length: fields }, (_, index) => (
          <div key={index} className="mz-stack" style={{ gap: 'var(--space-1)' }}>
            <SkeletonBlock height="0.875rem" width="30%" />
            <SkeletonBlock height="var(--tap-target)" />
          </div>
        ))}
      </div>
    </Card>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Button, Card, EmptyState, ErrorState, Skeleton } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { AppShell } from '../components/AppShell.js';
import { useApp, useFormatter } from '../lib/store.js';

interface AuditRow {
  id: string;
  occurred_at: string;
  actor_user_id: string | null;
  actor_display_name: string | null;
  action: string;
  entity_type: string;
  entity_label: string;
  changes: Record<string, unknown>;
  note: string | null;
  request_id: string;
  auth_method: string | null;
}

interface DirectoryEntry {
  id: string;
  display_name: string;
}

type DatePreset = 'today' | 'week' | 'month' | 'all';

function rangeFor(preset: DatePreset, today: string): { from?: string; to?: string } {
  if (preset === 'all') return {};
  const date = new Date(`${today}T00:00:00Z`);
  if (preset === 'today') return { from: today, to: today };
  const days = preset === 'week' ? 7 : 30;
  date.setUTCDate(date.getUTCDate() - days);
  return { from: date.toISOString().slice(0, 10), to: today };
}

/**
 * The History page (FR-902). Iteration 0 delivers the plain list with the "done by" and date
 * filters; the "assigned to" filter, entity types and the grouping of edits belong to I4,
 * when there are records to assign and documents to edit.
 */
export function HistoryPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const user = useApp((state) => state.user);
  const permissions = useApp((state) => state.permissions);
  const canSeeEveryone = user?.role === 'admin' || permissions.has('history.view_all');

  const [doneBy, setDoneBy] = useState<string>('');
  const [preset, setPreset] = useState<DatePreset>('today');
  const [expanded, setExpanded] = useState<string | null>(null);

  const directory = useQuery({
    queryKey: ['directory'],
    queryFn: () => apiRequest<DirectoryEntry[]>('/users/directory'),
    enabled: canSeeEveryone,
  });

  const range = rangeFor(preset, formatter.today());
  const history = useInfiniteQuery({
    queryKey: ['history', doneBy, preset],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (doneBy) params.set('done_by', doneBy);
      if (range.from) params.set('from', range.from);
      if (range.to) params.set('to', range.to);
      if (pageParam) params.set('cursor', String(pageParam));
      return apiRequest<{ items: AuditRow[]; next_cursor: string | null }>(`/history?${params.toString()}`);
    },
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });

  const rows = history.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <AppShell title={t('history:title')}>
      <div className="mz-stack">
        <div className="mz-row" role="group" aria-label={t('common:date')}>
          {(['today', 'week', 'month', 'all'] as DatePreset[]).map((option) => (
            <button
              key={option}
              type="button"
              className={`mz-chip${option === preset ? ' mz-chip--primary' : ''}`}
              style={{ minBlockSize: '44px', paddingInline: 'var(--space-3)', cursor: 'pointer', border: 0 }}
              aria-pressed={option === preset}
              onClick={() => setPreset(option)}
            >
              {option === 'today'
                ? t('common:today')
                : option === 'week'
                  ? t('common:this_week')
                  : option === 'month'
                    ? t('common:this_month')
                    : t('history:everyone')}
            </button>
          ))}
        </div>

        {canSeeEveryone ? (
          <label className="mz-field">
            <span className="mz-field__label">{t('history:filter_done_by')}</span>
            <select
              className="mz-field__control"
              value={doneBy}
              onChange={(event) => setDoneBy(event.target.value)}
            >
              <option value="">{t('history:everyone')}</option>
              {directory.data?.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.display_name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {history.isPending ? <Skeleton lines={8} /> : null}
        {history.isError ? (
          <ErrorState
            title={t('common:error_title')}
            body={t('common:error_body')}
            action={
              <Button variant="secondary" onClick={() => void history.refetch()}>
                {t('common:retry')}
              </Button>
            }
          />
        ) : null}
        {history.data && rows.length === 0 ? <EmptyState title={t('history:empty')} icon="history" /> : null}

        {rows.map((row) => (
          <Card key={row.id}>
            <button
              type="button"
              className="mz-row mz-row--between"
              style={{ background: 'none', border: 0, inlineSize: '100%', textAlign: 'start', cursor: 'pointer' }}
              aria-expanded={expanded === row.id}
              onClick={() => setExpanded(expanded === row.id ? null : row.id)}
            >
              <span>
                <span className="mz-list__title">
                  {row.actor_display_name ?? '—'} {t(`history:action.${row.action}`, row.action)}
                </span>
                <span className="mz-caption" style={{ display: 'block' }}>
                  {row.entity_label} · {formatter.timestamp(new Date(row.occurred_at))}
                  {row.auth_method === 'ticket_pin' ? ` · ${t('history:signed_in_with_pin')}` : ''}
                </span>
              </span>
            </button>

            {expanded === row.id ? (
              <div className="mz-stack" style={{ marginBlockStart: 'var(--space-3)', gap: 'var(--space-2)' }}>
                {Object.entries(row.changes).map(([field, change]) => {
                  const pair = change as { old?: unknown; new?: unknown };
                  const isPair = pair && typeof pair === 'object' && ('old' in pair || 'new' in pair);
                  return (
                    <p key={field} className="mz-caption">
                      <strong>{field}</strong>:{' '}
                      {isPair
                        ? `${t('history:old_value')} ${JSON.stringify(pair.old)} → ${t('history:new_value')} ${JSON.stringify(pair.new)}`
                        : JSON.stringify(change)}
                    </p>
                  );
                })}
                {row.note ? <p className="mz-caption">{t('common:note')}: {row.note}</p> : null}
                <p className="mz-caption" dir="ltr">
                  {t('history:request_id')}: {row.request_id}
                </p>
              </div>
            ) : null}
          </Card>
        ))}

        {history.hasNextPage ? (
          <Button variant="secondary" block loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
            {t('common:more')}
          </Button>
        ) : null}
      </div>
    </AppShell>
  );
}

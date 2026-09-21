import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { BottomSheet, Button, Card, Chip, DateField } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { AppShell } from '../components/AppShell.js';
import { QueryStates } from '../components/states.js';
import { AuditDiff } from '../components/AuditDiff.js';
import { FilterChip } from './MaterialsPage.js';
import { useApp, useFormatter } from '../lib/store.js';

interface AuditRow {
  id: string;
  occurred_at: string;
  actor_user_id: string | null;
  actor_display_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  entity_label: string;
  changes: Record<string, unknown>;
  note: string | null;
  request_id: string;
  auth_method: string | null;
}

interface AuditEntry extends AuditRow {
  group_size: number;
  rows: AuditRow[];
}

interface DirectoryEntry {
  id: string;
  display_name: string;
  is_active: boolean;
}

type DatePreset = 'today' | 'yesterday' | 'week' | 'month' | 'all' | 'custom';

/** The presets of FR-902, resolved from today's **Baghdad** day (spec 2.10.4). */
export function rangeFor(
  preset: DatePreset,
  today: string,
  custom: { from: string; to: string },
): { from?: string; to?: string } {
  if (preset === 'all') return {};
  if (preset === 'custom') return { from: custom.from || undefined, to: custom.to || undefined };
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'yesterday') {
    const date = new Date(`${today}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 1);
    const day = date.toISOString().slice(0, 10);
    return { from: day, to: day };
  }
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (preset === 'week' ? 6 : 29));
  return { from: date.toISOString().slice(0, 10), to: today };
}

const ENTITY_TYPES = ['order', 'purchase', 'customer', 'company', 'item', 'damage', 'user', 'settings'];

/**
 * The History page in full (FR-902, spec 2.4.5).
 *
 * The two user filters sit side by side with distinct labels, because they answer different
 * questions — who did this, and whose customer is it — and the specification is explicit that
 * both must be offered. An edit storm arrives from the API as one entry with its rows, so a
 * corrected order reads as one line that expands into the story.
 */
export function HistoryPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const user = useApp((state) => state.user);
  const permissions = useApp((state) => state.permissions);
  const canSeeEveryone = user?.role === 'admin' || permissions.has('history.view_all');

  const [searchParams] = useSearchParams();
  const [doneBy, setDoneBy] = useState(searchParams.get('done_by') ?? '');
  const [assignedTo, setAssignedTo] = useState(searchParams.get('assigned_to') ?? '');
  const [entityType, setEntityType] = useState(searchParams.get('entity_type') ?? '');
  const [preset, setPreset] = useState<DatePreset>((searchParams.get('preset') as DatePreset) ?? 'today');
  const [custom, setCustom] = useState({ from: searchParams.get('from') ?? '', to: searchParams.get('to') ?? '' });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandedRows, setExpandedRows] = useState<string | null>(null);
  const [filters, setFilters] = useState(false);

  const directory = useQuery({
    queryKey: ['users', 'directory'],
    queryFn: () => apiRequest<DirectoryEntry[]>('/users/directory'),
    enabled: canSeeEveryone,
  });

  const range = rangeFor(preset, formatter.today(), custom);
  const history = useInfiniteQuery({
    queryKey: ['history', doneBy, assignedTo, entityType, preset, custom.from, custom.to],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (doneBy) params.set('done_by', doneBy);
      if (assignedTo) params.set('assigned_to', assignedTo);
      if (entityType) params.set('entity_type', entityType);
      if (range.from) params.set('from', range.from);
      if (range.to) params.set('to', range.to);
      if (pageParam) params.set('cursor', String(pageParam));
      return apiRequest<{ items: AuditEntry[]; next_cursor: string | null }>(`/history?${params.toString()}`);
    },
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });

  const entries = history.data?.pages.flatMap((page) => page.items) ?? [];
  const employees = (directory.data ?? []).filter((entry) => entry.is_active);

  return (
    <AppShell title={t('history:title')}>
      <div className="mz-stack">
        <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }} role="group" aria-label={t('common:date')}>
          {(['today', 'yesterday', 'week', 'month', 'all'] as DatePreset[]).map((option) => (
            <FilterChip key={option} active={option === preset} onClick={() => setPreset(option)}>
              {option === 'today'
                ? t('common:today')
                : option === 'yesterday'
                  ? t('history:yesterday')
                  : option === 'week'
                    ? t('common:this_week')
                    : option === 'month'
                      ? t('common:this_month')
                      : t('common:all')}
            </FilterChip>
          ))}
          <FilterChip active={preset === 'custom'} onClick={() => setFilters(true)}>
            {t('common:custom_range')}
          </FilterChip>
        </div>

        {/* The two user filters side by side with distinct labels (FR-902). */}
        {canSeeEveryone ? (
          <div className="mz-grid-2">
            <label className="mz-field">
              <span className="mz-field__label">{t('history:filter_done_by')}</span>
              <select
                className="mz-field__control"
                value={doneBy}
                onChange={(event) => setDoneBy(event.target.value)}
              >
                <option value="">{t('history:everyone')}</option>
                {employees.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.display_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="mz-field">
              <span className="mz-field__label">{t('history:filter_assigned_to')}</span>
              <select
                className="mz-field__control"
                value={assignedTo}
                onChange={(event) => setAssignedTo(event.target.value)}
              >
                <option value="">{t('history:everyone')}</option>
                {employees.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.display_name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        <label className="mz-field">
          <span className="mz-field__label">{t('history:filter_entity')}</span>
          <select
            className="mz-field__control"
            value={entityType}
            onChange={(event) => setEntityType(event.target.value)}
          >
            <option value="">{t('history:all_types')}</option>
            {ENTITY_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`history:entity.${type}`, { defaultValue: type })}
              </option>
            ))}
          </select>
        </label>

        {/* The four states through the one component, so the offline wording cannot go missing. */}
        <QueryStates query={history} isEmpty={entries.length === 0} emptyTitle={t('history:empty')} skeletonLines={8}>
        {entries.map((entry) => (
          <Card key={entry.id}>
            <button
              type="button"
              className="mz-row mz-row--between"
              style={{ background: 'none', border: 0, inlineSize: '100%', textAlign: 'start', cursor: 'pointer' }}
              aria-expanded={expanded === entry.id}
              onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
            >
              <span>
                <span className="mz-list__title">
                  {entry.actor_display_name ?? '—'}{' '}
                  {t(`history:action.${entry.action}`, { defaultValue: entry.action })}
                </span>
                <span className="mz-caption" style={{ display: 'block' }}>
                  {entry.entity_label} · {formatter.timestamp(new Date(entry.occurred_at))}
                  {entry.auth_method === 'ticket_pin' ? ` · ${t('history:signed_in_with_pin')}` : ''}
                </span>
              </span>
              {/* An edit storm is one entry that says how many it stands for (2.4.5). */}
              {entry.group_size > 1 ? <Chip tone="warning">{t('history:edits', { count: entry.group_size })}</Chip> : null}
            </button>

            {expanded === entry.id ? (
              <div className="mz-stack" style={{ marginBlockStart: 'var(--space-3)', gap: 'var(--space-2)' }}>
                <AuditDiff changes={entry.changes} note={entry.note} />

                {entry.group_size > 1 ? (
                  <>
                    <Button
                      variant="ghost"
                      aria-expanded={expandedRows === entry.id}
                      onClick={() => setExpandedRows(expandedRows === entry.id ? null : entry.id)}
                    >
                      {t('history:show_edits')}
                    </Button>
                    {expandedRows === entry.id
                      ? entry.rows.slice(1).map((row) => (
                          <div key={row.id} className="mz-ledger-row">
                            <div>
                              <span className="mz-caption" style={{ display: 'block' }}>
                                {formatter.timestamp(new Date(row.occurred_at))}
                                {row.actor_display_name ? ` · ${row.actor_display_name}` : ''}
                              </span>
                              <AuditDiff changes={row.changes} note={row.note} />
                            </div>
                          </div>
                        ))
                      : null}
                  </>
                ) : null}

                <p className="mz-caption" dir="ltr">
                  {t('history:request_id')}: {entry.request_id}
                </p>
              </div>
            ) : null}
          </Card>
        ))}

        {history.hasNextPage ? (
          <Button
            variant="secondary"
            block
            loading={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            {t('common:more')}
          </Button>
        ) : null}
        </QueryStates>

        {filters ? (
          <BottomSheet
            title={t('common:custom_range')}
            open
            onClose={() => setFilters(false)}
            closeLabel={t('common:close')}
          >
            <div className="mz-stack">
              <DateField
                label={t('common:date')}
                value={custom.from}
                max={formatter.today()}
                onChange={(event) => {
                  setCustom((current) => ({ ...current, from: event.target.value }));
                  setPreset('custom');
                }}
              />
              <DateField
                label={t('common:date')}
                value={custom.to}
                max={formatter.today()}
                onChange={(event) => {
                  setCustom((current) => ({ ...current, to: event.target.value }));
                  setPreset('custom');
                }}
              />
              <Button block onClick={() => setFilters(false)}>
                {t('common:close')}
              </Button>
            </div>
          </BottomSheet>
        ) : null}
      </div>
    </AppShell>
  );
}

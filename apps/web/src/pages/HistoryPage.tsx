import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Chip, DateField, Icon } from '@mizan/ui';
import type { IconName } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { QueryStates } from '../components/states.js';
import { Pager } from '../components/Pager.js';
import { useCursorPaging } from '../lib/paging.js';
import { AuditDiff, AuditValue } from '../components/AuditDiff.js';
import { DualAmount } from '../components/DualAmount.js';
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

const ENTITY_TYPES = [
  'order',
  'purchase',
  'customer',
  'item',
  'damage',
  'expense',
  'user',
  'settings',
];

/** The kinds of action worth filtering by — the work, not the sign-ins. */
const ACTIONS = ['create', 'update', 'void', 'ledger_entry', 'rate_change', 'price_change', 'permission_change'];

const SESSION_ACTIONS = new Set(['login', 'logout', 'login_failed', 'lockout', 'lock', 'unlock', 'switch_user']);

/** What an action looks like in the list: a tone and an icon, never colour alone (2.10.8). */
function actionStyle(action: string): { tone: 'success' | 'primary' | 'danger' | 'warning' | 'neutral'; icon: IconName } {
  if (action === 'create') return { tone: 'success', icon: 'plus' };
  if (action === 'update' || action === 'status_change' || action === 'settings_change') return { tone: 'primary', icon: 'edit' };
  if (action === 'void' || action === 'delete') return { tone: 'danger', icon: 'trash' };
  if (action === 'ledger_entry') return { tone: 'success', icon: 'check' };
  if (action === 'rate_change' || action === 'price_change') return { tone: 'warning', icon: 'refresh' };
  if (action === 'permission_change' || action === 'password_change' || action === 'password_reset') {
    return { tone: 'warning', icon: 'shield' };
  }
  if (SESSION_ACTIONS.has(action)) return { tone: 'neutral', icon: action === 'login_failed' || action === 'lockout' ? 'warning' : 'lock' };
  return { tone: 'neutral', icon: 'history' };
}

/** Where a record lives, so its name in the list is a way there. */
function linkOf(entry: AuditRow): string | null {
  const id = entry.entity_id;
  switch (entry.entity_type) {
    case 'order':
      return `/orders/${id}`;
    case 'purchase':
      return `/purchases/${id}`;
    case 'customer':
    case 'company':
      return `/customers/${id}`;
    case 'item':
      return `/materials/${id}`;
    case 'damage':
      return `/damages/${id}`;
    case 'user':
      return `/users/${id}`;
    case 'expense':
      return '/accounts?tab=expenses';
    case 'settings':
      return '/settings';
    default:
      return null;
  }
}

/**
 * The record's name in the reader's language. The API stores an English label ("Order #1014",
 * "Material: Copper wire"), so a numbered record is named by its translated kind and its number,
 * and a named one by its name alone.
 */
function recordName(entry: AuditRow, t: (key: string, options?: Record<string, unknown>) => string, number: (value: number) => string): string {
  const numbered = entry.entity_label.match(/#\s*(\d+)\s*$/);
  if (numbered) return `${t(`history:entity.${entry.entity_type}`, { defaultValue: entry.entity_type })} #${number(Number(numbered[1]))}`;
  const named = entry.entity_label.match(/^[A-Za-z ]+:\s*(.+)$/);
  return named?.[1] ?? entry.entity_label;
}

/** Two letters for a person's badge. */
function initialsOf(name: string | null): string {
  if (!name) return '·';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase();
}

/** The changes worth a glance in the row: fields that went from one value to another. */
function changedFields(changes: Record<string, unknown>): [string, { old?: unknown; new?: unknown }][] {
  return Object.entries(changes ?? {}).filter(([, value]) => {
    if (!value || typeof value !== 'object') return false;
    const pair = value as { old?: unknown; new?: unknown };
    return 'old' in pair && 'new' in pair && pair.old !== null && JSON.stringify(pair.old) !== JSON.stringify(pair.new);
  }) as [string, { old?: unknown; new?: unknown }][];
}

/** The facts of a new record worth a glance: its name, what it came to, how much of it. */
const CREATE_FACTS = ['title', 'name', 'amount', 'total', 'purchase_total', 'quantity', 'payment_type', 'attribution'];

/**
 * What a row says beside who did it: for a money entry its kind, its amount and the balance it
 * moved; for a new record its main facts; for a change the first field that changed.
 */
function RowSummary({ entry }: { entry: AuditEntry }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const changes = entry.changes ?? {};

  if (entry.action === 'ledger_entry' && changes.entry && typeof changes.entry === 'object') {
    const money = changes.entry as { type?: string; amount_iqd?: number; amount_usd_cents?: number };
    const balance = changes.balance as
      | { before?: { amount: number; currency: 'IQD' | 'USD' }; after?: { amount: number; currency: 'IQD' | 'USD' } }
      | undefined;
    return (
      <p className="mz-activity__change">
        <span className="mz-activity__kind">{t(`customers:entry.${money.type ?? ''}`, { defaultValue: money.type ?? '' })}</span>
        {typeof money.amount_iqd === 'number' ? (
          <DualAmount amount_iqd={Math.abs(money.amount_iqd)} amount_usd_cents={Math.abs(money.amount_usd_cents ?? 0)} />
        ) : null}
        {balance?.before && balance.after ? (
          <span className="mz-caption">
            · {t('history:balance_moved')}: <span data-tabular>{formatter.money(balance.before.amount, balance.before.currency)}</span>
            <span aria-hidden="true" className="mz-activity__arrow">
              <Icon name="next" size={12} />
            </span>
            <span data-tabular>{formatter.money(balance.after.amount, balance.after.currency)}</span>
          </span>
        ) : null}
      </p>
    );
  }

  if (entry.action === 'create') {
    const facts = CREATE_FACTS.map((field) => [field, (changes[field] as { new?: unknown } | undefined)?.new] as const)
      .filter(([, value]) => value !== undefined && value !== null)
      .slice(0, 2);
    if (facts.length === 0) return null;
    return (
      <p className="mz-activity__change">
        {facts.map(([field, value], index) => (
          <span key={field} className="mz-activity__fact">
            {index > 0 ? <span className="mz-caption">·</span> : null}
            <span className="mz-caption">{t(`history:field.${field}`, { defaultValue: field })}:</span>
            <AuditValue value={value} />
          </span>
        ))}
      </p>
    );
  }

  const fields = changedFields(changes);
  const first = fields[0];
  if (!first) return null;
  return (
    <p className="mz-activity__change">
      <span className="mz-caption">{t(`history:field.${first[0]}`, { defaultValue: first[0] })}:</span>
      <AuditValue value={first[1].old} />
      <span aria-hidden="true" className="mz-activity__arrow">
        <Icon name="next" size={14} />
      </span>
      <AuditValue value={first[1].new} />
      {fields.length > 1 ? <span className="mz-caption">{t('history:more_changes', { count: fields.length - 1 })}</span> : null}
    </p>
  );
}

/**
 * History (FR-902, spec 2.4.5; rebuilt at the client's request): who did what, when, to which
 * record, and what changed — read like a day's diary. Entries are grouped by day; each row names
 * the person, what they did (a tag with its own icon), the record (a link to it), the time, and
 * the first thing that changed, with the whole diff a tap away. Signing in and out is hidden by
 * default, because a day of work drowns in it; one button brings it back.
 */
export function HistoryPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const user = useApp((state) => state.user);
  const permissions = useApp((state) => state.permissions);
  const canSeeEveryone = user?.role === 'admin' || permissions.has('history.view_all');

  const [searchParams] = useSearchParams();
  const [doneBy, setDoneBy] = useState(searchParams.get('done_by') ?? '');
  const [entityType, setEntityType] = useState(searchParams.get('entity_type') ?? '');
  const [action, setAction] = useState('');
  const [sessions, setSessions] = useState(false);
  const [preset, setPreset] = useState<DatePreset>((searchParams.get('preset') as DatePreset) ?? 'today');
  const [custom, setCustom] = useState({ from: searchParams.get('from') ?? '', to: searchParams.get('to') ?? '' });
  const [expanded, setExpanded] = useState<string | null>(null);

  const directory = useQuery({
    queryKey: ['users', 'directory'],
    queryFn: () => apiRequest<DirectoryEntry[]>('/users/directory'),
    enabled: canSeeEveryone,
  });

  const range = rangeFor(preset, formatter.today(), custom);
  // The audit trail only grows, so it is paged by cursor (D-058).
  const paging = useCursorPaging({
    storageKey: 'history',
    resetOn: [doneBy, entityType, action, sessions, preset, custom.from, custom.to],
  });
  const history = useQuery({
    queryKey: ['history', doneBy, entityType, action, sessions, preset, custom.from, custom.to, paging.cursor, paging.pageSize],
    queryFn: () => {
      const params = new URLSearchParams();
      if (doneBy) params.set('done_by', doneBy);
      if (entityType) params.set('entity_type', entityType);
      if (action) params.set('action', action);
      if (!sessions) params.set('sessions', 'false');
      if (range.from) params.set('from', range.from);
      if (range.to) params.set('to', range.to);
      return apiRequest<{ items: AuditEntry[]; next_cursor: string | null }>(`/history?${params.toString()}&${paging.query}`);
    },
    placeholderData: keepPreviousData,
  });
  const refreshing = history.isFetching && history.isPlaceholderData;

  const entries = history.data?.items ?? [];
  const nextCursor = history.data?.next_cursor ?? null;
  const employees = (directory.data ?? []).filter((entry) => entry.is_active);

  // Day headings, in the Baghdad day each entry happened on.
  const dayOf = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Baghdad' });
  const today = formatter.today();
  const yesterday = rangeFor('yesterday', today, { from: '', to: '' }).from;
  const days: { day: string; entries: AuditEntry[] }[] = [];
  for (const entry of entries) {
    const day = dayOf(entry.occurred_at);
    const last = days[days.length - 1];
    if (last && last.day === day) last.entries.push(entry);
    else days.push({ day, entries: [entry] });
  }
  const dayTitle = (day: string) =>
    day === today
      ? `${t('common:today')} · ${formatter.date(day)}`
      : day === yesterday
        ? `${t('history:yesterday')} · ${formatter.date(day)}`
        : formatter.date(day);
  const timeOf = (iso: string) => formatter.timestamp(new Date(iso)).split(' ').pop() ?? '';

  usePageTitle(t('history:title'));

  return (
    <div className="mz-stack">
      <div className="mz-toolbar">
        <div className="mz-toolbar__filters">
          <select className="mz-select" aria-label={t('common:date')} value={preset} onChange={(event) => setPreset(event.target.value as DatePreset)}>
            <option value="today">{t('common:today')}</option>
            <option value="yesterday">{t('history:yesterday')}</option>
            <option value="week">{t('common:this_week')}</option>
            <option value="month">{t('common:this_month')}</option>
            <option value="all">{t('common:all')}</option>
            <option value="custom">{t('common:custom_range')}</option>
          </select>
          {canSeeEveryone ? (
            <select className="mz-select" aria-label={t('history:filter_done_by')} value={doneBy} onChange={(event) => setDoneBy(event.target.value)}>
              <option value="">{t('history:everyone')}</option>
              {employees.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.display_name}
                </option>
              ))}
            </select>
          ) : null}
          <select className="mz-select" aria-label={t('history:filter_entity')} value={entityType} onChange={(event) => setEntityType(event.target.value)}>
            <option value="">{t('history:all_types')}</option>
            {ENTITY_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`history:entity.${type}`, { defaultValue: type })}
              </option>
            ))}
          </select>
          <select className="mz-select" aria-label={t('history:filter_action')} value={action} onChange={(event) => setAction(event.target.value)}>
            <option value="">{t('history:all_actions')}</option>
            {ACTIONS.map((value) => (
              <option key={value} value={value}>
                {t(`history:action_filter.${value}`)}
              </option>
            ))}
          </select>
          <FilterChip active={sessions} onClick={() => setSessions(!sessions)}>
            {t('history:show_sign_ins')}
          </FilterChip>
        </div>
      </div>

      {preset === 'custom' ? (
        <div className="mz-grid-2">
          <DateField
            label={t('common:date_from')}
            value={custom.from}
            max={custom.to || formatter.today()}
            onChange={(event) => setCustom((current) => ({ ...current, from: event.target.value }))}
          />
          <DateField
            label={t('common:date_to')}
            value={custom.to}
            min={custom.from || undefined}
            max={formatter.today()}
            onChange={(event) => setCustom((current) => ({ ...current, to: event.target.value }))}
          />
        </div>
      ) : null}

      {/* The four states through the one component, so the offline wording cannot go missing. */}
      <QueryStates query={history} isEmpty={entries.length === 0} emptyTitle={t('history:empty')} skeletonLines={8}>
        <div className="mz-refreshable mz-stack" data-busy={refreshing ? 'true' : undefined} aria-busy={refreshing}>
          {days.map(({ day, entries: dayEntries }) => (
            <section key={day} className="mz-activity" aria-label={dayTitle(day)}>
              <h2 className="mz-activity__day">
                <span>{dayTitle(day)}</span>
                <span className="mz-caption">{t('history:day_count', { count: dayEntries.length })}</span>
              </h2>
              <ul className="mz-activity__list">
                {dayEntries.map((entry) => {
                  const style = actionStyle(entry.action);
                  const link = SESSION_ACTIONS.has(entry.action) ? null : linkOf(entry);
                  const open = expanded === entry.id;
                  const name = recordName(entry, t, (value) => formatter.number(value));
                  return (
                    <li key={entry.id} className="mz-activity__item" data-open={open ? 'true' : undefined}>
                      <span className="mz-activity__avatar" aria-hidden="true">
                        {initialsOf(entry.actor_display_name)}
                      </span>
                      <div className="mz-activity__body">
                        <p className="mz-activity__line">
                          <strong>
                            <bdi>{entry.actor_display_name ?? t('history:system')}</bdi>
                          </strong>
                          <Chip tone={style.tone} icon={style.icon}>
                            {t(`history:action.${entry.action}`, { defaultValue: entry.action })}
                          </Chip>
                          {SESSION_ACTIONS.has(entry.action) ? null : link ? (
                            <Link to={link} className="mz-quiet-link mz-activity__record">
                              <bdi>{name}</bdi>
                            </Link>
                          ) : (
                            <span className="mz-activity__record">
                              <bdi>{name}</bdi>
                            </span>
                          )}
                          {entry.group_size > 1 ? (
                            <Chip tone="warning">{t('history:edits', { count: entry.group_size })}</Chip>
                          ) : null}
                        </p>
                        <RowSummary entry={entry} />
                        {entry.note ? (
                          <p className="mz-activity__note">
                            <bdi>“{entry.note}”</bdi>
                          </p>
                        ) : null}
                        {open ? (
                          <div className="mz-activity__detail">
                            <AuditDiff changes={entry.changes} note={null} />
                            {entry.group_size > 1
                              ? entry.rows.slice(1).map((row) => (
                                  <div key={row.id} className="mz-activity__earlier">
                                    <span className="mz-caption">
                                      {formatter.timestamp(new Date(row.occurred_at))}
                                      {row.actor_display_name ? ` · ${row.actor_display_name}` : ''}
                                    </span>
                                    <AuditDiff changes={row.changes} note={row.note} />
                                  </div>
                                ))
                              : null}
                            <p className="mz-caption" dir="ltr">
                              {t('history:request_id')}: {entry.request_id}
                            </p>
                          </div>
                        ) : null}
                      </div>
                      <div className="mz-activity__side">
                        <time className="mz-caption" dateTime={entry.occurred_at} data-tabular>
                          {timeOf(entry.occurred_at)}
                        </time>
                        {Object.keys(entry.changes ?? {}).length > 0 || entry.group_size > 1 ? (
                          <button
                            type="button"
                            className="mz-link-button mz-caption"
                            aria-expanded={open}
                            onClick={() => setExpanded(open ? null : entry.id)}
                          >
                            {open ? t('history:hide_details') : t('history:details')}
                          </button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>

        <Pager
          page={paging.page}
          pageSize={paging.pageSize}
          hasNext={Boolean(nextCursor)}
          onPage={(page) => (page > paging.page && nextCursor ? paging.next(nextCursor) : paging.previous())}
          onPageSize={paging.setPageSize}
        />
      </QueryStates>
    </div>
  );
}

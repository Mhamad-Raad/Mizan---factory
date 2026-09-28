import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet, Button, Card, Chip, DateField, Icon, SegmentedControl, TextField, Toast } from '@mizan/ui';
import { apiRequest } from '../lib/api.js';
import { useIdempotencyKey } from '../lib/idempotency.js';
import { quantityText } from '../lib/quantity.js';
import { readNote } from '../lib/record-names.js';
import { CompensationChip } from '../components/chips.js';
import { errorMessage } from '../lib/errors.js';
import { invalidateMoneyViews } from '../lib/invalidate.js';
import { usePageTitle } from '../lib/page-title.js';
import { DualAmount } from '../components/DualAmount.js';
import { QueryStates } from '../components/states.js';
import { Pager } from '../components/Pager.js';
import { useCursorPaging } from '../lib/paging.js';
import { useFormatter, usePermission } from '../lib/store.js';
import type { DamageDetail } from './DamagesPage.js';

type Sheet = 'money' | 'materials' | 'void';

interface DamageHistory {
  next_cursor: string | null;
  items: { id: string; action: string; occurred_at: string; actor_display_name: string | null; note: string | null }[];
}

/**
 * The damage record, in the warehouse model (D-062).
 *
 * The header says what was damaged, how much, when, what it cost us and who did it. Our own
 * damage is a loss and there is nothing more to do. A company's damage is on their account —
 * they owe us what it cost — until someone confirms they paid it back: in money (a payment
 * clears it) or in materials (they replaced the goods, the stock comes back). Only then does it
 * stop counting as a cost. A record that was paid back cannot be voided; the money stays.
 */
export function DamageDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const formatter = useFormatter();
  const queryClient = useQueryClient();
  const mayMarkPaid = usePermission('damages.mark_returned');
  // Paid back writes a payment or a credit on the company's account, so it also needs the key
  // that guards that row (security review, finding 3); the API checks the same.
  const mayPaidMoney = usePermission('companies.record_payment');
  const mayPaidMaterials = usePermission('companies.record_credit');
  const mayEdit = usePermission('damages.edit');
  const mayVoid = usePermission('damages.void');

  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [tab, setTab] = useState<'overview' | 'history'>('overview');
  const [toast, setToast] = useState<string | null>(null);

  const damage = useQuery({
    queryKey: ['damages', id],
    queryFn: () => apiRequest<DamageDetail>(`/damages/${id}`),
  });

  // The audit trail is paged by cursor (D-058).
  const historyPaging = useCursorPaging({ storageKey: 'record-history', resetOn: [id] });
  const history = useQuery({
    queryKey: ['damages', id, 'history', historyPaging.cursor, historyPaging.pageSize],
    queryFn: () => apiRequest<DamageHistory>(`/damages/${id}/history?${historyPaging.query}`),
    enabled: tab === 'history',
    placeholderData: keepPreviousData,
  });
  const historyNext = history.data?.next_cursor ?? null;

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['damages'] });
    await queryClient.invalidateQueries({ queryKey: ['items'] });
    await queryClient.invalidateQueries({ queryKey: ['customers'] });
    await invalidateMoneyViews(queryClient);
  };

  // Each write holds one key across its retries, renewed only by its success (FR-1305).
  const paidBackKey = useIdempotencyKey();
  const voidKey = useIdempotencyKey();

  const paidBack = useMutation({
    mutationFn: (body: { method: 'money' | 'materials'; entry_date: string; note: string | null }) =>
      apiRequest(`/damages/${id}/paid-back`, {
        method: 'POST',
        body: { ...body, version: damage.data?.version },
        idempotencyKey: paidBackKey.key,
      }),
    onSuccess: async (_, body) => {
      paidBackKey.renew();
      closeSheet();
      setToast(body.method === 'money' ? t('damages:paid_back_money') : t('damages:paid_back_materials'));
      await invalidate();
    },
  });

  const voidRecord = useMutation({
    mutationFn: (reason: string) =>
      apiRequest(`/damages/${id}/void`, {
        method: 'POST',
        body: { reason, version: damage.data?.version },
        idempotencyKey: voidKey.key,
      }),
    onSuccess: async () => {
      voidKey.renew();
      closeSheet();
      setToast(t('damages:voided'));
      await invalidate();
    },
  });

  /** A closed sheet forgets its last refusal, so it does not greet the next attempt with it. */
  function closeSheet() {
    setSheet(null);
    paidBack.reset();
    voidRecord.reset();
  }

  const record = damage.data;
  const active = record?.doc_status === 'active';
  const isCompany = record?.attribution === 'company' && Boolean(record.company_id);
  const isPaid = record?.compensation === 'paid_money' || record?.compensation === 'paid_materials';
  const value =
    record?.cost && record.cost.est_value_iqd !== null ? (
      <DualAmount amount_iqd={record.cost.est_value_iqd} amount_usd_cents={record.cost.est_value_usd_cents ?? 0} />
    ) : null;

  usePageTitle(record ? t('damages:number', { number: formatter.identifier(record.number) }) : t('damages:title'));

  return (
    <div className="mz-stack">
      <QueryStates query={damage}>
        {record ? (
          <>
            {record.doc_status === 'void' ? (
              <div className="mz-warning" role="status">
                {t('damages:void_banner', { employee: record.voided_by_name ?? '', reason: record.void_reason ?? '' })}
              </div>
            ) : null}

            <Card>
              <div className="mz-row mz-row--between" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
                <div className="mz-stack" style={{ gap: '2px', minInlineSize: 0 }}>
                  <h2 className="mz-title">{t('damages:number', { number: formatter.identifier(record.number) })}</h2>
                  <Link to={`/materials/${record.item_id}`} className="mz-caption mz-tap-link">
                    <bdi>{record.item_name}</bdi>
                  </Link>
                  <span className="mz-caption" style={{ display: 'block' }} data-tabular>
                    {quantityText(record, formatter, t)} · {formatter.date(record.damage_date)}
                    {record.acting_user_name ? ` · ${t('glossary:done_by')}: ${record.acting_user_name}` : ''}
                  </span>
                  {record.reason ? (
                    <span className="mz-caption" style={{ display: 'block' }}>
                      <bdi>{record.reason}</bdi>
                    </span>
                  ) : null}
                </div>
                <span className="mz-row" style={{ gap: 'var(--space-1)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <CompensationChip compensation={record.compensation} />
                  {record.doc_status === 'void' ? (
                    <Chip tone="danger" icon="close">
                      {t('glossary:void')}
                    </Chip>
                  ) : null}
                </span>
              </div>

              <hr className="mz-divider" />

              <div className="mz-detail-summary">
                <div className="mz-stack" style={{ gap: 'var(--space-2)' }}>
                  <span className="mz-figure__label">{t('damages:cost_label')}</span>
                  {record.cost ? (
                    (value ?? <span className="mz-caption">{t('materials:no_price_yet')}</span>)
                  ) : (
                    <span className="mz-muted">—</span>
                  )}
                  <span className="mz-caption">
                    {record.stock_effect === 'none'
                      ? t('damages:stock_unchanged')
                      : record.stock_effect === 'returned_in'
                        ? t('damages:returned_to_stock')
                        : t('damages:stock_fell', { quantity: quantityText(record, formatter, t) })}
                  </span>
                </div>
                <div className="mz-detail-figures">
                  <div className="mz-figure">
                    <span className="mz-figure__label">{t('damages:who_did_it')}</span>
                    <span className="mz-figure__value">
                      {isCompany ? (
                        <Link to={`/customers/${record.company_id}`} className="mz-quiet-link">
                          <bdi>{record.company_name}</bdi>
                        </Link>
                      ) : (
                        t('damages:who.us')
                      )}
                    </span>
                  </div>
                </div>
              </div>
            </Card>

            {/* A company's damage: owed until confirmed paid back, then how and when (D-062). */}
            {isCompany && record.compensation !== 'none' ? (
              <Card className="mz-damage-owed" data-state={isPaid ? 'paid' : 'owed'}>
                {isPaid ? (
                  <div className="mz-row" style={{ gap: 'var(--space-2)' }}>
                    <Icon name="check" size={18} />
                    <strong>
                      {t(record.compensation === 'paid_money' ? 'damages:paid_back_money_on' : 'damages:paid_back_materials_on', {
                        date: record.compensated_at ? formatter.date(record.compensated_at.slice(0, 10)) : '',
                      })}
                    </strong>
                  </div>
                ) : (
                  <div className="mz-stack">
                    <div className="mz-row mz-row--between" style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                      <strong>
                        {t('damages:owed_by', { company: record.company_name ?? '' })}
                      </strong>
                      {value}
                    </div>
                    <p className="mz-caption">{t('damages:owed_hint')}</p>
                    {active && mayMarkPaid && (mayPaidMoney || mayPaidMaterials) ? (
                      <div className="mz-actions">
                        <div className="mz-actions__group mz-actions__group--primary">
                          {mayPaidMoney ? (
                            <Button icon="check" onClick={() => setSheet('money')}>
                              {t('damages:paid_back_money')}
                            </Button>
                          ) : null}
                          {mayPaidMaterials ? (
                            <Button variant="secondary" icon="materials" onClick={() => setSheet('materials')}>
                              {t('damages:paid_back_materials')}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                )}
              </Card>
            ) : null}

            {active && ((mayEdit && !isPaid) || (mayVoid && !isPaid)) ? (
              <div className="mz-actions">
                <div className="mz-actions__group">
                  {mayEdit ? (
                    <Link to={`/damages/${id}/edit`} className="mz-button mz-button--secondary">
                      <Icon name="edit" />
                      {t('common:edit')}
                    </Link>
                  ) : null}
                </div>
                {mayVoid ? (
                  <div className="mz-actions__group mz-actions__group--end">
                    <Button variant="danger" icon="trash" onClick={() => setSheet('void')}>
                      {t('damages:void_record')}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* The library's tabs, as on every other detail page: one selected, announced as such. */}
            <SegmentedControl
              label={t('damages:title')}
              value={tab}
              onChange={setTab}
              options={[
                { value: 'overview', label: t('companies:tab_overview') },
                { value: 'history', label: t('glossary:history') },
              ]}
            />

            {tab === 'overview' && record.credits.length > 0 ? (
              <Card>
                <h3 className="mz-heading">{t('damages:account_entries')}</h3>
                <ul className="mz-list">
                  {record.credits.map((credit) => (
                    <li key={credit.entry_id} className="mz-list__item">
                      <span className="mz-list__body">
                        <span className="mz-list__title">
                          <Link to={`/customers/${credit.owner_id}`} className="mz-quiet-link">
                            <bdi>{credit.owner_name}</bdi>
                          </Link>
                        </span>
                        <span className="mz-caption">
                          {formatter.date(credit.entry_date)}
                          {credit.note ? (
                            <>
                              {' · '}
                              <bdi>{readNote(credit.note, t, formatter.identifier)}</bdi>
                            </>
                          ) : null}
                        </span>
                      </span>
                      {credit.cost ? (
                        <DualAmount
                          amount_iqd={credit.cost.amount_iqd}
                          amount_usd_cents={credit.cost.amount_usd_cents}
                          primary={credit.settlement_currency}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}

            {tab === 'history' ? (
              <QueryStates query={history} isEmpty={(history.data?.items.length ?? 0) === 0} emptyTitle={t('history:empty')}>
                <Card>
                  <ul className="mz-list">
                    {(history.data?.items ?? []).map((row) => (
                      <li key={row.id} className="mz-list__item">
                        <span className="mz-list__body">
                          <span className="mz-list__title">{t(`history:action.${row.action}`)}</span>
                          <span className="mz-caption">
                            {formatter.timestamp(new Date(row.occurred_at))}
                            {row.actor_display_name ? ` · ${row.actor_display_name}` : ''}
                            {row.note ? (
                              <>
                                {' · '}
                                <bdi>{readNote(row.note, t, formatter.identifier)}</bdi>
                              </>
                            ) : null}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <Pager
                    page={historyPaging.page}
                    pageSize={historyPaging.pageSize}
                    hasNext={Boolean(historyNext)}
                    onPage={(page) =>
                      page > historyPaging.page && historyNext ? historyPaging.next(historyNext) : historyPaging.previous()
                    }
                    onPageSize={historyPaging.setPageSize}
                  />
                </Card>
              </QueryStates>
            ) : null}
          </>
        ) : null}
      </QueryStates>

      {(sheet === 'money' || sheet === 'materials') && record ? (
        <PaidBackSheet
          method={sheet}
          saving={paidBack.isPending}
          error={errorMessage(t, paidBack.error) ?? undefined}
          onClose={closeSheet}
          onEdit={paidBack.reset}
          onSave={(body) => paidBack.mutate({ method: sheet, ...body })}
        />
      ) : null}

      {sheet === 'void' && record ? (
        <VoidSheet
          saving={voidRecord.isPending}
          error={errorMessage(t, voidRecord.error) ?? undefined}
          onClose={closeSheet}
          onEdit={voidRecord.reset}
          onSave={(reason) => voidRecord.mutate(reason)}
        />
      ) : null}

      {toast ? <Toast message={toast} actionLabel={t('common:close')} onAction={() => setToast(null)} /> : null}
    </div>
  );
}

/** "Paid back in money" or "Replaced with materials": what it does, the date, an optional note. */
function PaidBackSheet({
  method,
  saving,
  error,
  onClose,
  onSave,
  onEdit,
}: {
  method: 'money' | 'materials';
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (body: { entry_date: string; note: string | null }) => void;
  /** Any change to the inputs: the caller forgets the last refusal. */
  onEdit?: () => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [date, setDate] = useState(formatter.today());
  const [note, setNote] = useState('');
  const title = method === 'money' ? t('damages:paid_back_money') : t('damages:paid_back_materials');

  return (
    <BottomSheet title={title} open onClose={onClose} closeLabel={t('common:close')}>
      <div className="mz-stack">
        <p>{method === 'money' ? t('damages:confirm_money') : t('damages:confirm_materials')}</p>
        <DateField
          label={t('common:date')}
          value={date}
          max={formatter.today()}
          onChange={(event) => {
            onEdit?.();
            setDate(event.target.value);
          }}
        />
        <TextField
          label={t('common:note')}
          hint={t('common:optional')}
          value={note}
          onChange={(event) => {
            onEdit?.();
            setNote(event.target.value);
          }}
          maxLength={2000}
        />
        {error ? (
          <div className="mz-warning" role="alert">
            {error}
          </div>
        ) : null}
        <Button block loading={saving} onClick={() => onSave({ entry_date: date, note: note.trim() === '' ? null : note.trim() })}>
          {title}
        </Button>
      </div>
    </BottomSheet>
  );
}

/** The void, with its reason required and what it will undo said first. */
function VoidSheet({
  saving,
  error,
  onClose,
  onSave,
  onEdit,
}: {
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (reason: string) => void;
  /** Any change to the reason: the caller forgets the last refusal. */
  onEdit?: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');

  return (
    <BottomSheet title={t('damages:void_record')} open onClose={onClose} closeLabel={t('common:close')}>
      <div className="mz-stack">
        <p>{t('damages:void_explanation')}</p>
        <TextField
          label={t('glossary:reason')}
          hint={t('materials:note_required')}
          value={reason}
          onChange={(event) => {
            onEdit?.();
            setReason(event.target.value);
          }}
          maxLength={2000}
        />
        {error ? (
          <div className="mz-warning" role="alert">
            {error}
          </div>
        ) : null}
        <Button block variant="danger" loading={saving} disabled={reason.trim() === ''} onClick={() => onSave(reason.trim())}>
          {t('damages:void_record')}
        </Button>
      </div>
    </BottomSheet>
  );
}

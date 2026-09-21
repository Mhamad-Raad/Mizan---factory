import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet, Button, Card, DateField, TextField, Toast, Toggle } from '@mizan/ui';
import { ApiError, apiRequest, newIdempotencyKey } from '../lib/api.js';
import { AppShell } from '../components/AppShell.js';
import { DualAmount } from '../components/DualAmount.js';
import { MoneyInput } from '../components/MoneyInput.js';
import type { MoneyValue } from '../components/MoneyInput.js';
import { QueryStates } from '../components/states.js';
import { AttributionChip, ReturnStatusChip } from '../components/chips.js';
import { useFormatter, usePermission } from '../lib/store.js';
import { quantityOf } from './DamagesPage.js';
import type { DamageDetail } from './DamagesPage.js';

type Sheet = 'return' | 'written_off' | 'company_credit' | 'customer_credit' | 'return_to_stock' | 'void';

interface DamageHistory {
  items: { id: string; action: string; occurred_at: string; actor_display_name: string | null; note: string | null }[];
}

/**
 * The damage record (FR-803 to FR-806, spec 3.3).
 *
 * The header says what happened and what it did to stock; then come the four actions the
 * specification names — Mark returned, Written off, Record credit, Return to stock — each
 * present only where it is meaningful and only for whoever holds its key, and each leaving a
 * line in History. A record attributed to a customer order says in so many words that the
 * customer's balance has not moved, because that is the question it raises (FR-806).
 */
export function DamageDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const formatter = useFormatter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mayMarkReturned = usePermission('damages.mark_returned');
  const mayEdit = usePermission('damages.edit');
  const mayVoid = usePermission('damages.void');
  const mayCreditCompany = usePermission('companies.record_credit');
  const mayCreditCustomer = usePermission('orders.credit');

  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [tab, setTab] = useState<'overview' | 'history'>('overview');
  const [toast, setToast] = useState<string | null>(null);

  const damage = useQuery({
    queryKey: ['damages', id],
    queryFn: () => apiRequest<DamageDetail>(`/damages/${id}`),
  });

  const history = useQuery({
    queryKey: ['damages', id, 'history'],
    queryFn: () => apiRequest<DamageHistory>(`/damages/${id}/history`),
    enabled: tab === 'history',
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['damages'] });
    await queryClient.invalidateQueries({ queryKey: ['items'] });
    await queryClient.invalidateQueries({ queryKey: ['companies'] });
    await queryClient.invalidateQueries({ queryKey: ['customers'] });
  };

  const markReturn = useMutation({
    mutationFn: (body: unknown) =>
      apiRequest(`/damages/${id}/return`, { method: 'POST', body, idempotencyKey: newIdempotencyKey() }),
    onSuccess: async () => {
      setSheet(null);
      setToast(t('damages:mark_returned'));
      await invalidate();
    },
  });

  const customerCredit = useMutation({
    mutationFn: (body: unknown) =>
      apiRequest(`/customers/${damage.data?.customer_id ?? ''}/credits`, {
        method: 'POST',
        body,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      setSheet(null);
      await invalidate();
    },
  });

  const returnToStock = useMutation({
    mutationFn: (body: unknown) =>
      apiRequest(`/damages/${id}/return-to-stock`, { method: 'POST', body, idempotencyKey: newIdempotencyKey() }),
    onSuccess: async () => {
      setSheet(null);
      setToast(t('damages:returned_to_stock'));
      await invalidate();
    },
  });

  const voidRecord = useMutation({
    mutationFn: (reason: string) =>
      apiRequest(`/damages/${id}/void`, {
        method: 'POST',
        body: { reason, version: damage.data?.version },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      setSheet(null);
      setToast(t('damages:voided'));
      await invalidate();
    },
  });

  const record = damage.data;
  const isPending = record?.return_status === 'pending';
  const isCompany = record?.attribution === 'company';
  const isCustomerOrder = record?.attribution === 'customer_order';

  return (
    <AppShell title={record ? t('damages:number', { number: formatter.number(record.number) }) : t('damages:title')}>
      <div className="mz-stack">
        <QueryStates query={damage}>
          {record ? (
            <>
              {record.doc_status === 'void' ? (
                <div className="mz-warning" role="status">
                  {t('damages:void_banner', {
                    employee: record.voided_by_name ?? '',
                    reason: record.void_reason ?? '',
                  })}
                </div>
              ) : null}

              <Card>
                <h2 className="mz-title">
                  <Link to={`/materials/${record.item_id}`}>{record.item_name}</Link>
                </h2>
                <span className="mz-caption" style={{ display: 'block' }} data-tabular>
                  {quantityOf(record, formatter, t)} · {formatter.date(record.damage_date)}
                  {record.acting_user_name ? ` · ${record.acting_user_name}` : ''}
                </span>
                {record.reason ? <span className="mz-caption">{record.reason}</span> : null}
                <div className="mz-row" style={{ gap: 'var(--space-2)', marginBlockStart: 'var(--space-2)' }}>
                  <AttributionChip attribution={record.attribution} />
                  <ReturnStatusChip status={record.return_status} />
                </div>

                {/* What it did to stock, in the same words the form used (FR-804). */}
                <div className="mz-row mz-row--between" style={{ marginBlockStart: 'var(--space-3)' }}>
                  <span className="mz-caption">{t('glossary:stock')}</span>
                  <span>
                    {record.stock_effect === 'none'
                      ? t('damages:stock_unchanged')
                      : record.stock_effect === 'returned_in'
                        ? t('damages:returned_to_stock')
                        : t('damages:stock_fell', { quantity: quantityOf(record, formatter, t) })}
                  </span>
                </div>

                {record.cost ? (
                  <div className="mz-row mz-row--between">
                    <span className="mz-caption">{t('glossary:estimated_value')}</span>
                    {record.cost.est_value_iqd === null ? (
                      <span className="mz-caption">{t('materials:no_price_yet')}</span>
                    ) : (
                      <DualAmount
                        amount_iqd={record.cost.est_value_iqd}
                        amount_usd_cents={record.cost.est_value_usd_cents ?? 0}
                      />
                    )}
                  </div>
                ) : null}

                {/* The documents it is attributed to, as links (FR-802). */}
                {record.order_id ? (
                  <div className="mz-row mz-row--between">
                    <span className="mz-caption">{t('glossary:order')}</span>
                    <Link to={`/orders/${record.order_id}`}>
                      {t('orders:number', { number: formatter.number(record.order_number ?? 0) })}
                      {record.customer_name ? ` · ${record.customer_name}` : ''}
                    </Link>
                  </div>
                ) : null}
                {record.company_id ? (
                  <div className="mz-row mz-row--between">
                    <span className="mz-caption">{t('glossary:company')}</span>
                    <Link to={`/companies/${record.company_id}`}>{record.company_name}</Link>
                  </div>
                ) : null}
                {record.purchase_id ? (
                  <div className="mz-row mz-row--between">
                    <span className="mz-caption">{t('glossary:purchase')}</span>
                    <Link to={`/purchases/${record.purchase_id}`}>
                      {t('purchases:number', { number: formatter.number(record.purchase_number ?? 0) })}
                    </Link>
                  </div>
                ) : null}

                {isCustomerOrder && !record.credited ? (
                  <p className="mz-caption">{t('damages:customer_balance_unchanged')}</p>
                ) : null}
              </Card>

              {record.doc_status === 'active' ? (
                <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  {isPending && mayMarkReturned ? (
                    <Button onClick={() => setSheet('return')}>{t('damages:mark_returned')}</Button>
                  ) : null}
                  {isPending && mayMarkReturned ? (
                    <Button variant="secondary" onClick={() => setSheet('written_off')}>
                      {t('damages:mark_written_off')}
                    </Button>
                  ) : null}
                  {isCompany && record.return_status === 'returned' && mayCreditCompany ? (
                    <Button variant="secondary" onClick={() => setSheet('company_credit')}>
                      {t('damages:record_company_credit')}
                    </Button>
                  ) : null}
                  {isCustomerOrder && !record.credited && mayCreditCustomer ? (
                    <Button variant="secondary" onClick={() => setSheet('customer_credit')}>
                      {t('damages:record_customer_credit')}
                    </Button>
                  ) : null}
                  {isCustomerOrder && record.stock_effect !== 'returned_in' && mayEdit ? (
                    <Button variant="secondary" onClick={() => setSheet('return_to_stock')}>
                      {t('damages:return_to_stock')}
                    </Button>
                  ) : null}
                  {mayEdit && (isPending || record.return_status === 'not_returnable') ? (
                    <Link to={`/damages/${id}/edit`} className="mz-button mz-button--ghost">
                      {t('common:edit')}
                    </Link>
                  ) : null}
                  {mayVoid ? (
                    <Button variant="ghost" onClick={() => setSheet('void')}>
                      {t('damages:void_record')}
                    </Button>
                  ) : null}
                </div>
              ) : null}

              <div className="mz-row" style={{ gap: 'var(--space-2)' }}>
                <Button variant={tab === 'overview' ? 'secondary' : 'ghost'} onClick={() => setTab('overview')}>
                  {t('companies:tab_overview')}
                </Button>
                <Button variant={tab === 'history' ? 'secondary' : 'ghost'} onClick={() => setTab('history')}>
                  {t('glossary:history')}
                </Button>
              </div>

              {tab === 'overview' ? (
                <Card>
                  <h3 className="mz-heading">{t('damages:credits')}</h3>
                  {record.credits.length === 0 ? (
                    <p className="mz-caption">{t('damages:no_credits')}</p>
                  ) : (
                    <ul className="mz-list">
                      {record.credits.map((credit) => (
                        <li key={credit.entry_id} className="mz-list__item">
                          <span className="mz-list__body">
                            <span className="mz-list__title">
                              <Link
                                to={
                                  credit.side === 'company'
                                    ? `/companies/${credit.owner_id}`
                                    : `/customers/${credit.owner_id}`
                                }
                              >
                                {credit.owner_name}
                              </Link>
                            </span>
                            <span className="mz-caption">
                              {formatter.date(credit.entry_date)}
                              {credit.note ? ` · ${credit.note}` : ''}
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
                  )}
                </Card>
              ) : null}

              {tab === 'history' ? (
                <QueryStates
                  query={history}
                  isEmpty={(history.data?.items.length ?? 0) === 0}
                  emptyTitle={t('history:empty')}
                >
                  <Card>
                    <ul className="mz-list">
                      {(history.data?.items ?? []).map((row) => (
                        <li key={row.id} className="mz-list__item">
                          <span className="mz-list__body">
                            <span className="mz-list__title">{t(`history:action.${row.action}`)}</span>
                            <span className="mz-caption">
                              {formatter.timestamp(new Date(row.occurred_at))}
                              {row.actor_display_name ? ` · ${row.actor_display_name}` : ''}
                              {row.note ? ` · ${row.note}` : ''}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                </QueryStates>
              ) : null}
            </>
          ) : null}
        </QueryStates>

        {/* "Mark returned", with "and record a credit" pre-ticked for an accountant (3.5.5). */}
        {sheet === 'return' && record ? (
          <MarkReturnedSheet
            record={record}
            mayCredit={isCompany && mayCreditCompany}
            saving={markReturn.isPending}
            error={
              markReturn.error instanceof ApiError
                ? t(markReturn.error.messageKey, { defaultValue: t('errors:VALIDATION_FAILED') })
                : undefined
            }
            onClose={() => setSheet(null)}
            onSave={(body) => markReturn.mutate(body)}
          />
        ) : null}

        {sheet === 'written_off' && record ? (
          <NoteSheet
            title={t('damages:mark_written_off')}
            saving={markReturn.isPending}
            onClose={() => setSheet(null)}
            onSave={(note) => markReturn.mutate({ status: 'written_off', note })}
          />
        ) : null}

        {sheet === 'company_credit' && record ? (
          <MarkReturnedSheet
            record={record}
            mayCredit
            creditOnly
            saving={markReturn.isPending}
            error={
              markReturn.error instanceof ApiError
                ? t(markReturn.error.messageKey, { defaultValue: t('errors:VALIDATION_FAILED') })
                : undefined
            }
            onClose={() => setSheet(null)}
            onSave={(body) => markReturn.mutate(body)}
          />
        ) : null}

        {sheet === 'customer_credit' && record ? (
          <CustomerCreditSheet
            record={record}
            saving={customerCredit.isPending}
            error={
              customerCredit.error instanceof ApiError
                ? t(customerCredit.error.messageKey, { defaultValue: t('errors:VALIDATION_FAILED') })
                : undefined
            }
            onClose={() => setSheet(null)}
            onSave={(body) => customerCredit.mutate(body)}
          />
        ) : null}

        {sheet === 'return_to_stock' ? (
          <NoteSheet
            title={t('damages:return_to_stock')}
            saving={returnToStock.isPending}
            onClose={() => setSheet(null)}
            onSave={(note) => returnToStock.mutate({ note })}
          />
        ) : null}

        {sheet === 'void' && record ? (
          <NoteSheet
            title={t('damages:void_record')}
            body={t('damages:void_explanation')}
            required
            saving={voidRecord.isPending}
            onClose={() => setSheet(null)}
            onSave={(note) => voidRecord.mutate(note)}
          />
        ) : null}

        {toast ? <Toast message={toast} actionLabel={t('common:close')} onAction={() => setToast(null)} /> : null}
        <Button variant="ghost" onClick={() => navigate('/damages')}>
          {t('common:back')}
        </Button>
      </div>
    </AppShell>
  );
}

/**
 * "Mark returned" (FR-803) and the supplier credit of FR-805 in one sheet, because on the floor
 * they are one decision: the goods went back and this is what we are owed for them. The amount
 * arrives pre-filled from the purchase line, and the sheet says where the figure came from.
 */
function MarkReturnedSheet({
  record,
  mayCredit,
  creditOnly,
  saving,
  error,
  onClose,
  onSave,
}: {
  record: DamageDetail;
  mayCredit: boolean;
  creditOnly?: boolean;
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (body: unknown) => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const prefill = record.credit_prefill;
  const [withCredit, setWithCredit] = useState(Boolean(creditOnly) || (mayCredit && Boolean(prefill)));
  const [amount, setAmount] = useState<MoneyValue>({
    amount: prefill ? (prefill.entered_currency === 'IQD' ? prefill.amount_iqd : prefill.amount_usd_cents) : null,
    currency: prefill?.entered_currency ?? 'IQD',
    other_amount: null,
  });
  const [date, setDate] = useState(formatter.today());
  const [note, setNote] = useState('');

  return (
    <BottomSheet
      title={creditOnly ? t('damages:record_company_credit') : t('damages:mark_returned')}
      open
      onClose={onClose}
      closeLabel={t('common:close')}
    >
      <div className="mz-stack">
        {!creditOnly ? (
          <DateField
            label={t('glossary:date_paid')}
            value={date}
            max={formatter.today()}
            onChange={(event) => setDate(event.target.value)}
          />
        ) : null}

        {mayCredit ? (
          <>
            {!creditOnly ? (
              <Toggle label={t('damages:and_record_credit')} checked={withCredit} onChange={setWithCredit} />
            ) : null}
            {withCredit ? (
              <>
                {prefill ? (
                  <span className="mz-caption">
                    {t('damages:credit_prefill', { source: t(`damages:source.${prefill.source}`) })}
                    {prefill.from_month ? ` · ${formatter.month(prefill.from_month.slice(0, 7))}` : ''}
                  </span>
                ) : (
                  <span className="mz-caption">{t('damages:no_price_to_prefill')}</span>
                )}
                <MoneyInput
                  label={t('companies:amount')}
                  value={amount}
                  rate={prefill?.rate_iqd_per_usd ?? '1310.0000'}
                  onChange={setAmount}
                  error={error}
                />
              </>
            ) : null}
          </>
        ) : null}

        <TextField label={t('common:note')} value={note} onChange={(event) => setNote(event.target.value)} />

        <Button
          block
          loading={saving}
          disabled={withCredit && (amount.amount === null || amount.amount <= 0)}
          onClick={() =>
            onSave({
              status: 'returned',
              returned_at: creditOnly ? null : date,
              note: note.trim() === '' ? null : note.trim(),
              credit: withCredit
                ? {
                    amount: amount.amount,
                    currency: amount.currency,
                    other_amount: amount.other_amount ?? null,
                    note: note.trim() === '' ? null : note.trim(),
                  }
                : null,
            })
          }
        >
          {t('common:save')}
        </Button>
      </div>
    </BottomSheet>
  );
}

/** The customer credit of FR-806 / FR-506: explicit, linked to the damage and its order. */
function CustomerCreditSheet({
  record,
  saving,
  error,
  onClose,
  onSave,
}: {
  record: DamageDetail;
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (body: unknown) => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const [amount, setAmount] = useState<MoneyValue>({
    amount: record.cost?.est_value_iqd ?? null,
    currency: 'IQD',
    other_amount: null,
  });
  const [date, setDate] = useState(formatter.today());
  const [note, setNote] = useState('');

  return (
    <BottomSheet
      title={t('damages:record_customer_credit')}
      open
      onClose={onClose}
      closeLabel={t('common:close')}
    >
      <div className="mz-stack">
        <MoneyInput
          label={t('customers:amount')}
          value={amount}
          rate="1310.0000"
          onChange={setAmount}
          error={error}
        />
        <DateField
          label={t('common:date')}
          value={date}
          max={formatter.today()}
          onChange={(event) => setDate(event.target.value)}
        />
        <TextField
          label={t('common:note')}
          value={note}
          hint={t('materials:note_required')}
          onChange={(event) => setNote(event.target.value)}
        />
        <Button
          block
          loading={saving}
          disabled={amount.amount === null || amount.amount <= 0 || note.trim() === ''}
          onClick={() =>
            onSave({
              amount: amount.amount,
              currency: amount.currency,
              other_amount: amount.other_amount ?? null,
              entry_date: date,
              note: note.trim(),
              order_id: record.order_id,
              damage_id: record.id,
            })
          }
        >
          {t('common:save')}
        </Button>
      </div>
    </BottomSheet>
  );
}

/** One note, one button: written off, returned to stock, and the void with its explanation. */
function NoteSheet({
  title,
  body,
  required,
  saving,
  onClose,
  onSave,
}: {
  title: string;
  body?: string;
  required?: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (note: string) => void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');

  return (
    <BottomSheet title={title} open onClose={onClose} closeLabel={t('common:close')}>
      <div className="mz-stack">
        {body ? <p>{body}</p> : null}
        <TextField
          label={required ? t('glossary:reason') : t('common:note')}
          value={note}
          hint={required ? t('materials:note_required') : t('common:optional')}
          onChange={(event) => setNote(event.target.value)}
          maxLength={2000}
        />
        <Button block loading={saving} disabled={required && note.trim() === ''} onClick={() => onSave(note.trim())}>
          {title}
        </Button>
      </div>
    </BottomSheet>
  );
}

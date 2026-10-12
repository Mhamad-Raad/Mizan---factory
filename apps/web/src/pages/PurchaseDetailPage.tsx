import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet, Button, Card, Chip, Icon, SegmentedControl, TextField } from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { apiRequest } from '../lib/api.js';
import { useIdempotencyKey } from '../lib/idempotency.js';
import { quantityText } from '../lib/quantity.js';
import { errorMessage } from '../lib/errors.js';
import { invalidateMoneyViews } from '../lib/invalidate.js';
import { usePageTitle } from '../lib/page-title.js';
import { DualAmount } from '../components/DualAmount.js';
import { Can } from '../components/Can.js';
import { QueryStates } from '../components/states.js';
import { Pager } from '../components/Pager.js';
import { useCursorPaging } from '../lib/paging.js';
import { PriceFromMonth, RateBadge } from '../components/chips.js';
import { useFormatter, usePermission } from '../lib/store.js';
import type { PurchaseDetail } from '../lib/purchases.js';
import { bothOf } from '../lib/money.js';
import { usePrint } from '../lib/print.js';
import { PaymentSheet } from '../components/PaymentSheet.js';
import type { PaymentBody } from '../components/PaymentSheet.js';
import { SavedToast, paymentReceipt } from '../components/SavedToast.js';
import type { SavedNotice } from '../components/SavedToast.js';
import { useAccount } from '../lib/accounts.js';

/** What is paid and still owed on one purchase, by the oldest-first reading (FR-712). */
interface PurchaseBalance {
  settlement_currency: Currency | null;
  cost: { total: number | null; linked: number | null; allocated: number | null; remaining: number | null };
}

type Tab = 'lines' | 'history';

interface PurchaseHistory {
  next_cursor: string | null;
  items: { id: string; action: string; occurred_at: string; actor_display_name: string | null; note: string | null }[];
}

/**
 * One purchase (D-085): what we bought, from which company, and — for a company — what we have
 * paid on it and what we still owe, read oldest-first like the company's own page (FR-712). From
 * here the rest of it can be paid, and its receipt printed at any time; a purchase just saved opens
 * here with its receipt offered at once (D-086). It can be voided while none of its stock has gone
 * out; once some has been sold or damaged it is the cost of those, and the API refuses
 * (BUY_IN_USE) — the sheet says so in words.
 */
export function PurchaseDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const formatter = useFormatter();
  const queryClient = useQueryClient();
  const mayVoid = usePermission('purchases.void');
  const mayPay = usePermission('companies.record_payment');
  const maySeeOwed = usePermission('fields.see_company_balances');
  const print = usePrint();
  const location = useLocation();
  const navigate = useNavigate();

  const [tab, setTab] = useState<Tab>('lines');
  const [voiding, setVoiding] = useState(false);
  const [paying, setPaying] = useState(false);
  const [reason, setReason] = useState('');
  // A purchase just saved arrives with `justSaved` (see PurchaseFormPage): its receipt is offered
  // at once. The history entry is wiped as the page opens — as the Orders list does with its
  // saved order — so a reload or a step back does not offer it again.
  const [notice, setNotice] = useState<SavedNotice | null>(() =>
    (location.state as { justSaved?: boolean } | null)?.justSaved
      ? { message: t('purchases:saved'), receipt: { kind: 'purchase', id } }
      : null,
  );
  useEffect(() => {
    if (location.state) navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const dismiss = useCallback(() => setNotice(null), []);

  const purchase = useQuery({
    queryKey: ['purchases', id],
    queryFn: () => apiRequest<PurchaseDetail>(`/purchases/${id}`),
  });
  const data = purchase.data;
  const companyId = data?.company_id ?? null;

  // Paid and still owed, for a purchase from a company and a reader who may see what we owe.
  const balance = useQuery({
    queryKey: ['purchases', id, 'balance'],
    queryFn: () => apiRequest<PurchaseBalance>(`/purchases/${id}/balance`),
    enabled: Boolean(companyId) && maySeeOwed,
  });
  // The company's rate, which a payment is filled at (2.3.3).
  const company = useAccount(paying ? companyId : null);

  // The audit trail is paged by cursor (D-058).
  const historyPaging = useCursorPaging({ storageKey: 'record-history', resetOn: [id] });
  const history = useQuery({
    queryKey: ['purchases', id, 'history', historyPaging.cursor, historyPaging.pageSize],
    queryFn: () => apiRequest<PurchaseHistory>(`/purchases/${id}/history?${historyPaging.query}`),
    enabled: tab === 'history',
    placeholderData: keepPreviousData,
  });
  const historyNext = history.data?.next_cursor ?? null;

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['purchases'] });
    await queryClient.invalidateQueries({ queryKey: ['items'] });
    // A company's buy is on its account: voiding it moves what we owe them, and takes back the
    // money paid with it — the company's account tabs read under `companies` (second review).
    await queryClient.invalidateQueries({ queryKey: ['customers'] });
    await queryClient.invalidateQueries({ queryKey: ['companies'] });
    await invalidateMoneyViews(queryClient);
  };

  // One key per opening of the void sheet, held across its retries (FR-1305).
  const voidKey = useIdempotencyKey(`void:${id}:${voiding}`);

  const voidPurchase = useMutation({
    mutationFn: () =>
      apiRequest(`/purchases/${id}/void`, {
        method: 'POST',
        body: { reason: reason.trim(), version: purchase.data?.version },
        idempotencyKey: voidKey.key,
      }),
    onSuccess: async () => {
      voidKey.renew();
      closeVoid();
      setNotice({ message: t('purchases:voided') });
      await invalidate();
    },
  });

  // "Pay for this purchase": a company payment that names it (FR-705), with its own receipt.
  const payKey = useIdempotencyKey(`pay:${id}:${paying}`);
  const pay = useMutation({
    mutationFn: (body: PaymentBody) =>
      apiRequest<unknown>(`/companies/${companyId}/payments`, {
        method: 'POST',
        body: { ...body, purchase_id: id },
        idempotencyKey: payKey.key,
      }),
    onSuccess: async (answer) => {
      payKey.renew();
      setPaying(false);
      setNotice({
        message: t('companies:payment_recorded'),
        receipt: companyId ? paymentReceipt('buying', companyId, answer) : null,
      });
      await invalidate();
    },
  });

  /** A closed sheet forgets its last refusal, so it does not greet the next attempt with it. */
  function closeVoid() {
    setVoiding(false);
    voidPurchase.reset();
  }

  const settlement = data?.settlement_currency ?? 'IQD';
  const active = data?.doc_status === 'active';
  const remaining = balance.data?.cost.remaining ?? null;
  const total = balance.data?.cost.total ?? null;

  const titleNumber = data ? formatter.identifier(data.number) : null;
  usePageTitle(titleNumber ? t('purchases:number', { number: titleNumber }) : t('purchases:title'), {
    number: titleNumber,
  });

  return (
    <>
      <div className="mz-stack">
        <QueryStates query={purchase}>
          {data ? (
            <>
              {data.doc_status === 'void' ? (
                <div className="mz-warning" role="status">
                  {t('purchases:void_banner', {
                    employee: data.voided_by_name ?? '',
                    reason: data.void_reason ?? '',
                  })}
                </div>
              ) : null}

              <Card>
                <div className="mz-row mz-row--between" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
                  <div className="mz-stack" style={{ gap: '2px', minInlineSize: 0 }}>
                    <h2 className="mz-title">{t('purchases:number', { number: formatter.identifier(data.number) })}</h2>
                    <span className="mz-caption">
                      {t('print:bought_from')}:{' '}
                      {data.company_id && data.company_name ? (
                        <Link to={`/customers/${data.company_id}`} className="mz-quiet-link">
                          <bdi>{data.company_name}</bdi>
                        </Link>
                      ) : (
                        t('purchases:no_company')
                      )}
                    </span>
                    <span className="mz-caption" style={{ display: 'block' }}>
                      {formatter.date(data.purchase_date)}
                      {data.acting_user_name ? ` · ${t('glossary:done_by')}: ${data.acting_user_name}` : ''}
                    </span>
                    {data.notes ? (
                      <span className="mz-caption" style={{ display: 'block' }}>
                        <bdi>{data.notes}</bdi>
                      </span>
                    ) : null}
                  </div>
                  <span className="mz-row" style={{ gap: 'var(--space-1)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {data.doc_status === 'void' ? (
                      <Chip tone="danger" icon="close">
                        {t('glossary:void')}
                      </Chip>
                    ) : null}
                  </span>
                </div>

                <hr className="mz-divider" />

                <div className="mz-detail-summary">
                  <div className="mz-stack" style={{ gap: 'var(--space-2)' }}>
                    <span className="mz-figure__label">{t('glossary:total')}</span>
                    {data.cost ? (
                      <DualAmount
                        amount_iqd={data.cost.total_iqd}
                        amount_usd_cents={data.cost.total_usd_cents}
                        primary={settlement}
                        size="large"
                      />
                    ) : (
                      <span className="mz-muted">—</span>
                    )}
                    <span className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                      <RateBadge rate={data.rate_iqd_per_usd} source={data.rate_source} />
                    </span>
                  </div>

                  <div className="mz-detail-figures">
                    {/* What we have paid on it and what we still owe, oldest-first (FR-712). */}
                    {active && total !== null && remaining !== null ? (
                      <>
                        <div className="mz-figure">
                          <span className="mz-figure__label">{t('print:paid_so_far')}</span>
                          <DualAmount
                            {...bothOf(total - remaining, settlement, data.rate_iqd_per_usd)}
                            primary={settlement}
                            kind="derived"
                          />
                        </div>
                        <div className="mz-figure">
                          <span className={remaining > 0 ? 'mz-figure__label mz-owed' : 'mz-figure__label'}>
                            {remaining > 0 ? t('print:still_owed_on_purchase') : t('companies:settled')}
                          </span>
                          <DualAmount
                            {...bothOf(Math.max(remaining, 0), settlement, data.rate_iqd_per_usd)}
                            primary={settlement}
                            kind="derived"
                          />
                        </div>
                      </>
                    ) : null}
                    {data.cost && data.cost.discount_iqd > 0 ? (
                      <div className="mz-figure">
                        <span className="mz-figure__label">{t('glossary:discount')}</span>
                        <span className="mz-figure__value" data-tabular>
                          {formatter.money(data.cost.discount_iqd, 'IQD')}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>
              </Card>

              {/* Paying it and printing it first; its damage; and — set apart at the end — Void, so
                  it is never a slip. */}
              <div className="mz-actions">
                {active && companyId && mayPay && remaining !== null && remaining > 0 ? (
                  <div className="mz-actions__group mz-actions__group--primary">
                    <Button icon="check" onClick={() => setPaying(true)}>
                      {t('purchases:make_payment')}
                    </Button>
                  </div>
                ) : null}
                <div className="mz-actions__group">
                  <Button variant="secondary" icon="print" onClick={() => print([{ kind: 'purchase', id }])}>
                    {t('print:print_receipt')}
                  </Button>
                  {/* What arrived damaged in this delivery (FR-802, FR-805). */}
                  <Can permission="damages.view">
                    <Link to={`/damages?purchase=${id}`} className="mz-button mz-button--secondary">
                      <Icon name="warning" />
                      {t('glossary:damaged_items')}
                    </Link>
                  </Can>
                </div>

                {active && mayVoid ? (
                  <div className="mz-actions__group mz-actions__group--end">
                    <Button variant="danger" icon="trash" onClick={() => setVoiding(true)}>
                      {t('purchases:void_purchase')}
                    </Button>
                  </div>
                ) : null}
              </div>

              <SegmentedControl
                label={t('common:more')}
                hideLabel
                value={tab}
                onChange={setTab}
                options={[
                  { value: 'lines', label: t('orders:lines') },
                  { value: 'history', label: t('glossary:history') },
                ]}
              />

              {tab === 'lines' ? (
                <ul className="mz-list">
                  {data.lines.map((line) => (
                    <li key={line.id} className="mz-list__item mz-list__item--detail">
                      <span className="mz-row-lead">
                        <Icon name="materials" size={18} />
                      </span>
                      <span className="mz-list__body">
                        <span className="mz-list__title">
                          <Link to={`/materials/${line.item_id}`} className="mz-quiet-link">
                            <bdi>{line.item_name}</bdi>
                          </Link>
                        </span>
                        <span className="mz-caption" style={{ display: 'block' }} data-tabular>
                          {quantityText(line, formatter, t)}
                          {line.cost ? (
                            <>
                              {' × '}
                              {formatter.money(
                                line.cost.price_entered_currency === 'IQD'
                                  ? line.cost.unit_price_iqd
                                  : line.cost.unit_price_usd_cents,
                                line.cost.price_entered_currency,
                              )}
                            </>
                          ) : null}
                        </span>
                        {/* A typed price is the normal case for a purchase (the month's bought price
                            is only where the form starts, D-062), so only a carried-over month
                            price is worth a chip. */}
                        {line.cost?.price_source === 'month' && line.cost.price_from_month ? (
                          <PriceFromMonth month={line.cost.price_from_month} />
                        ) : null}
                        {line.note ? (
                          <span className="mz-caption" style={{ display: 'block' }}>
                            <bdi>{line.note}</bdi>
                          </span>
                        ) : null}
                      </span>
                      {line.cost ? (
                        <span className="mz-list__end">
                          <DualAmount
                            amount_iqd={line.cost.line_total_iqd}
                            amount_usd_cents={line.cost.line_total_usd_cents}
                            primary={settlement}
                          />
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}

              {tab === 'history' ? (
                <QueryStates
                  query={history}
                  isEmpty={(history.data?.items.length ?? 0) === 0}
                  emptyTitle={t('history:empty')}
                >
                  <ul className="mz-list">
                    {(history.data?.items ?? []).map((row) => (
                      <li key={row.id} className="mz-list__item mz-list__item--detail">
                        <span className="mz-row-lead">
                          <Icon name={row.action === 'void' ? 'close' : row.action === 'create' ? 'plus' : 'history'} size={18} />
                        </span>
                        <span className="mz-list__body">
                          <span className="mz-list__title">{t(`history:action.${row.action}`)}</span>
                          <span className="mz-caption">
                            {formatter.timestamp(new Date(row.occurred_at))}
                            {row.actor_display_name ? ` · ${row.actor_display_name}` : ''}
                          </span>
                          {row.note ? (
                            <span className="mz-caption" style={{ display: 'block' }}>
                              <bdi>{row.note}</bdi>
                            </span>
                          ) : null}
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
                </QueryStates>
              ) : null}
            </>
          ) : null}
        </QueryStates>

        {voiding && data ? (
          <BottomSheet
            title={t('purchases:void_purchase')}
            open
            onClose={closeVoid}
            closeLabel={t('common:close')}
          >
            <div className="mz-stack">
              <p>
                {t('purchases:void_explanation', {
                  count: data.lines.length,
                  amount: data.cost ? formatter.money(data.cost.total_iqd, 'IQD') : '',
                })}
              </p>
              <TextField
                label={t('glossary:reason')}
                value={reason}
                onChange={(event) => {
                  voidPurchase.reset();
                  setReason(event.target.value);
                }}
                maxLength={2000}
              />
              {voidPurchase.error ? (
                <div className="mz-warning" role="alert">
                  {errorMessage(t, voidPurchase.error)}
                </div>
              ) : null}
              <Button
                block
                loading={voidPurchase.isPending}
                disabled={reason.trim() === ''}
                onClick={() => voidPurchase.mutate()}
              >
                {t('purchases:void_purchase')}
              </Button>
            </div>
          </BottomSheet>
        ) : null}

        {paying && data && remaining !== null ? (
          <PaymentSheet
            open
            title={t('purchases:make_payment')}
            amountLabel={t('companies:amount_paid')}
            remainingLabel={t('print:still_owed_on_purchase')}
            saveLabel={t('purchases:make_payment')}
            settleHint={t('purchases:settle_in_full_hint')}
            remaining={remaining}
            settlement_currency={settlement}
            rate={company.data?.rate?.rate_iqd_per_usd ?? data.rate_iqd_per_usd}
            saving={pay.isPending}
            error={errorMessage(t, pay.error) ?? undefined}
            onClose={() => {
              setPaying(false);
              pay.reset();
            }}
            onEdit={pay.reset}
            // "Settle in full" closes what this purchase still owes, oldest-first — the figure
            // above — on the server (D-085).
            onSave={(body) => pay.mutate(body)}
          />
        ) : null}

        {notice ? <SavedToast notice={notice} onDone={dismiss} /> : null}
      </div>
    </>
  );
}

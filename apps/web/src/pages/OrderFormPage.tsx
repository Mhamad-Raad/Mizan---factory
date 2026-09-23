import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Chip, DateField, IconButton, NumberField, SegmentedControl, TextField, Toast } from '@mizan/ui';
import { computeLineTotals, convert, documentTotals } from '@mizan/money';
import type { Currency, Measure, Rate } from '@mizan/money';
import { ApiError, apiRequest, newIdempotencyKey } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { DraftBanner } from '../components/DraftBanner.js';
import { DualAmount } from '../components/DualAmount.js';
import { MoneyInput } from '../components/MoneyInput.js';
import type { MoneyValue } from '../components/MoneyInput.js';
import { PickerSheet } from '../components/PickerSheet.js';
import { QuantityInput } from '../components/QuantityInput.js';
import { QueryStates } from '../components/states.js';
import { TotalsFooter } from '../components/TotalsFooter.js';
import { PriceFromMonth, RateBadge } from '../components/chips.js';
import { clearDraft, readDraft, writeDraft } from '../lib/drafts.js';
import { customerName } from '../lib/customers.js';
import { useApp, useFormatter, usePermission } from '../lib/store.js';
import type { CustomerRow } from './CustomersPage.js';
import type { ItemRow } from './MaterialsPage.js';

interface FormLine {
  key: string;
  item_id: string;
  item_name: string;
  priced_measure: Measure;
  qty_count: number | null;
  qty_kg: string | null;
  price: MoneyValue;
  /** True while the price is the month-list default; typing in it makes it an override. */
  from_month_price: boolean;
  price_from_month: string | null;
  stock_hint: string | null;
  note: string | null;
}

interface FormState {
  customer_id: string | null;
  customer_name: string | null;
  customer_is_system: boolean;
  settlement_currency: Currency;
  order_date: string;
  payment_type: 'cash' | 'borrowed';
  received_currency: Currency;
  notes: string;
  rate_override: string;
  /** "Done by": only an admin may record an order on another employee's behalf (spec 2.7). */
  acting_user_id: string;
  discount: MoneyValue;
  lines: FormLine[];
}

/**
 * New order, and the same form for an edit (wireframe 3.4.1, flow 3.5.1).
 *
 * Everything the wireframe asks for is here in the order it asks for it: the customer at the
 * top with their balance, the payment type with "Paid in" for cash, line cards whose priced
 * measure comes first, "More" for the notes and the rate for this order, and the sticky
 * totals footer. Totals on screen are computed with the same kernel the server uses — and the
 * server recomputes them anyway, because it is the only calculator that counts (2.3.4).
 */
export function OrderFormPage({ mode }: { mode: 'create' | 'edit' }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const { id = '' } = useParams();
  const [searchParams] = useSearchParams();

  const existing = useQuery({
    queryKey: ['orders', id],
    queryFn: () => apiRequest<OrderDetail>(`/orders/${id}`),
    enabled: mode === 'edit',
  });

  // An edit form has nothing to show until the order is loaded (spec 3.3: skeleton first,
  // fields disabled meanwhile). Loading it *before* the form is mounted is also what keeps
  // the form's state initialised once, from its own props, instead of synced in an effect.
  usePageTitle(mode === 'edit' ? t('orders:edit_order') : t('orders:new_order'));

  if (mode === 'edit') {
    return (
      <>
        <QueryStates query={existing} skeletonLines={10}>
          {existing.data ? (
            <OrderForm
              mode="edit"
              orderId={id}
              version={existing.data.version}
              initial={fromOrder(existing.data)}
            />
          ) : null}
        </QueryStates>
      </>
    );
  }

  return (
    <>
      <OrderForm
        mode="create"
        initial={{
          customer_id: searchParams.get('customer'),
          customer_name: null,
          customer_is_system: false,
          settlement_currency: 'IQD',
          order_date: formatter.today(),
          payment_type: 'borrowed',
          received_currency: 'IQD',
          notes: '',
          rate_override: '',
          acting_user_id: '',
          discount: { amount: null, currency: 'IQD', other_amount: null },
          lines: [],
        }}
      />
    </>
  );
}

/** The order as the form holds it (FR-601), so the form is initialised once, never synced. */
function fromOrder(order: OrderDetail): FormState {
  return {
    customer_id: order.customer_id,
    customer_name: order.customer_name,
    customer_is_system: order.customer_is_system,
    settlement_currency: order.settlement_currency,
    order_date: order.order_date,
    payment_type: order.payment_type,
    received_currency: order.received_currency ?? 'IQD',
    notes: order.notes ?? '',
    rate_override: order.rate_source === 'manual' ? order.rate_iqd_per_usd : '',
    acting_user_id: '',
    discount:
      order.discount_iqd > 0
        ? { amount: order.discount_iqd, currency: 'IQD', other_amount: null }
        : { amount: null, currency: 'IQD', other_amount: null },
    lines: order.lines.map((line) => ({
      key: line.id,
      item_id: line.item_id,
      item_name: line.item_name,
      priced_measure: line.priced_measure,
      qty_count: line.qty_count,
      qty_kg: line.qty_kg,
      price: {
        amount: line.price_entered_currency === 'IQD' ? line.unit_price_iqd : line.unit_price_usd_cents,
        currency: line.price_entered_currency,
        other_amount: null,
      },
      from_month_price: line.price_source === 'month',
      price_from_month: line.price_from_month,
      stock_hint: null,
      note: line.note,
    })),
  };
}

function OrderForm({
  mode,
  orderId,
  version,
  initial,
}: {
  mode: 'create' | 'edit';
  orderId?: string;
  version?: number;
  initial: FormState;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const maySeeBalance = usePermission('fields.see_customer_balances');
  const isAdmin = useApp((state) => state.user?.role === 'admin');

  const draftId = mode === 'edit' ? (orderId as string) : 'new';
  const [idempotencyKey, setIdempotencyKey] = useState(
    () => readDraft<FormState>('order', draftId)?.idempotency_key ?? newIdempotencyKey(),
  );
  const [draftFound, setDraftFound] = useState(() => readDraft<FormState>('order', draftId));

  const [form, setForm] = useState<FormState>(initial);
  const [showMore, setShowMore] = useState(false);
  const [picking, setPicking] = useState<'customer' | 'material' | null>(null);
  const [toast, setToast] = useState<{ message: string; orderId?: string } | null>(null);

  const rate = useQuery({
    queryKey: ['global-rate'],
    queryFn: () =>
      apiRequest<{ current: { rate_iqd_per_usd: string; is_stale: boolean } | null }>('/settings/global-rates'),
  });

  const directory = useQuery({
    queryKey: ['users', 'directory'],
    queryFn: () => apiRequest<{ id: string; display_name: string; is_active: boolean }[]>('/users/directory'),
    enabled: isAdmin && showMore,
  });

  /**
   * The customer behind an id that came from a link or from the order being edited. What it
   * tells us is *derived* at render — the settlement currency, the label, whether borrowed is
   * even allowed — rather than copied into the form, so there is one source for each fact.
   */
  const customer = useQuery({
    queryKey: ['customers', form.customer_id],
    queryFn: () => apiRequest<CustomerRow>(`/customers/${form.customer_id}`),
    enabled: Boolean(form.customer_id),
  });

  const isSystemCustomer = customer.data?.is_system ?? form.customer_is_system;
  const settlementCurrency = customer.data?.settlement_currency ?? form.settlement_currency;
  const customerLabel = customer.data
    ? customerName(customer.data, t)
    : form.customer_name
      ? customerName({ name: form.customer_name, is_system: form.customer_is_system }, t)
      : null;
  // The walk-in customer is a till, not a debtor (FR-501, A-33).
  const paymentType = isSystemCustomer ? 'cash' : form.payment_type;

  const documentRate: Rate = form.rate_override.trim() !== ''
    ? form.rate_override.trim()
    : (rate.data?.current?.rate_iqd_per_usd ?? '1310.0000');

  /** Every change is kept, so a dropped connection or a locked screen costs nothing (2.10.2). */
  useEffect(() => {
    if (form.lines.length === 0 && !form.customer_id) return;
    const timer = window.setTimeout(() => writeDraft('order', draftId, form, idempotencyKey), 300);
    return () => window.clearTimeout(timer);
  }, [form, draftId, idempotencyKey]);

  const totals = useMemo(() => {
    const lineTotals = form.lines
      .filter((line) => quantityOf(line) !== null && line.price.amount !== null)
      .map((line) =>
        computeLineTotals({
          priced_measure: line.priced_measure,
          qty_count: line.qty_count,
          qty_kg: line.qty_kg,
          unit_price_iqd: line.price.currency === 'IQD' ? (line.price.amount as number) : (line.price.other_amount ?? convert(line.price.amount as number, 'USD', documentRate)),
          unit_price_usd_cents:
            line.price.currency === 'USD' ? (line.price.amount as number) : (line.price.other_amount ?? convert(line.price.amount as number, 'IQD', documentRate)),
          price_entered_currency: line.price.currency,
          both_prices_typed: line.price.other_amount !== null && line.price.other_amount !== undefined,
          document_rate: documentRate,
          document_rate_source: form.rate_override.trim() === '' ? 'global' : 'manual',
        }),
      );
    const discountIqd = form.discount.amount === null ? 0 : form.discount.currency === 'IQD' ? form.discount.amount : convert(form.discount.amount, 'USD', documentRate);
    const discountUsd = form.discount.amount === null ? 0 : form.discount.currency === 'USD' ? form.discount.amount : convert(form.discount.amount, 'IQD', documentRate);
    return {
      lines: lineTotals,
      ...documentTotals(lineTotals, { discount_iqd: discountIqd, discount_usd_cents: discountUsd }),
    };
  }, [form, documentRate]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        customer_id: form.customer_id,
        order_date: form.order_date,
        payment_type: paymentType,
        received_currency: paymentType === 'cash' ? form.received_currency : null,
        notes: form.notes.trim() === '' ? null : form.notes.trim(),
        rate_iqd_per_usd: form.rate_override.trim() === '' ? null : form.rate_override.trim(),
        acting_user_id: form.acting_user_id === '' ? null : form.acting_user_id,
        discount:
          form.discount.amount === null
            ? null
            : { amount: form.discount.amount, currency: form.discount.currency, other_amount: form.discount.other_amount ?? null },
        lines: form.lines.map((line) => ({
          item_id: line.item_id,
          qty_count: line.qty_count,
          qty_kg: line.qty_kg,
          unit_price: line.from_month_price
            ? null
            : {
                amount: line.price.amount,
                currency: line.price.currency,
                other_amount: line.price.other_amount ?? null,
              },
          note: line.note,
        })),
        ...(mode === 'edit' ? { version } : {}),
      };
      return apiRequest<OrderDetail>(mode === 'edit' ? `/orders/${orderId}` : '/orders', {
        method: mode === 'edit' ? 'PUT' : 'POST',
        body,
        idempotencyKey,
      });
    },
    onSuccess: async (order) => {
      clearDraft('order', draftId);
      setIdempotencyKey(newIdempotencyKey());
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
      await queryClient.invalidateQueries({ queryKey: ['items'] });
      if (mode === 'edit') {
        navigate(`/orders/${orderId}`, { replace: true });
        return;
      }
      // The save toast with its 8-second undo (FR-610, signature moment 3).
      setToast({ message: t('orders:saved', { number: formatter.number(order.number) }), orderId: order.id });
      setForm((current) => ({ ...current, lines: [], notes: '', discount: { amount: null, currency: 'IQD', other_amount: null } }));
    },
  });

  const undo = useMutation({
    mutationFn: (orderId: string) =>
      apiRequest(`/orders/${orderId}/undo`, { method: 'POST', body: {}, idempotencyKey: newIdempotencyKey() }),
    onSuccess: async () => {
      setToast(null);
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
      await queryClient.invalidateQueries({ queryKey: ['items'] });
    },
  });

  const error = save.error instanceof ApiError ? save.error : null;
  const stockWarnings = save.data?.stock_warnings ?? [];
  const creditWarning = save.data?.credit_limit_warning ?? null;

  const addLine = (item: ItemRow) => {
    setPicking(null);
    setForm((current) => ({
      ...current,
      lines: [
        ...current.lines,
        {
          key: `${item.id}-${current.lines.length}-${Date.now()}`,
          item_id: item.id,
          item_name: item.name,
          priced_measure: item.stock.priced_measure,
          qty_count: null,
          qty_kg: null,
          price: item.sale
            ? { amount: item.sale.amount_iqd, currency: 'IQD', other_amount: null }
            : { amount: null, currency: 'IQD', other_amount: null },
          from_month_price: Boolean(item.sale),
          price_from_month: item.sale && item.sale.source === 'fallback' ? item.sale.from_month : null,
          stock_hint: item.stock.priced_complete
            ? `${formatter.number(item.stock.priced_quantity, item.stock.priced_measure === 'kg' ? 3 : 0)} ${t(
                `common:${item.stock.priced_measure}_symbol`,
              )}`
            : null,
          note: null,
        },
      ],
    }));
  };

  const updateLine = (key: string, patch: Partial<FormLine>) => {
    setForm((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    }));
  };

  return (
    <div className="mz-stack">
        {draftFound && mode === 'create' ? (
          <DraftBanner
            savedAt={draftFound.saved_at}
            onRestore={() => {
              setForm(draftFound.value);
              setDraftFound(null);
            }}
            onDiscard={() => {
              clearDraft('order', draftId);
              setDraftFound(null);
            }}
          />
        ) : null}

        {rate.data?.current?.is_stale ? (
          // Proposed — not requested (FR-1106): a forgotten rate skews every dollar figure.
          <div className="mz-warning" role="status">
            {t('settings:rate_stale', { rate: formatter.rate(documentRate) })}
          </div>
        ) : null}

        <Card>
          <span className="mz-field__label">{t('glossary:customer')}</span>
          <Button variant="secondary" block onClick={() => setPicking('customer')}>
            {customerLabel ?? t('orders:choose_customer')}
          </Button>
          {customer.data?.balance && maySeeBalance ? (
            <div className="mz-row mz-row--between" style={{ marginBlockStart: 'var(--space-2)' }}>
              <span className="mz-caption">{t('glossary:balance')}</span>
              <DualAmount
                amount_iqd={customer.data.balance.amount_iqd}
                amount_usd_cents={customer.data.balance.amount_usd_cents}
                primary={customer.data.balance.currency}
                kind="derived"
              />
            </div>
          ) : null}
        </Card>

        <SegmentedControl
          label={t('glossary:payment_type')}
          value={paymentType}
          onChange={(value) => setForm((current) => ({ ...current, payment_type: value }))}
          options={[
            { value: 'cash', label: t('glossary:cash') },
            { value: 'borrowed', label: t('glossary:borrowed') },
          ]}
        />

        {paymentType === 'cash' ? (
          <SegmentedControl
            label={t('orders:paid_in')}
            value={form.received_currency}
            onChange={(value) => setForm((current) => ({ ...current, received_currency: value }))}
            options={[
              { value: 'IQD', label: t('glossary:iqd') },
              { value: 'USD', label: t('glossary:usd') },
            ]}
          />
        ) : null}

        <DateField
          label={t('common:date')}
          value={form.order_date}
          max={formatter.today()}
          onChange={(event) => setForm((current) => ({ ...current, order_date: event.target.value }))}
        />

        <h2 className="mz-heading">{t('orders:lines')}</h2>
        {form.lines.length === 0 ? <p className="mz-caption">{t('orders:add_first_line')}</p> : null}

        {form.lines.map((line, index) => (
          <div key={line.key} className="mz-line-card">
            <div className="mz-line-card__head">
              <strong><bdi>{line.item_name}</bdi></strong>
              <span className="mz-row" style={{ gap: 'var(--space-2)' }}>
                <Chip>{t(`glossary:${line.priced_measure === 'kg' ? 'per_kg' : 'per_piece'}`)}</Chip>
                <IconButton
                  icon="trash"
                  label={t('orders:remove_line')}
                  onClick={() =>
                    setForm((current) => ({ ...current, lines: current.lines.filter((row) => row.key !== line.key) }))
                  }
                />
              </span>
            </div>

            <QuantityInput
              priced_measure={line.priced_measure}
              value={{ qty_count: line.qty_count, qty_kg: line.qty_kg }}
              onChange={(value) => updateLine(line.key, value)}
              error={error?.fieldError(`lines.${index}.qty_kg`) || error?.fieldError(`lines.${index}.qty_count`) ? t('errors:field.required') : undefined}
            />

            <MoneyInput
              label={t('glossary:unit_price')}
              value={line.price}
              rate={documentRate}
              onChange={(value) => updateLine(line.key, { price: value, from_month_price: false })}
              error={error?.fieldError(`lines.${index}.unit_price`) ? t('errors:price_required') : undefined}
            />

            <div className="mz-row mz-row--between">
              <span className="mz-caption">
                {line.from_month_price ? t('orders:from_month_price') : t('orders:price_overridden')}
                {line.price_from_month ? <PriceFromMonth month={line.price_from_month} /> : null}
              </span>
              {totals.lines[index] ? (
                <DualAmount
                  amount_iqd={totals.lines[index]?.line_total_iqd ?? 0}
                  amount_usd_cents={totals.lines[index]?.line_total_usd_cents ?? 0}
                  primary={settlementCurrency}
                />
              ) : null}
            </div>

            {line.stock_hint ? (
              <span className="mz-caption">{t('orders:stock_hint', { quantity: line.stock_hint })}</span>
            ) : null}
          </div>
        ))}

        <Button variant="secondary" block icon="plus" onClick={() => setPicking('material')}>
          {t('orders:add_line')}
        </Button>

        <Button variant="ghost" onClick={() => setShowMore(!showMore)} aria-expanded={showMore}>
          {t('orders:more')}
        </Button>

        {showMore ? (
          <Card>
            <div className="mz-stack">
              <TextField
                label={t('glossary:notes')}
                value={form.notes}
                onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
                maxLength={2000}
              />
              <NumberField
                label={t('glossary:document_rate')}
                hint={t('orders:rate_hint')}
                decimals={4}
                value={form.rate_override}
                onChange={(event) => setForm((current) => ({ ...current, rate_override: event.target.value }))}
              />
              <RateBadge rate={documentRate} source={form.rate_override.trim() === '' ? 'global' : 'manual'} />
              {isAdmin ? (
                <label className="mz-field">
                  <span className="mz-field__label">{t('glossary:done_by')}</span>
                  <select
                    className="mz-field__control"
                    value={form.acting_user_id}
                    onChange={(event) => setForm((current) => ({ ...current, acting_user_id: event.target.value }))}
                  >
                    <option value="">{t('orders:done_by_me')}</option>
                    {(directory.data ?? [])
                      .filter((user) => user.is_active)
                      .map((user) => (
                        <option key={user.id} value={user.id}>
                          <bdi>{user.display_name}</bdi>
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}
            </div>
          </Card>
        ) : null}

        {stockWarnings.length > 0 ? (
          <div className="mz-warning" role="status">
            {stockWarnings.map((warning) => (
              <span key={warning.item_id}>
                {t('orders:stock_warning', {
                  item: warning.item_name,
                  available: warning.available,
                  requested: warning.requested,
                })}
              </span>
            ))}
          </div>
        ) : null}

        {creditWarning ? (
          <div className="mz-warning" role="status">
            {t('orders:credit_limit_warning', {
              limit: formatter.money(creditWarning.limit, creditWarning.currency),
              balance: formatter.money(creditWarning.balance_after, creditWarning.currency),
            })}
          </div>
        ) : null}

        {error && !error.fields.length ? (
          <div className="mz-warning" role="alert">
            {t(error.messageKey, { defaultValue: t('errors:INTERNAL') })}
          </div>
        ) : null}

        <TotalsFooter
          total_iqd={totals.total_iqd}
          total_usd_cents={totals.total_usd_cents}
          primary={settlementCurrency}
          lineCount={form.lines.length}
          saving={save.isPending}
          disabled={!form.customer_id || form.lines.length === 0}
          onSave={() => save.mutate()}
          saveLabel={mode === 'edit' ? t('common:save') : undefined}
          discount={
            <div className="mz-row mz-row--between" style={{ gap: 'var(--space-2)' }}>
              {/* Proposed — not requested (FR-616): the discount and its one-tap round down. */}
              <NumberField
                label={t('glossary:discount')}
                value={form.discount.amount === null ? '' : String(form.discount.amount)}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    discount: {
                      amount: event.target.value.trim() === '' ? null : Math.round(Number(event.target.value)),
                      currency: 'IQD',
                      other_amount: null,
                    },
                  }))
                }
              />
              <Button
                variant="ghost"
                onClick={() =>
                  setForm((current) => {
                    const gross = totals.total_iqd + (current.discount.amount ?? 0);
                    const rounded = Math.floor(gross / 10_000) * 10_000;
                    return {
                      ...current,
                      discount: { amount: gross - rounded, currency: 'IQD', other_amount: null },
                    };
                  })
                }
              >
                {t('orders:round_down')}
              </Button>
            </div>
          }
        />

        {picking === 'customer' ? (
          <PickerSheet
            title={t('orders:choose_customer')}
            open
            onClose={() => setPicking(null)}
            path="/customers"
            searchLabel={t('customers:search_placeholder')}
            emptyTitle={t('customers:empty')}
            toItem={(row: never) => {
              const customerRow = row as unknown as CustomerRow;
              return {
                id: customerRow.id,
                title: customerName(customerRow, t),
                subtitle: customerRow.phone ?? undefined,
                detail: customerRow.balance ? (
                  <DualAmount
                    amount_iqd={customerRow.balance.amount_iqd}
                    amount_usd_cents={customerRow.balance.amount_usd_cents}
                    primary={customerRow.balance.currency}
                    kind="derived"
                  />
                ) : undefined,
              };
            }}
            onPick={(pickedId, row) => {
              const picked = row as unknown as CustomerRow;
              setPicking(null);
              setForm((current) => ({
                ...current,
                customer_id: pickedId,
                customer_name: picked.name,
                customer_is_system: picked.is_system,
                settlement_currency: picked.settlement_currency,
                payment_type: picked.is_system ? 'cash' : current.payment_type,
              }));
            }}
          />
        ) : null}

        {picking === 'material' ? (
          <PickerSheet
            title={t('orders:choose_material')}
            open
            onClose={() => setPicking(null)}
            path="/items"
            searchLabel={t('materials:search_placeholder')}
            emptyTitle={t('materials:empty')}
            toItem={(row: never) => {
              const item = row as unknown as ItemRow;
              return {
                id: item.id,
                title: item.name,
                subtitle: item.stock.priced_complete
                  ? `${formatter.number(item.stock.priced_quantity, item.stock.priced_measure === 'kg' ? 3 : 0)} ${t(
                      `common:${item.stock.priced_measure}_symbol`,
                    )}`
                  : undefined,
                detail: item.sale ? (
                  <DualAmount amount_iqd={item.sale.amount_iqd} amount_usd_cents={item.sale.amount_usd_cents} />
                ) : undefined,
              };
            }}
            onPick={(_pickedId, row) => addLine(row as unknown as ItemRow)}
          />
        ) : null}

        {toast ? (
          <Toast
            message={toast.message}
            actionLabel={toast.orderId ? t('common:undo') : undefined}
            onAction={toast.orderId ? () => undo.mutate(toast.orderId as string) : undefined}
          />
        ) : null}

    </div>
  );
}

function quantityOf(line: FormLine): string | number | null {
  return line.priced_measure === 'count' ? line.qty_count : line.qty_kg;
}

export interface OrderDetail {
  id: string;
  number: number;
  customer_id: string;
  customer_name: string;
  customer_is_system: boolean;
  settlement_currency: Currency;
  order_date: string;
  payment_type: 'cash' | 'borrowed';
  acting_user_name: string | null;
  notes: string | null;
  rate_iqd_per_usd: string;
  rate_source: 'global' | 'manual' | 'company';
  discount_iqd: number;
  discount_usd_cents: number;
  total_iqd: number;
  total_usd_cents: number;
  status: 'unpaid' | 'partially_paid' | 'paid' | 'void';
  doc_status: 'active' | 'void';
  void_reason: string | null;
  voided_by_name: string | null;
  remaining: number;
  received_currency: Currency | null;
  version: number;
  lines: {
    id: string;
    item_id: string;
    item_name: string;
    qty_count: number | null;
    qty_kg: string | null;
    priced_measure: Measure;
    unit_price_iqd: number;
    unit_price_usd_cents: number;
    price_entered_currency: Currency;
    price_source: 'month' | 'override';
    price_from_month: string | null;
    line_total_iqd: number;
    line_total_usd_cents: number;
    note: string | null;
    cost?: { unit_iqd: number; unit_usd_cents: number } | null;
  }[];
  stock_warnings?: { item_id: string; item_name: string; available: string; requested: string }[];
  credit_limit_warning?: { limit: number; balance_after: number; currency: Currency } | null;
}

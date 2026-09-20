import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Chip, DateField, IconButton, NumberField, TextField, Toast } from '@mizan/ui';
import { computeLineTotals, convert, documentTotals } from '@mizan/money';
import type { Currency, Measure, Rate } from '@mizan/money';
import { ApiError, apiRequest, newIdempotencyKey } from '../lib/api.js';
import { AppShell } from '../components/AppShell.js';
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
import { useApp, useFormatter, usePermission } from '../lib/store.js';
import type { CompanyRow } from './CompaniesPage.js';
import type { ItemRow } from './MaterialsPage.js';
import type { PurchaseDetail } from './PurchasesPage.js';

interface FormLine {
  key: string;
  item_id: string;
  item_name: string;
  priced_measure: Measure;
  qty_count: number | null;
  qty_kg: string | null;
  price: MoneyValue;
  /** True while the price is the month's bought price; typing in it makes it an override. */
  from_month_price: boolean;
  price_from_month: string | null;
  note: string | null;
}

interface FormState {
  /** Null is a decision, not a gap: "No company — stock only" (FR-407). */
  company_id: string | null;
  company_name: string | null;
  settlement_currency: Currency;
  purchase_date: string;
  notes: string;
  rate_override: string;
  acting_user_id: string;
  discount: MoneyValue;
  lines: FormLine[];
}

/**
 * "Add material" — the purchase form (spec 3.3, flow 3.5.2), and the same form for an edit.
 *
 * It is the order form's twin with three differences the warehouse feels: the company is
 * optional, the price defaults from the month's **bought** price, and the rate under More is
 * the company's rather than the global one. Totals are computed here with the same kernel the
 * server uses, and the server recomputes them anyway (2.3.4).
 */
export function PurchaseFormPage({ mode }: { mode: 'create' | 'edit' }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const { id = '' } = useParams();
  const [searchParams] = useSearchParams();

  const existing = useQuery({
    queryKey: ['purchases', id],
    queryFn: () => apiRequest<PurchaseDetail>(`/purchases/${id}`),
    enabled: mode === 'edit',
  });

  if (mode === 'edit') {
    return (
      <AppShell title={t('purchases:edit_purchase')}>
        <QueryStates query={existing} skeletonLines={10}>
          {existing.data ? (
            <PurchaseForm
              mode="edit"
              purchaseId={id}
              version={existing.data.version}
              initial={fromPurchase(existing.data)}
            />
          ) : null}
        </QueryStates>
      </AppShell>
    );
  }

  return (
    <AppShell title={t('purchases:add_material')}>
      <PurchaseForm
        mode="create"
        initial={{
          company_id: searchParams.get('company'),
          company_name: null,
          settlement_currency: 'IQD',
          purchase_date: formatter.today(),
          notes: '',
          rate_override: '',
          acting_user_id: '',
          discount: { amount: null, currency: 'IQD', other_amount: null },
          lines: [],
        }}
      />
    </AppShell>
  );
}

/** The purchase as the form holds it, so the form is initialised once and never synced. */
function fromPurchase(purchase: PurchaseDetail): FormState {
  return {
    company_id: purchase.company_id,
    company_name: purchase.company_name,
    settlement_currency: purchase.settlement_currency ?? 'IQD',
    purchase_date: purchase.purchase_date,
    notes: purchase.notes ?? '',
    rate_override: purchase.rate_source === 'manual' ? purchase.rate_iqd_per_usd : '',
    acting_user_id: '',
    discount:
      purchase.cost && purchase.cost.discount_iqd > 0
        ? { amount: purchase.cost.discount_iqd, currency: 'IQD', other_amount: null }
        : { amount: null, currency: 'IQD', other_amount: null },
    lines: purchase.lines.map((line) => ({
      key: line.id,
      item_id: line.item_id,
      item_name: line.item_name,
      priced_measure: line.priced_measure,
      qty_count: line.qty_count,
      qty_kg: line.qty_kg,
      price: {
        amount: line.cost
          ? line.cost.price_entered_currency === 'IQD'
            ? line.cost.unit_price_iqd
            : line.cost.unit_price_usd_cents
          : null,
        currency: line.cost?.price_entered_currency ?? 'IQD',
        other_amount: null,
      },
      from_month_price: line.cost?.price_source === 'month',
      price_from_month: line.cost?.price_from_month ?? null,
      note: line.note,
    })),
  };
}

function PurchaseForm({
  mode,
  purchaseId,
  version,
  initial,
}: {
  mode: 'create' | 'edit';
  purchaseId?: string;
  version?: number;
  initial: FormState;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const maySeeBalance = usePermission('fields.see_company_balances');
  const isAdmin = useApp((state) => state.user?.role === 'admin');

  const draftId = mode === 'edit' ? (purchaseId as string) : 'new';
  const [idempotencyKey, setIdempotencyKey] = useState(
    () => readDraft<FormState>('purchase', draftId)?.idempotency_key ?? newIdempotencyKey(),
  );
  const [draftFound, setDraftFound] = useState(() => readDraft<FormState>('purchase', draftId));

  const [form, setForm] = useState<FormState>(initial);
  const [showMore, setShowMore] = useState(false);
  const [picking, setPicking] = useState<'company' | 'material' | null>(null);
  const [toast, setToast] = useState<{ message: string; purchaseId?: string } | null>(null);

  const globalRate = useQuery({
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
   * The company behind the chosen id. Its rate and settlement currency are *derived* at render
   * rather than copied into the form, so a rate set in another tab is picked up on the next
   * read instead of being stale in a draft.
   */
  const company = useQuery({
    queryKey: ['companies', form.company_id],
    queryFn: () => apiRequest<CompanyRow>(`/companies/${form.company_id}`),
    enabled: Boolean(form.company_id),
  });

  const settlementCurrency = company.data?.settlement_currency ?? form.settlement_currency;
  const companyRate = company.data?.rate?.rate_iqd_per_usd ?? null;

  // "Rate for this purchase" (2.3.3): the one typed here, else the company's, else the global.
  const documentRate: Rate =
    form.rate_override.trim() !== ''
      ? form.rate_override.trim()
      : (companyRate ?? globalRate.data?.current?.rate_iqd_per_usd ?? '1310.0000');
  const rateSource = form.rate_override.trim() !== '' ? 'manual' : companyRate ? 'company' : 'global';

  useEffect(() => {
    if (form.lines.length === 0 && !form.company_id) return;
    const timer = window.setTimeout(() => writeDraft('purchase', draftId, form, idempotencyKey), 300);
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
          unit_price_iqd:
            line.price.currency === 'IQD'
              ? (line.price.amount as number)
              : (line.price.other_amount ?? convert(line.price.amount as number, 'USD', documentRate)),
          unit_price_usd_cents:
            line.price.currency === 'USD'
              ? (line.price.amount as number)
              : (line.price.other_amount ?? convert(line.price.amount as number, 'IQD', documentRate)),
          price_entered_currency: line.price.currency,
          both_prices_typed: line.price.other_amount !== null && line.price.other_amount !== undefined,
          document_rate: documentRate,
          document_rate_source: rateSource,
        }),
      );
    const discountIqd =
      form.discount.amount === null
        ? 0
        : form.discount.currency === 'IQD'
          ? form.discount.amount
          : convert(form.discount.amount, 'USD', documentRate);
    const discountUsd =
      form.discount.amount === null
        ? 0
        : form.discount.currency === 'USD'
          ? form.discount.amount
          : convert(form.discount.amount, 'IQD', documentRate);
    return {
      lines: lineTotals,
      ...documentTotals(lineTotals, { discount_iqd: discountIqd, discount_usd_cents: discountUsd }),
    };
  }, [form, documentRate, rateSource]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        company_id: form.company_id,
        purchase_date: form.purchase_date,
        notes: form.notes.trim() === '' ? null : form.notes.trim(),
        rate_iqd_per_usd: form.rate_override.trim() === '' ? null : form.rate_override.trim(),
        acting_user_id: form.acting_user_id === '' ? null : form.acting_user_id,
        discount:
          form.discount.amount === null
            ? null
            : {
                amount: form.discount.amount,
                currency: form.discount.currency,
                other_amount: form.discount.other_amount ?? null,
              },
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
      return apiRequest<PurchaseDetail>(mode === 'edit' ? `/purchases/${purchaseId}` : '/purchases', {
        method: mode === 'edit' ? 'PUT' : 'POST',
        body,
        idempotencyKey,
      });
    },
    onSuccess: async (purchase) => {
      clearDraft('purchase', draftId);
      setIdempotencyKey(newIdempotencyKey());
      await queryClient.invalidateQueries({ queryKey: ['purchases'] });
      await queryClient.invalidateQueries({ queryKey: ['companies'] });
      await queryClient.invalidateQueries({ queryKey: ['items'] });
      if (mode === 'edit') {
        navigate(`/purchases/${purchaseId}`, { replace: true });
        return;
      }
      // The save toast with its 8-second undo (FR-405).
      setToast({
        message: t('purchases:saved', { number: formatter.number(purchase.number) }),
        purchaseId: purchase.id,
      });
      setForm((current) => ({
        ...current,
        lines: [],
        notes: '',
        discount: { amount: null, currency: 'IQD', other_amount: null },
      }));
    },
  });

  const undo = useMutation({
    mutationFn: (undoneId: string) =>
      apiRequest(`/purchases/${undoneId}/undo`, { method: 'POST', body: {}, idempotencyKey: newIdempotencyKey() }),
    onSuccess: async () => {
      setToast(null);
      await queryClient.invalidateQueries({ queryKey: ['purchases'] });
      await queryClient.invalidateQueries({ queryKey: ['companies'] });
      await queryClient.invalidateQueries({ queryKey: ['items'] });
    },
  });

  const error = save.error instanceof ApiError ? save.error : null;
  const duplicates = save.data?.duplicate_item_warning ?? [];

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
          // The bought price, in the currency it was typed in; the other side fills at the
          // purchase's rate (FR-402). A material with no bought price asks for one.
          price: item.bought
            ? { amount: item.bought.amount_iqd, currency: 'IQD', other_amount: null }
            : { amount: null, currency: 'IQD', other_amount: null },
          from_month_price: Boolean(item.bought),
          price_from_month: null,
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
            clearDraft('purchase', draftId);
            setDraftFound(null);
          }}
        />
      ) : null}

      <Card>
        <span className="mz-field__label">{t('purchases:company')}</span>
        <Button variant="secondary" block onClick={() => setPicking('company')}>
          {form.company_id ? (company.data?.name ?? form.company_name ?? t('purchases:pick_company')) : t('purchases:no_company')}
        </Button>
        {!form.company_id ? <p className="mz-caption">{t('purchases:no_company_hint')}</p> : null}
        {form.company_id && company.data?.balance && maySeeBalance ? (
          <div className="mz-row mz-row--between" style={{ marginBlockStart: 'var(--space-2)' }}>
            <span className="mz-caption">{t('companies:we_owe_them')}</span>
            <DualAmount
              amount_iqd={company.data.balance.amount_iqd}
              amount_usd_cents={company.data.balance.amount_usd_cents}
              primary={company.data.balance.currency}
              kind="derived"
            />
          </div>
        ) : null}
      </Card>

      <DateField
        label={t('purchases:purchase_date')}
        value={form.purchase_date}
        max={formatter.today()}
        onChange={(event) => setForm((current) => ({ ...current, purchase_date: event.target.value }))}
      />

      <h2 className="mz-heading">{t('orders:lines')}</h2>
      {form.lines.length === 0 ? <p className="mz-caption">{t('orders:add_first_line')}</p> : null}

      {form.lines.map((line, index) => (
        <div key={line.key} className="mz-line-card">
          <div className="mz-line-card__head">
            <strong>{line.item_name}</strong>
            <span className="mz-row" style={{ gap: 'var(--space-2)' }}>
              <Chip>{t(`glossary:${line.priced_measure === 'kg' ? 'per_kg' : 'per_piece'}`)}</Chip>
              <IconButton
                icon="trash"
                label={t('purchases:remove_line')}
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
            error={
              error?.fieldError(`lines.${index}.qty_kg`) || error?.fieldError(`lines.${index}.qty_count`)
                ? t('errors:field.required')
                : undefined
            }
          />

          <MoneyInput
            label={t('glossary:bought_price')}
            value={line.price}
            rate={documentRate}
            onChange={(value) => updateLine(line.key, { price: value, from_month_price: false })}
            error={
              error?.fieldError(`lines.${index}.unit_price`)
                ? t('purchases:price_missing', { item: line.item_name })
                : undefined
            }
          />

          <div className="mz-row mz-row--between">
            <span className="mz-caption">
              {line.from_month_price ? t('orders:from_month_price') : t('purchases:price_override')}
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

          <TextField
            label={t('purchases:line_note')}
            value={line.note ?? ''}
            onChange={(event) => updateLine(line.key, { note: event.target.value || null })}
            maxLength={500}
          />
        </div>
      ))}

      <Button variant="secondary" block icon="plus" onClick={() => setPicking('material')}>
        {t('purchases:add_line')}
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
              label={t('glossary:document_rate_purchase')}
              hint={t('orders:rate_hint')}
              decimals={4}
              value={form.rate_override}
              onChange={(event) => setForm((current) => ({ ...current, rate_override: event.target.value }))}
            />
            <RateBadge rate={documentRate} source={rateSource} />
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
                        {user.display_name}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
          </div>
        </Card>
      ) : null}

      {duplicates.length > 0 ? (
        <div className="mz-warning" role="status">
          {duplicates.map((duplicate) => (
            <span key={duplicate.item_id}>{t('purchases:duplicate_item', { item: duplicate.item_name })}</span>
          ))}
        </div>
      ) : null}

      {error && error.code === 'EDIT_WINDOW_CLOSED' ? (
        <div className="mz-warning" role="alert">
          {t('purchases:edit_window_closed')}
        </div>
      ) : null}

      {error && error.code !== 'EDIT_WINDOW_CLOSED' && !error.fields.length ? (
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
        disabled={form.lines.length === 0}
        onSave={() => save.mutate()}
        saveLabel={mode === 'edit' ? t('common:save') : t('purchases:add_material')}
        discount={
          <div className="mz-row mz-row--between" style={{ gap: 'var(--space-2)' }}>
            {/* Proposed — not requested (FR-616): a discount agreed with the supplier. */}
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
          </div>
        }
      />

      {picking === 'company' ? (
        <PickerSheet
          title={t('purchases:pick_company')}
          open
          onClose={() => setPicking(null)}
          path="/companies"
          searchLabel={t('companies:search_placeholder')}
          emptyTitle={t('companies:empty')}
          // "No company — stock only" is pinned to the top, as the wireframe asks (FR-407).
          pinned={{
            id: 'none',
            title: t('purchases:no_company'),
            subtitle: t('purchases:no_company_hint'),
            row: null as never,
          }}
          toItem={(row: never) => {
            const companyRow = row as unknown as CompanyRow;
            return {
              id: companyRow.id,
              title: companyRow.name,
              subtitle: companyRow.phone ?? undefined,
              detail: companyRow.balance ? (
                <DualAmount
                  amount_iqd={companyRow.balance.amount_iqd}
                  amount_usd_cents={companyRow.balance.amount_usd_cents}
                  primary={companyRow.balance.currency}
                  kind="derived"
                />
              ) : undefined,
            };
          }}
          onPick={(pickedId, row) => {
            setPicking(null);
            if (pickedId === 'none') {
              setForm((current) => ({ ...current, company_id: null, company_name: null, settlement_currency: 'IQD' }));
              return;
            }
            const picked = row as unknown as CompanyRow;
            setForm((current) => ({
              ...current,
              company_id: pickedId,
              company_name: picked.name,
              settlement_currency: picked.settlement_currency,
            }));
          }}
        />
      ) : null}

      {picking === 'material' ? (
        <PickerSheet
          title={t('purchases:pick_material')}
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
              detail: item.bought ? (
                <DualAmount amount_iqd={item.bought.amount_iqd} amount_usd_cents={item.bought.amount_usd_cents} />
              ) : undefined,
            };
          }}
          onPick={(_pickedId, row) => addLine(row as unknown as ItemRow)}
        />
      ) : null}

      {toast ? (
        <Toast
          message={toast.message}
          actionLabel={toast.purchaseId ? t('common:undo') : undefined}
          onAction={toast.purchaseId ? () => undo.mutate(toast.purchaseId as string) : undefined}
        />
      ) : null}
    </div>
  );
}

function quantityOf(line: FormLine): string | number | null {
  return line.priced_measure === 'count' ? line.qty_count : line.qty_kg;
}

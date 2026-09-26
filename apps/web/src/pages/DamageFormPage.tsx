import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, DateField, TextField, Toast, Toggle } from '@mizan/ui';
import type { Measure } from '@mizan/money';
import { ApiError, apiRequest, newIdempotencyKey } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { DraftBanner } from '../components/DraftBanner.js';
import { DualAmount } from '../components/DualAmount.js';
import { PickerSheet } from '../components/PickerSheet.js';
import { QuantityInput } from '../components/QuantityInput.js';
import { QueryStates } from '../components/states.js';
import { clearDraft, readDraft, writeDraft } from '../lib/drafts.js';
import { useApp, useFormatter, usePermission } from '../lib/store.js';
import type { DamageAttribution } from '../components/chips.js';
import type { CompanyRow } from './CompaniesPage.js';
import type { DamageDetail } from './DamagesPage.js';
import type { ItemRow } from './MaterialsPage.js';
import type { OrderRow } from './OrdersPage.js';
import type { PurchaseRow } from './PurchasesPage.js';

interface FormState {
  item_id: string | null;
  item_name: string | null;
  priced_measure: Measure;
  stock_hint: string | null;
  qty_count: number | null;
  qty_kg: string | null;
  damage_date: string;
  reason: string;
  attribution: DamageAttribution;
  order_id: string | null;
  order_label: string | null;
  company_id: string | null;
  company_name: string | null;
  purchase_id: string | null;
  purchase_label: string | null;
  is_returnable: boolean;
  notes: string;
  acting_user_id: string;
}

/**
 * "Record damage" (wireframe 3.4.3, flow 3.5.5), and the same form for an edit.
 *
 * The order of the fields is the order of the questions on the floor: which material, how much,
 * when, where did it come from, can it go back, and why. The footer says what the save will do
 * to stock **before** it is tapped, because that is the one consequence an employee cannot see
 * anywhere else (FR-804).
 */
export function DamageFormPage({ mode }: { mode: 'create' | 'edit' }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const { id = '' } = useParams();
  const [searchParams] = useSearchParams();

  const existing = useQuery({
    queryKey: ['damages', id],
    queryFn: () => apiRequest<DamageDetail>(`/damages/${id}`),
    enabled: mode === 'edit',
  });

  usePageTitle(mode === 'edit' ? t('damages:edit') : t('damages:record'));

  if (mode === 'edit') {
    return (
      <>
        <QueryStates query={existing} skeletonLines={8}>
          {existing.data ? (
            <DamageForm mode="edit" damageId={id} version={existing.data.version} initial={fromDamage(existing.data)} />
          ) : null}
        </QueryStates>
      </>
    );
  }

  return (
    <>
      <DamageForm
        mode="create"
        initial={{
          item_id: searchParams.get('item'),
          item_name: null,
          priced_measure: 'kg',
          stock_hint: null,
          qty_count: null,
          qty_kg: null,
          damage_date: formatter.today(),
          reason: '',
          attribution: 'none',
          order_id: null,
          order_label: null,
          company_id: null,
          company_name: null,
          purchase_id: null,
          purchase_label: null,
          is_returnable: false,
          notes: '',
          acting_user_id: '',
        }}
      />
    </>
  );
}

function fromDamage(damage: DamageDetail): FormState {
  return {
    item_id: damage.item_id,
    item_name: damage.item_name,
    priced_measure: damage.priced_measure,
    stock_hint: null,
    qty_count: damage.qty_count,
    qty_kg: damage.qty_kg,
    damage_date: damage.damage_date,
    reason: damage.reason ?? '',
    attribution: damage.attribution,
    order_id: damage.order_id,
    order_label: damage.order_number === null ? null : String(damage.order_number),
    company_id: damage.company_id,
    company_name: damage.company_name,
    purchase_id: damage.purchase_id,
    purchase_label: damage.purchase_number === null ? null : String(damage.purchase_number),
    is_returnable: damage.is_returnable,
    notes: damage.notes ?? '',
    acting_user_id: '',
  };
}

const ATTRIBUTIONS: DamageAttribution[] = ['none', 'customer_order', 'us', 'company'];

function DamageForm({
  mode,
  damageId,
  version,
  initial,
}: {
  mode: 'create' | 'edit';
  damageId?: string;
  version?: number;
  initial: FormState;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isAdmin = useApp((state) => state.user?.role === 'admin');
  const maySeeBought = usePermission('fields.see_bought_price');

  const draftId = mode === 'edit' ? (damageId as string) : 'new';
  const [idempotencyKey, setIdempotencyKey] = useState(
    () => readDraft<FormState>('damage', draftId)?.idempotency_key ?? newIdempotencyKey(),
  );
  const [draftFound, setDraftFound] = useState(() => readDraft<FormState>('damage', draftId));

  const [form, setForm] = useState<FormState>(initial);
  const [picking, setPicking] = useState<'material' | 'order' | 'company' | 'purchase' | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const directory = useQuery({
    queryKey: ['users', 'directory'],
    queryFn: () => apiRequest<{ id: string; display_name: string; is_active: boolean }[]>('/users/directory'),
    enabled: isAdmin && showMore,
  });

  /** The material behind an id that came from a link, so its measure and stock are current. */
  const item = useQuery({
    queryKey: ['items', form.item_id],
    queryFn: () => apiRequest<ItemRow>(`/items/${form.item_id}`),
    enabled: Boolean(form.item_id),
  });

  const pricedMeasure: Measure = item.data
    ? item.data.stock.priced_measure
    : form.priced_measure;
  const stockHint = item.data?.stock.priced_complete
    ? `${formatter.number(item.data.stock.priced_quantity, item.data.stock.priced_measure === 'kg' ? 3 : 0)} ${t(
        `common:${item.data.stock.priced_measure}_symbol`,
      )}`
    : form.stock_hint;

  useEffect(() => {
    if (!form.item_id && form.qty_kg === null && form.qty_count === null) return;
    const timer = window.setTimeout(() => writeDraft('damage', draftId, form, idempotencyKey), 300);
    return () => window.clearTimeout(timer);
  }, [form, draftId, idempotencyKey]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        item_id: form.item_id,
        qty_count: form.qty_count,
        qty_kg: form.qty_kg,
        damage_date: form.damage_date,
        reason: form.reason.trim() === '' ? null : form.reason.trim(),
        attribution: form.attribution,
        order_id: form.attribution === 'customer_order' ? form.order_id : null,
        company_id: form.attribution === 'company' ? form.company_id : null,
        purchase_id: form.attribution === 'company' ? form.purchase_id : null,
        is_returnable: form.is_returnable,
        notes: form.notes.trim() === '' ? null : form.notes.trim(),
        acting_user_id: form.acting_user_id === '' ? null : form.acting_user_id,
        ...(mode === 'edit' ? { version } : {}),
      };
      return apiRequest<DamageDetail>(mode === 'edit' ? `/damages/${damageId}` : '/damages', {
        method: mode === 'edit' ? 'PATCH' : 'POST',
        body,
        idempotencyKey,
      });
    },
    onSuccess: async (damage) => {
      clearDraft('damage', draftId);
      setIdempotencyKey(newIdempotencyKey());
      await queryClient.invalidateQueries({ queryKey: ['damages'] });
      await queryClient.invalidateQueries({ queryKey: ['items'] });
      navigate(`/damages/${damage.id}`, { replace: true });
    },
  });

  const error = save.error instanceof ApiError ? save.error : null;
  const quantity = pricedMeasure === 'kg' ? form.qty_kg : form.qty_count;
  const canSave =
    Boolean(form.item_id) &&
    quantity !== null &&
    Number(quantity) > 0 &&
    (form.attribution !== 'customer_order' || Boolean(form.order_id)) &&
    (form.attribution !== 'company' || Boolean(form.company_id));

  /** The sentence of FR-804, decided by the attribution alone. */
  const stockSentence =
    form.attribution === 'customer_order'
      ? t('damages:stock_unchanged')
      : t('damages:stock_will_fall', {
          // The typed text is normalised to the three decimals it will be stored with, so the
          // sentence says what the save will do rather than what was typed.
          quantity:
            pricedMeasure === 'kg'
              ? `${formatter.number(Number(form.qty_kg ?? 0), 3)} ${t('common:kg_symbol')}`
              : `${formatter.number(form.qty_count ?? 0)} ${t('common:count_symbol')}`,
        });

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
            clearDraft('damage', draftId);
            setDraftFound(null);
          }}
        />
      ) : null}

      <Card>
        <span className="mz-field__label">{t('glossary:material')}</span>
        <Button variant="secondary" block onClick={() => setPicking('material')} disabled={mode === 'edit'}>
          {item.data?.name ?? form.item_name ?? t('damages:pick_material')}
        </Button>
        {stockHint ? (
          <span className="mz-caption">{t('orders:stock_hint', { quantity: stockHint })}</span>
        ) : null}
      </Card>

      <h2 className="mz-heading">{t('damages:quantity')}</h2>
      <QuantityInput
        priced_measure={pricedMeasure}
        value={{ qty_count: form.qty_count, qty_kg: form.qty_kg }}
        onChange={(value) => setForm((current) => ({ ...current, ...value }))}
        error={
          error?.fieldError('qty_kg') || error?.fieldError('qty_count') ? t('errors:field.required') : undefined
        }
      />

      <DateField
        label={t('damages:damage_date')}
        value={form.damage_date}
        max={formatter.today()}
        onChange={(event) => setForm((current) => ({ ...current, damage_date: event.target.value }))}
      />

      {/* The four tiles of wireframe 3.4.3: attribution is optional and stays optional. */}
      <h2 className="mz-heading">{t('damages:attribution')}</h2>
      <div className="mz-tiles">
        {ATTRIBUTIONS.map((value) => (
          <button
            key={value}
            type="button"
            className={`mz-tile${form.attribution === value ? ' mz-tile--selected' : ''}`}
            aria-pressed={form.attribution === value}
            onClick={() =>
              setForm((current) => ({
                ...current,
                attribution: value,
                order_id: value === 'customer_order' ? current.order_id : null,
                order_label: value === 'customer_order' ? current.order_label : null,
                company_id: value === 'company' ? current.company_id : null,
                company_name: value === 'company' ? current.company_name : null,
                purchase_id: value === 'company' ? current.purchase_id : null,
                purchase_label: value === 'company' ? current.purchase_label : null,
              }))
            }
          >
            {t(`damages:attribution.${value}`)}
          </button>
        ))}
      </div>

      {form.attribution === 'customer_order' ? (
        <Card>
          <span className="mz-field__label">{t('damages:pick_order')}</span>
          <Button variant="secondary" block onClick={() => setPicking('order')}>
            {form.order_label ? t('orders:number', { number: formatter.number(form.order_label) }) : t('damages:pick_order')}
          </Button>
        </Card>
      ) : null}

      {form.attribution === 'company' ? (
        <Card>
          <div className="mz-stack">
            <div>
              <span className="mz-field__label">{t('damages:pick_company')}</span>
              <Button variant="secondary" block onClick={() => setPicking('company')}>
                <bdi>{form.company_name ?? t('damages:pick_company')}</bdi>
              </Button>
            </div>
            {form.company_id ? (
              <div>
                <span className="mz-field__label">{t('damages:pick_purchase')}</span>
                <Button variant="ghost" block onClick={() => setPicking('purchase')}>
                  {form.purchase_label
                    ? t('purchases:number', { number: formatter.number(form.purchase_label) })
                    : t('damages:no_purchase')}
                </Button>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Toggle
        label={t('damages:is_returnable')}
        checked={form.is_returnable}
        onChange={(checked) => setForm((current) => ({ ...current, is_returnable: checked }))}
      />

      <TextField
        label={t('damages:reason')}
        hint={t('damages:reason_hint')}
        value={form.reason}
        onChange={(event) => setForm((current) => ({ ...current, reason: event.target.value }))}
        maxLength={2000}
      />

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

      {error && error.code === 'EDIT_WINDOW_CLOSED' ? (
        <div className="mz-warning" role="alert">
          {t('damages:edit_closed')}
        </div>
      ) : null}

      {error && error.code !== 'EDIT_WINDOW_CLOSED' && !error.fields.length ? (
        <div className="mz-warning" role="alert">
          {t(error.messageKey, { defaultValue: t('errors:INTERNAL') })}
        </div>
      ) : null}

      {/* The stock-effect sentence sits with the save button, where the decision is made. */}
      <div className="mz-sticky-footer">
        <div className="mz-totals">
          <span>{stockSentence}</span>
          {maySeeBought && item.data?.bought && quantity !== null ? (
            <DualAmount
              amount_iqd={Math.round(item.data.bought.amount_iqd * Number(quantity))}
              amount_usd_cents={Math.round(item.data.bought.amount_usd_cents * Number(quantity))}
            />
          ) : null}
        </div>
        <Button block loading={save.isPending} disabled={!canSave} onClick={() => save.mutate()}>
          {mode === 'edit' ? t('common:save') : t('damages:record')}
        </Button>
      </div>

      {picking === 'material' ? (
        <PickerSheet
          title={t('damages:pick_material')}
          open
          onClose={() => setPicking(null)}
          path="/items"
          searchLabel={t('materials:search_placeholder')}
          emptyTitle={t('materials:empty')}
          toItem={(row: never) => {
            const material = row as unknown as ItemRow;
            return {
              id: material.id,
              title: material.name,
              subtitle: material.stock.priced_complete
                ? `${formatter.number(material.stock.priced_quantity, material.stock.priced_measure === 'kg' ? 3 : 0)} ${t(
                    `common:${material.stock.priced_measure}_symbol`,
                  )}`
                : undefined,
            };
          }}
          onPick={(pickedId, row) => {
            const material = row as unknown as ItemRow;
            setPicking(null);
            setForm((current) => ({
              ...current,
              item_id: pickedId,
              item_name: material.name,
              priced_measure: material.stock.priced_measure,
              stock_hint: null,
              qty_count: null,
              qty_kg: null,
            }));
          }}
        />
      ) : null}

      {picking === 'order' ? (
        <PickerSheet
          title={t('damages:pick_order')}
          open
          onClose={() => setPicking(null)}
          // Filtered by the material, as FR-802 asks: the goods came back from an order that
          // carried them.
          path={`/orders?item_id=${form.item_id ?? ''}`}
          searchLabel={t('orders:search_hint')}
          emptyTitle={t('orders:empty')}
          toItem={(row: never) => {
            const order = row as unknown as OrderRow;
            return {
              id: order.id,
              title: t('orders:number', { number: formatter.number(order.number) }),
              subtitle: `${order.customer_name} · ${formatter.date(order.order_date)}`,
            };
          }}
          onPick={(pickedId, row) => {
            const order = row as unknown as OrderRow;
            setPicking(null);
            setForm((current) => ({ ...current, order_id: pickedId, order_label: String(order.number) }));
          }}
        />
      ) : null}

      {picking === 'company' ? (
        <PickerSheet
          title={t('damages:pick_company')}
          open
          onClose={() => setPicking(null)}
          path="/companies"
          searchLabel={t('companies:search_placeholder')}
          emptyTitle={t('companies:empty')}
          toItem={(row: never) => {
            const company = row as unknown as CompanyRow;
            return { id: company.id, title: company.name, subtitle: company.phone ?? undefined };
          }}
          onPick={(pickedId, row) => {
            const company = row as unknown as CompanyRow;
            setPicking(null);
            setForm((current) => ({
              ...current,
              company_id: pickedId,
              company_name: company.name,
              purchase_id: null,
              purchase_label: null,
            }));
          }}
        />
      ) : null}

      {picking === 'purchase' ? (
        <PickerSheet
          title={t('damages:pick_purchase')}
          open
          onClose={() => setPicking(null)}
          path={`/purchases?company_id=${form.company_id ?? ''}&item_id=${form.item_id ?? ''}`}
          searchLabel={t('purchases:search_hint')}
          emptyTitle={t('purchases:empty')}
          toItem={(row: never) => {
            const purchase = row as unknown as PurchaseRow;
            return {
              id: purchase.id,
              title: t('purchases:number', { number: formatter.number(purchase.number) }),
              subtitle: formatter.date(purchase.purchase_date),
            };
          }}
          onPick={(pickedId, row) => {
            const purchase = row as unknown as PurchaseRow;
            setPicking(null);
            setForm((current) => ({ ...current, purchase_id: pickedId, purchase_label: String(purchase.number) }));
          }}
        />
      ) : null}

      {toast ? <Toast message={toast} actionLabel={t('common:close')} onAction={() => setToast(null)} /> : null}
    </div>
  );
}

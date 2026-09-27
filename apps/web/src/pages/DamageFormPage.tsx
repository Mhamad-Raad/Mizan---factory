import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, DateField, Icon, StickyFooter, TextField } from '@mizan/ui';
import { Decimal, roundHalfAwayFromZero } from '@mizan/money';
import type { Currency, Measure } from '@mizan/money';
import { ApiError, apiRequest, newIdempotencyKey } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { DraftBanner } from '../components/DraftBanner.js';
import { DualAmount } from '../components/DualAmount.js';
import { PickerSheet } from '../components/PickerSheet.js';
import { QuantityInput } from '../components/QuantityInput.js';
import { QueryStates } from '../components/states.js';
import { clearDraft, readDraft, writeDraft } from '../lib/drafts.js';
import { useApp, useFormatter, usePermission } from '../lib/store.js';
import type { CustomerRow } from './CustomersPage.js';
import { quantityOf } from './DamagesPage.js';
import type { DamageDetail } from './DamagesPage.js';
import type { ItemRow } from './MaterialsPage.js';

interface FormState {
  item_id: string | null;
  item_name: string | null;
  priced_measure: Measure;
  stock_hint: string | null;
  qty_count: number | null;
  qty_kg: string | null;
  damage_date: string;
  reason: string;
  /** Ours (a loss) or a company's (they owe us its cost until they pay it back, D-062). */
  attribution: 'us' | 'company';
  company_id: string | null;
  company_name: string | null;
  notes: string;
  acting_user_id: string;
}

/**
 * "Record damage" (wireframe 3.4.3, flow 3.5.5), rebuilt for the warehouse model (D-062).
 *
 * The questions on the floor, in order: which material, how much, when, and who did it — we did
 * (a loss, nothing more) or a company did (its cost goes on their account until they pay it back).
 * The footer says what the save will do to stock **before** it is tapped (FR-804).
 *
 * A saved damage has taken its stock from the buys and, for a company, put its cost on their
 * account; so an edit changes only the texts, and anything else is a void and a new record.
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
      <QueryStates query={existing} skeletonLines={6}>
        {existing.data ? <DamageTextsForm damage={existing.data} /> : null}
      </QueryStates>
    );
  }

  return (
    <DamageForm
      initial={{
        item_id: searchParams.get('item'),
        item_name: null,
        priced_measure: 'kg',
        stock_hint: null,
        qty_count: null,
        qty_kg: null,
        damage_date: formatter.today(),
        reason: '',
        attribution: 'us',
        company_id: null,
        company_name: null,
        notes: '',
        acting_user_id: '',
      }}
    />
  );
}

const WHO: FormState['attribution'][] = ['us', 'company'];

/** One buy of the material, as `/items/:id/lots` returns it (D-062); costs absent without the flag. */
interface LotRow {
  remaining: string;
  unit_cost_iqd?: number;
  unit_cost_usd_cents?: number;
  entered_currency: Currency;
}

/**
 * What a quantity of broken goods costs us, taken from the buys oldest first — the same order the
 * save takes them in — in both currencies, from each buy's own stored pair. Past the last buy the
 * latest buy's price stands in, as it does on the server. A preview only: the saved record is
 * valued by the server.
 */
function costOf(
  lots: readonly LotRow[],
  quantity: string,
): { amount_iqd: number; amount_usd_cents: number; currency: Currency } | null {
  const priced = lots.filter((lot) => lot.unit_cost_iqd !== undefined && lot.unit_cost_usd_cents !== undefined);
  if (priced.length === 0 || !(Number(quantity) > 0)) return null;
  // Decimal all the way, rounded once per currency at the end: money never passes through a
  // float, even in a preview (rule 1).
  let left = new Decimal(quantity);
  let iqd = new Decimal(0);
  let usd = new Decimal(0);
  for (const lot of priced) {
    if (left.lte(0)) break;
    const take = Decimal.min(new Decimal(lot.remaining), left);
    if (take.lte(0)) continue;
    iqd = iqd.plus(take.times(lot.unit_cost_iqd ?? 0));
    usd = usd.plus(take.times(lot.unit_cost_usd_cents ?? 0));
    left = left.minus(take);
  }
  const latest = priced[priced.length - 1] as LotRow;
  if (left.gt(0)) {
    iqd = iqd.plus(left.times(latest.unit_cost_iqd ?? 0));
    usd = usd.plus(left.times(latest.unit_cost_usd_cents ?? 0));
  }
  return {
    amount_iqd: roundHalfAwayFromZero(iqd),
    amount_usd_cents: roundHalfAwayFromZero(usd),
    currency: latest.entered_currency,
  };
}

function DamageForm({ initial }: { initial: FormState }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isAdmin = useApp((state) => state.user?.role === 'admin');
  const maySeeBought = usePermission('fields.see_bought_price');

  const draftId = 'new';
  const [idempotencyKey, setIdempotencyKey] = useState(
    () => readDraft<FormState>('damage', draftId)?.idempotency_key ?? newIdempotencyKey(),
  );
  const [draftFound, setDraftFound] = useState(() => {
    const draft = readDraft<FormState>('damage', draftId);
    // A draft from before D-062 names attributions the form no longer offers.
    return draft && (draft.value.attribution === 'us' || draft.value.attribution === 'company') ? draft : null;
  });

  const [form, setForm] = useState<FormState>(initial);
  const [picking, setPicking] = useState<'material' | 'company' | null>(null);

  const directory = useQuery({
    queryKey: ['users', 'directory'],
    queryFn: () => apiRequest<{ id: string; display_name: string; is_active: boolean }[]>('/users/directory'),
    enabled: isAdmin,
  });

  /** The material behind an id that came from a link, so its measure and stock are current. */
  const item = useQuery({
    queryKey: ['items', form.item_id],
    queryFn: () => apiRequest<ItemRow>(`/items/${form.item_id}`),
    enabled: Boolean(form.item_id),
  });

  const pricedMeasure: Measure = item.data ? item.data.stock.priced_measure : form.priced_measure;
  const stockHint = item.data?.stock.priced_complete
    ? `${formatter.quantity(item.data.stock.priced_quantity)} ${t(
        `common:${item.data.stock.priced_measure}_symbol`,
      )}`
    : form.stock_hint;

  useEffect(() => {
    if (!form.item_id && form.qty_kg === null && form.qty_count === null) return;
    const timer = window.setTimeout(() => writeDraft('damage', draftId, form, idempotencyKey), 300);
    return () => window.clearTimeout(timer);
  }, [form, draftId, idempotencyKey]);

  const save = useMutation({
    mutationFn: () =>
      apiRequest<DamageDetail>('/damages', {
        method: 'POST',
        body: {
          item_id: form.item_id,
          qty_count: form.qty_count,
          qty_kg: form.qty_kg,
          damage_date: form.damage_date,
          reason: form.reason.trim() === '' ? null : form.reason.trim(),
          attribution: form.attribution,
          company_id: form.attribution === 'company' ? form.company_id : null,
          notes: form.notes.trim() === '' ? null : form.notes.trim(),
          acting_user_id: form.acting_user_id === '' ? null : form.acting_user_id,
        },
        idempotencyKey,
      }),
    onSuccess: async (damage) => {
      clearDraft('damage', draftId);
      setIdempotencyKey(newIdempotencyKey());
      await queryClient.invalidateQueries({ queryKey: ['damages'] });
      await queryClient.invalidateQueries({ queryKey: ['items'] });
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
      navigate(`/damages/${damage.id}`, { replace: true });
    },
  });

  const error = save.error instanceof ApiError ? save.error : null;
  const quantity = pricedMeasure === 'kg' ? form.qty_kg : form.qty_count;
  const canSave =
    Boolean(form.item_id) &&
    quantity !== null &&
    Number(quantity) > 0 &&
    (form.attribution !== 'company' || Boolean(form.company_id));

  /** What the broken goods cost us: taken from the buys oldest first, as the save will (D-062). */
  const lots = useQuery({
    queryKey: ['items', form.item_id, 'lots'],
    queryFn: () => apiRequest<{ items: LotRow[] }>(`/items/${form.item_id}/lots`),
    enabled: Boolean(form.item_id) && maySeeBought,
  });
  const estimate = maySeeBought && quantity !== null ? costOf(lots.data?.items ?? [], String(quantity)) : null;

  const unit = t(pricedMeasure === 'kg' ? 'common:kg_symbol' : 'common:count_symbol');
  const typed = pricedMeasure === 'kg' ? Number(form.qty_kg ?? 0) : Number(form.qty_count ?? 0);
  const inStock = item.data?.stock.priced_complete ? Number(item.data.stock.priced_quantity) : null;

  // Whoever did it, the goods leave stock (FR-804); the sentence says how much before the save.
  const stockSentence = t('damages:stock_will_fall', {
    quantity: `${formatter.quantity(typed)} ${unit}`,
  });

  return (
    <div className="mz-stack mz-form-page mz-damage-form">
      {draftFound ? (
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

      {/* 1 — What broke: the material, how much and when, with stock before and after. */}
      <Card>
        <div className="mz-stack">
          <div>
            <h2 className="mz-heading">{t('damages:what_broke')}</h2>
            <p className="mz-muted">{t('damages:what_broke_hint')}</p>
          </div>
          <div className="mz-form-grid">
            <div className="mz-form-grid__wide mz-field">
              <span className="mz-field__label">{t('glossary:material')}</span>
              <button type="button" className="mz-picker-field" onClick={() => setPicking('material')}>
                <Icon name="materials" size={18} />
                <span className="mz-picker-field__value">
                  {item.data?.name ?? form.item_name ? (
                    <bdi>{item.data?.name ?? form.item_name}</bdi>
                  ) : (
                    <span className="mz-muted">{t('damages:pick_material')}</span>
                  )}
                </span>
                <Icon name="chevron" size={16} />
              </button>
              {/* The stock panel below says it better; the hint is for when it cannot be drawn. */}
              {stockHint && inStock === null ? (
                <span className="mz-field__hint">{t('orders:stock_hint', { quantity: stockHint })}</span>
              ) : null}
            </div>
            <div className="mz-form-grid__wide">
              <span className="mz-field__label">{t('damages:quantity')}</span>
              <QuantityInput
                priced_measure={pricedMeasure}
                value={{ qty_count: form.qty_count, qty_kg: form.qty_kg }}
                onChange={(value) => setForm((current) => ({ ...current, ...value }))}
                error={
                  error?.fieldError('qty_kg') || error?.fieldError('qty_count') ? t('errors:field.required') : undefined
                }
              />
            </div>
            <DateField
              label={t('damages:damage_date')}
              value={form.damage_date}
              max={formatter.today()}
              onChange={(event) => setForm((current) => ({ ...current, damage_date: event.target.value }))}
            />
            {/* Stock now and after the save, side by side with the date on a desktop. */}
            {inStock !== null ? (
              <div className="mz-damage-stock" aria-live="polite">
                <span className="mz-damage-stock__cell">
                  <span className="mz-caption">{t('damages:stock_now')}</span>
                  <strong data-tabular>
                    {formatter.quantity(inStock)} {unit}
                  </strong>
                </span>
                <Icon name="next" size={16} />
                <span className="mz-damage-stock__cell">
                  <span className="mz-caption">{t('damages:stock_after')}</span>
                  <strong data-tabular className={inStock - typed < 0 ? 'mz-owed' : undefined}>
                    {formatter.quantity(inStock - typed)} {unit}
                  </strong>
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </Card>

      {/* 2 — Who broke it, and what that means for the money. */}
      <Card>
        <div className="mz-stack">
          <h2 className="mz-heading">{t('damages:who_did_it')}</h2>
          <div className="mz-damage-who" role="radiogroup" aria-label={t('damages:who_did_it')}>
            {WHO.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={form.attribution === value}
                className={`mz-damage-who__option${form.attribution === value ? ' mz-damage-who__option--on' : ''}`}
                onClick={() =>
                  setForm((current) => ({
                    ...current,
                    attribution: value,
                    company_id: value === 'company' ? current.company_id : null,
                    company_name: value === 'company' ? current.company_name : null,
                  }))
                }
              >
                <span className="mz-damage-who__icon" aria-hidden="true">
                  <Icon name={value === 'us' ? 'warning' : 'companies'} size={20} />
                </span>
                <span className="mz-damage-who__body">
                  <span className="mz-damage-who__title">{t(`damages:who.${value}`)}</span>
                  <span className="mz-caption">{t(`damages:who_${value}_hint`)}</span>
                </span>
                {form.attribution === value ? (
                  <span className="mz-option__check" aria-hidden="true">
                    <Icon name="check" size={14} />
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          {form.attribution === 'company' ? (
            <div className="mz-field">
              <span className="mz-field__label">{t('damages:pick_owing_company')}</span>
              <button type="button" className="mz-picker-field" onClick={() => setPicking('company')}>
                <Icon name="companies" size={18} />
                <span className="mz-picker-field__value">
                  {form.company_name ? (
                    <bdi>{form.company_name}</bdi>
                  ) : (
                    <span className="mz-muted">{t('damages:pick_owing_company')}</span>
                  )}
                </span>
                <Icon name="chevron" size={16} />
              </button>
            </div>
          ) : null}

          {/* What the save will mean, in money, before it is made. */}
          {estimate ? (
            <div className="mz-damage-effect">
              <span className="mz-caption">
                {form.attribution === 'company'
                  ? t('damages:effect_company', { company: form.company_name ?? t('damages:who.company') })
                  : t('damages:effect_us')}
              </span>
              <DualAmount
                amount_iqd={estimate.amount_iqd}
                amount_usd_cents={estimate.amount_usd_cents}
                primary={estimate.currency}
                kind="derived"
              />
            </div>
          ) : null}
        </div>
      </Card>

      {/* 3 — The words: why it happened, and anything else worth keeping. */}
      <Card>
        <div className="mz-stack">
          <h2 className="mz-heading">{t('damages:details')}</h2>
          <div className="mz-form-grid">
            <div className="mz-form-grid__wide">
              <TextField
                label={t('damages:reason')}
                hint={t('damages:reason_hint')}
                value={form.reason}
                onChange={(event) => setForm((current) => ({ ...current, reason: event.target.value }))}
                maxLength={2000}
              />
            </div>
            {/* Beside "Done by" for an admin; the full width for everyone else. */}
            <div className={isAdmin ? undefined : 'mz-form-grid__wide'}>
              <TextField
                label={t('glossary:notes')}
                hint={t('common:optional')}
                value={form.notes}
                onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
                maxLength={2000}
              />
            </div>
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
        </div>
      </Card>

      {error && !error.fields.length ? (
        <div className="mz-warning" role="alert">
          {t(error.messageKey, { defaultValue: t('errors:INTERNAL') })}
        </div>
      ) : null}

      {/* The stock-effect sentence sits with the save button, where the decision is made; on a
          phone the bar stays in the thumb zone, on a desktop it closes the form, Save at the end. */}
      <StickyFooter>
        <span className="mz-damage-form__summary">{quantity !== null && typed > 0 ? stockSentence : null}</span>
        <Button type="button" block loading={save.isPending} disabled={!canSave} onClick={() => save.mutate()}>
          {t('damages:record')}
        </Button>
        {/* A phone has the app bar's Back; the footer there stays one button tall. */}
        <span className="mz-damage-form__cancel">
          <Button type="button" variant="ghost" block onClick={() => navigate('/damages')}>
            {t('glossary:cancel')}
          </Button>
        </span>
      </StickyFooter>

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
                ? `${formatter.quantity(material.stock.priced_quantity)} ${t(
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

      {picking === 'company' ? (
        <PickerSheet
          title={t('damages:pick_owing_company')}
          open
          onClose={() => setPicking(null)}
          // `/companies` lists the real accounts only — never the walk-in, who cannot owe us.
          path="/companies"
          searchLabel={t('companies:search_placeholder')}
          emptyTitle={t('companies:empty')}
          toItem={(row: never) => {
            const company = row as unknown as CustomerRow;
            return { id: company.id, title: company.name, subtitle: company.phone ?? undefined };
          }}
          onPick={(pickedId, row) => {
            const company = row as unknown as CustomerRow;
            setPicking(null);
            setForm((current) => ({ ...current, company_id: pickedId, company_name: company.name }));
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Editing a saved damage: the reason and the notes only. Its quantity, date and who did it are
 * what it booked — stock taken from the buys, and a company's debt — so changing them is a void
 * and a new record, which the page says rather than offering fields that would be refused.
 */
function DamageTextsForm({ damage }: { damage: DamageDetail }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState(damage.reason ?? '');
  const [notes, setNotes] = useState(damage.notes ?? '');

  const save = useMutation({
    mutationFn: () =>
      apiRequest<DamageDetail>(`/damages/${damage.id}`, {
        method: 'PATCH',
        body: {
          version: damage.version,
          reason: reason.trim() === '' ? null : reason.trim(),
          notes: notes.trim() === '' ? null : notes.trim(),
        },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['damages'] });
      navigate(`/damages/${damage.id}`, { replace: true });
    },
  });
  const error = save.error instanceof ApiError ? save.error : null;

  return (
    <div className="mz-stack mz-form-page mz-damage-form">
      {/* What was recorded — read-only: it has taken its stock and, for a company, its debt. */}
      <Card>
        <div className="mz-stack">
          <div>
            <h2 className="mz-heading">{t('damages:number', { number: formatter.number(damage.number) })}</h2>
            <p className="mz-muted">{t('damages:edit_texts_only')}</p>
          </div>
          <dl className="mz-damage-facts">
            <div>
              <dt className="mz-caption">{t('glossary:material')}</dt>
              <dd>
                <bdi>{damage.item_name}</bdi>
              </dd>
            </div>
            <div>
              <dt className="mz-caption">{t('damages:quantity')}</dt>
              <dd data-tabular>{quantityOf(damage, formatter, t)}</dd>
            </div>
            <div>
              <dt className="mz-caption">{t('damages:damage_date')}</dt>
              <dd data-tabular>{formatter.date(damage.damage_date)}</dd>
            </div>
            <div>
              <dt className="mz-caption">{t('damages:who_did_it')}</dt>
              <dd>{damage.attribution === 'company' ? <bdi>{damage.company_name}</bdi> : t('damages:who.us')}</dd>
            </div>
            {damage.cost && damage.cost.est_value_iqd !== null ? (
              <div>
                <dt className="mz-caption">{t('damages:value_column')}</dt>
                <dd>
                  <DualAmount
                    amount_iqd={damage.cost.est_value_iqd}
                    amount_usd_cents={damage.cost.est_value_usd_cents ?? 0}
                  />
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      </Card>

      <Card>
        <div className="mz-stack">
          <h2 className="mz-heading">{t('damages:details')}</h2>
          <div className="mz-form-grid">
            <div className="mz-form-grid__wide">
              <TextField
                label={t('damages:reason')}
                hint={t('damages:reason_hint')}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={2000}
              />
            </div>
            <div className="mz-form-grid__wide">
              <TextField
                label={t('glossary:notes')}
                hint={t('common:optional')}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                maxLength={2000}
              />
            </div>
          </div>
        </div>
      </Card>

      {error ? (
        <div className="mz-warning" role="alert">
          {t(error.messageKey, { defaultValue: t('errors:INTERNAL') })}
        </div>
      ) : null}

      <StickyFooter>
        <Button type="button" block loading={save.isPending} onClick={() => save.mutate()}>
          {t('common:save')}
        </Button>
        <span className="mz-damage-form__cancel">
          <Button type="button" variant="ghost" block onClick={() => navigate(`/damages/${damage.id}`)}>
            {t('glossary:cancel')}
          </Button>
        </span>
      </StickyFooter>
    </div>
  );
}

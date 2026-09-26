import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  DateField,
  EmptyState,
  Icon,
  IconButton,
  NumberField,
  TextField,
  Toast,
} from '@mizan/ui';
import { convert } from '@mizan/money';
import type { Rate } from '@mizan/money';
import { ApiError, apiRequest, newIdempotencyKey } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { DraftBanner } from '../components/DraftBanner.js';
import { MoneyInput } from '../components/MoneyInput.js';
import type { MoneyValue } from '../components/MoneyInput.js';
import { PickerSheet } from '../components/PickerSheet.js';
import { QueryStates } from '../components/states.js';
import { TotalsFooter } from '../components/TotalsFooter.js';
import { clearDraft, readDraft, writeDraft } from '../lib/drafts.js';
import { useFormatter } from '../lib/store.js';
import type { ItemRow } from './MaterialsPage.js';
import type { PurchaseDetail } from './PurchasesPage.js';

interface FormLine {
  key: string;
  item_id: string;
  item_name: string;
  /** How much was added, in pieces. */
  qty_count: number | null;
  /** What it cost in total, entered directly (IQD and/or USD). */
  total: MoneyValue;
}

interface FormState {
  purchase_date: string;
  notes: string;
  lines: FormLine[];
}

/**
 * "Add material" — recording stock coming in (spec 3.3). Deliberately the short form the floor
 * asked for: for each material, how much came in and what it cost in total, plus the date and a
 * note. No supplier and no discount — stock goes up and the cost is recorded, nothing owed.
 */
export function PurchaseFormPage({ mode }: { mode: 'create' | 'edit' }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const { id = '' } = useParams();

  const existing = useQuery({
    queryKey: ['purchases', id],
    queryFn: () => apiRequest<PurchaseDetail>(`/purchases/${id}`),
    enabled: mode === 'edit',
  });

  usePageTitle(mode === 'edit' ? t('purchases:edit_purchase') : t('purchases:add_material'));

  if (mode === 'edit') {
    return (
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
    );
  }

  return (
    <PurchaseForm
      mode="create"
      initial={{ purchase_date: formatter.today(), notes: '', lines: [] }}
    />
  );
}

/** The purchase as the form holds it, so the form is initialised once and never synced. */
function fromPurchase(purchase: PurchaseDetail): FormState {
  return {
    purchase_date: purchase.purchase_date,
    notes: purchase.notes ?? '',
    lines: purchase.lines.map((line) => {
      const enteredIqd = line.cost?.price_entered_currency !== 'USD';
      return {
        key: line.id,
        item_id: line.item_id,
        item_name: line.item_name,
        qty_count: line.qty_count,
        total: {
          amount: line.cost ? (enteredIqd ? line.cost.line_total_iqd : line.cost.line_total_usd_cents) : null,
          currency: line.cost?.price_entered_currency ?? 'IQD',
          other_amount: line.cost ? (enteredIqd ? line.cost.line_total_usd_cents : line.cost.line_total_iqd) : null,
        },
      };
    }),
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

  const draftId = mode === 'edit' ? (purchaseId as string) : 'new';
  const [idempotencyKey, setIdempotencyKey] = useState(
    () => readDraft<FormState>('purchase', draftId)?.idempotency_key ?? newIdempotencyKey(),
  );
  const [draftFound, setDraftFound] = useState(() => readDraft<FormState>('purchase', draftId));

  const [form, setForm] = useState<FormState>(initial);
  const [picking, setPicking] = useState(false);
  const [toast, setToast] = useState<{ message: string; purchaseId?: string } | null>(null);

  // The other-currency side of a typed total is shown at the global rate; the server stores the
  // typed side exactly and converts the other itself (2.3.4).
  const globalRate = useQuery({
    queryKey: ['global-rate'],
    queryFn: () =>
      apiRequest<{ current: { rate_iqd_per_usd: string } | null }>('/settings/global-rates'),
  });
  const documentRate: Rate = globalRate.data?.current?.rate_iqd_per_usd ?? '1310.0000';

  useEffect(() => {
    if (form.lines.length === 0) return;
    const timer = window.setTimeout(
      () => writeDraft('purchase', draftId, form, idempotencyKey),
      300,
    );
    return () => window.clearTimeout(timer);
  }, [form, draftId, idempotencyKey]);

  const totals = useMemo(() => {
    let total_iqd = 0;
    let total_usd_cents = 0;
    for (const line of form.lines) {
      if (line.total.amount === null) continue;
      total_iqd += moneyIqd(line.total, documentRate);
      total_usd_cents += moneyUsd(line.total, documentRate);
    }
    return { total_iqd, total_usd_cents };
  }, [form, documentRate]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        company_id: null,
        purchase_date: form.purchase_date,
        notes: form.notes.trim() === '' ? null : form.notes.trim(),
        discount: null,
        lines: form.lines.map((line) => ({
          item_id: line.item_id,
          qty_count: line.qty_count,
          total: {
            amount: line.total.amount,
            currency: line.total.currency,
            other_amount: line.total.other_amount ?? null,
          },
        })),
        ...(mode === 'edit' ? { version } : {}),
      };
      return apiRequest<PurchaseDetail>(
        mode === 'edit' ? `/purchases/${purchaseId}` : '/purchases',
        { method: mode === 'edit' ? 'PUT' : 'POST', body, idempotencyKey },
      );
    },
    onSuccess: async (purchase) => {
      clearDraft('purchase', draftId);
      setIdempotencyKey(newIdempotencyKey());
      await queryClient.invalidateQueries({ queryKey: ['purchases'] });
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
      setForm((current) => ({ ...current, lines: [], notes: '' }));
    },
  });

  const undo = useMutation({
    mutationFn: (undoneId: string) =>
      apiRequest(`/purchases/${undoneId}/undo`, {
        method: 'POST',
        body: {},
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      setToast(null);
      await queryClient.invalidateQueries({ queryKey: ['purchases'] });
      await queryClient.invalidateQueries({ queryKey: ['items'] });
    },
  });

  const error = save.error instanceof ApiError ? save.error : null;

  const addLine = (item: ItemRow) => {
    setPicking(false);
    setForm((current) => ({
      ...current,
      lines: [
        ...current.lines,
        {
          key: `${item.id}-${current.lines.length}-${Date.now()}`,
          item_id: item.id,
          item_name: item.name,
          qty_count: null,
          total: { amount: null, currency: 'IQD', other_amount: null },
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

  const incomplete = form.lines.some(
    (line) => line.qty_count === null || line.qty_count <= 0 || line.total.amount === null,
  );

  return (
    <div className="mz-stack mz-form-page">
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

      {/* The two facts the whole purchase carries, under a line that says what this screen is. */}
      <Card>
        <div className="mz-stack">
          <div>
            <h2 className="mz-heading">{t('purchases:details')}</h2>
            <p className="mz-muted">{t('purchases:add_material_hint')}</p>
          </div>
          <div className="mz-form-grid">
            <DateField
              label={t('purchases:purchase_date')}
              value={form.purchase_date}
              max={formatter.today()}
              onChange={(event) =>
                setForm((current) => ({ ...current, purchase_date: event.target.value }))
              }
            />
            <TextField
              label={t('glossary:notes')}
              hint={t('common:optional')}
              value={form.notes}
              onChange={(event) =>
                setForm((current) => ({ ...current, notes: event.target.value }))
              }
              maxLength={2000}
            />
          </div>
        </div>
      </Card>

      <h2 className="mz-heading">{t('materials:title')}</h2>

      {form.lines.length === 0 ? (
        <Card>
          <EmptyState
            icon="materials"
            title={t('purchases:no_lines')}
            body={t('orders:add_first_line')}
            action={
              <Button icon="plus" onClick={() => setPicking(true)}>
                {t('purchases:add_line')}
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {form.lines.map((line, index) => {
            const quantity = line.qty_count ?? 0;
            // A quiet reassurance once both are in: what the total works out to per piece.
            const unitIqd =
              quantity > 0 && line.total.amount !== null
                ? Math.round(moneyIqd(line.total, documentRate) / quantity)
                : null;
            return (
              <div key={line.key} className="mz-line-card">
                <div className="mz-line-card__head">
                  <span
                    className="mz-row"
                    style={{ gap: 'var(--space-2)', alignItems: 'center', minInlineSize: 0 }}
                  >
                    <Icon name="materials" size={18} />
                    <strong>
                      <bdi>{line.item_name}</bdi>
                    </strong>
                  </span>
                  <IconButton
                    icon="trash"
                    label={t('purchases:remove_line')}
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        lines: current.lines.filter((row) => row.key !== line.key),
                      }))
                    }
                  />
                </div>

                <div className="mz-form-grid">
                  <NumberField
                    label={t('glossary:quantity')}
                    unit={t('common:count_symbol')}
                    value={line.qty_count === null ? '' : String(line.qty_count)}
                    onChange={(event) =>
                      updateLine(line.key, {
                        qty_count:
                          event.target.value.trim() === ''
                            ? null
                            : Math.round(Number(event.target.value)),
                      })
                    }
                    error={
                      error?.fieldError(`lines.${index}.qty_count`)
                        ? t('errors:field.required')
                        : undefined
                    }
                  />
                  <MoneyInput
                    label={t('glossary:total')}
                    value={line.total}
                    rate={documentRate}
                    sourceLabel={t('glossary:system_rate')}
                    onChange={(value) => updateLine(line.key, { total: value })}
                    error={
                      error?.fieldError(`lines.${index}.total`)
                        ? t('purchases:price_missing', { item: line.item_name })
                        : undefined
                    }
                  />
                </div>

                {unitIqd !== null ? (
                  <span className="mz-caption" data-tabular>
                    ≈ {formatter.money(unitIqd, 'IQD')} / {t('common:count_symbol')}
                  </span>
                ) : null}
              </div>
            );
          })}

          <Button variant="secondary" block icon="plus" onClick={() => setPicking(true)}>
            {t('purchases:add_line')}
          </Button>
        </>
      )}

      {error && !error.fields.length ? (
        <div className="mz-warning" role="alert">
          {t(error.messageKey, { defaultValue: t('errors:INTERNAL') })}
        </div>
      ) : null}

      <TotalsFooter
        total_iqd={totals.total_iqd}
        total_usd_cents={totals.total_usd_cents}
        primary="IQD"
        lineCount={form.lines.length}
        saving={save.isPending}
        disabled={form.lines.length === 0 || incomplete}
        onSave={() => save.mutate()}
        saveLabel={mode === 'edit' ? t('common:save') : t('purchases:add_material')}
      />

      {picking ? (
        <PickerSheet
          title={t('purchases:pick_material')}
          open
          onClose={() => setPicking(false)}
          path="/items"
          icon="materials"
          searchLabel={t('materials:search_placeholder')}
          emptyTitle={t('materials:empty')}
          toItem={(row: never) => {
            const item = row as unknown as ItemRow;
            return {
              id: item.id,
              title: item.name,
              subtitle: item.code ?? undefined,
              detail: item.stock.count_complete ? (
                <span className="mz-picker__meta">
                  {formatter.number(item.stock.stock_count)} {t('common:count_symbol')}
                </span>
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

/** The IQD side of a typed total: the amount if it was typed in dinars, else converted. */
function moneyIqd(money: MoneyValue, rate: Rate): number {
  if (money.amount === null) return 0;
  if (money.currency === 'IQD') return money.amount;
  return money.other_amount ?? convert(money.amount, 'USD', rate);
}

/** The USD side of a typed total: the amount if it was typed in dollars, else converted. */
function moneyUsd(money: MoneyValue, rate: Rate): number {
  if (money.amount === null) return 0;
  if (money.currency === 'USD') return money.amount;
  return money.other_amount ?? convert(money.amount, 'IQD', rate);
}

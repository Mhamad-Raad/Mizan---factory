import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet, Button, NumberField, TextAreaField, TextField } from '@mizan/ui';
import type { Rate } from '@mizan/money';
import { ApiError, apiRequest } from '../lib/api.js';
import { useIdempotencyKey } from '../lib/idempotency.js';
import { errorMessage } from '../lib/errors.js';
import { invalidateHistory, invalidateMoneyViews } from '../lib/invalidate.js';
import { toMoneyBody } from '../lib/money.js';
import { useFormatter, usePermission } from '../lib/store.js';
import { MoneyInput } from './MoneyInput.js';
import type { MoneyValue } from './MoneyInput.js';

type Pair = { amount_iqd: number; amount_usd_cents: number; entered_currency: 'IQD' | 'USD' };

/** This month's row of the material's prices, when one is stored. */
interface MonthRow {
  month: string;
  sale: Pair | null;
  bought?: Pair | null;
  version: number;
}

const EMPTY: MoneyValue = { amount: null, currency: 'IQD', other_amount: null };

function valueOf(pair: Pair | null | undefined): MoneyValue {
  if (!pair) return EMPTY;
  return {
    amount: pair.entered_currency === 'IQD' ? pair.amount_iqd : pair.amount_usd_cents,
    currency: pair.entered_currency,
    other_amount: null,
  };
}

/** What the sheet edits of a material: its own details, never its stock, prices or unit. */
export interface EditableMaterial {
  id: string;
  name: string;
  code: string | null;
  notes: string | null;
  min_stock_count?: number | null;
  min_stock_kg?: string | null;
  version: number;
}

/**
 * A material's own details — name, code, low-stock level, notes — and this month's sale and bought
 * prices, changed from its page (D-099, D-100): a material named inside a purchase has no prices
 * until somebody sets them, and this is where they look. Earlier months stay on the Monthly prices
 * tab, what a buy cost is the purchase's, and the unit stays what it was bought in (D-062). A blank
 * code, level or note clears it; a price left as it was is not sent, so it is not rewritten.
 */
export function EditMaterialSheet({
  material,
  measure,
  rate,
  onClose,
  onSaved,
}: {
  material: EditableMaterial;
  /** Today's system rate, which fills a price's other currency; null when none is set. */
  rate: Rate | null;
  /** The measure the material is stocked in: the low-stock level is in the same. */
  measure: 'count' | 'kg';
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(material.name);
  const [code, setCode] = useState(material.code ?? '');
  const [notes, setNotes] = useState(material.notes ?? '');
  const [minStock, setMinStock] = useState(
    measure === 'kg' ? (material.min_stock_kg ?? '') : material.min_stock_count == null ? '' : String(material.min_stock_count),
  );
  const saveKey = useIdempotencyKey();
  const pricesKey = useIdempotencyKey();
  const formatter = useFormatter();
  const maySetPrices = usePermission('materials.set_prices');
  const maySeeBought = usePermission('fields.see_bought_price');
  const thisMonth = formatter.today().slice(0, 7);

  // This month's stored prices, if any: the boxes open on them, and the save names their version.
  const monthRow = useQuery({
    queryKey: ['items', material.id, 'prices', 'edit', thisMonth],
    queryFn: () => apiRequest<{ items: MonthRow[] }>(`/items/${material.id}/prices?page_size=2`),
    enabled: maySetPrices,
  });
  const stored = monthRow.data?.items.find((row) => row.month.slice(0, 7) === thisMonth) ?? null;
  // Null until the user types: the box shows what is stored, and an untouched box is not sent.
  const [sale, setSale] = useState<MoneyValue | null>(null);
  const [bought, setBought] = useState<MoneyValue | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const level = minStock.trim();
      const saleBody = sale ? toMoneyBody(sale) : null;
      const boughtBody = maySeeBought && bought ? toMoneyBody(bought) : null;
      // The prices first: a refused price leaves the details unsaved too, rather than half a save.
      if (maySetPrices && (saleBody || boughtBody)) {
        await apiRequest(`/items/${material.id}/prices/${thisMonth}`, {
          method: 'PUT',
          idempotencyKey: pricesKey.key,
          body: { sale: saleBody, bought: boughtBody, version: stored?.version ?? null },
        });
        // Saved: should the details then be refused (a name already taken), the next Save must not
        // send these prices again under the same key, or with the version they replaced (review).
        pricesKey.renew();
        setSale(null);
        setBought(null);
        await monthRow.refetch();
      }
      return apiRequest(`/items/${material.id}`, {
        method: 'PATCH',
        idempotencyKey: saveKey.key,
        body: {
          version: material.version,
          name: name.trim(),
          code: code.trim() === '' ? null : code.trim(),
          notes: notes.trim() === '' ? null : notes.trim(),
          ...(measure === 'kg'
            ? { min_stock_kg: level === '' ? null : level }
            : { min_stock_count: level === '' ? null : Number(level) }),
        },
      });
    },
    onSuccess: async () => {
      saveKey.renew();
      pricesKey.renew();
      await queryClient.invalidateQueries({ queryKey: ['items'] });
      // A month's price values the stock and the margin, which Today, Reports and Accounts sum.
      await invalidateMoneyViews(queryClient);
      await queryClient.invalidateQueries({ queryKey: ['/items'] });
      await invalidateHistory(queryClient);
      onSaved();
    },
  });

  const duplicate = save.error instanceof ApiError ? save.error.fieldError('name') : undefined;
  const otherError = duplicate ? null : errorMessage(t, save.error);
  const ready = name.trim() !== '' && !save.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) save.mutate();
  };

  return (
    <BottomSheet title={t('materials:edit_material')} open onClose={onClose} closeLabel={t('common:close')} wide>
      <form className="mz-stack" onSubmit={submit} noValidate>
        <div className="mz-form-grid">
          <TextField
            label={t('materials:name')}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              save.reset();
            }}
            maxLength={200}
            error={duplicate ? t('errors:duplicate_material', { name: String(duplicate.params?.name ?? name) }) : undefined}
          />
          <TextField
            label={t('materials:code')}
            hint={t('common:optional')}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            maxLength={40}
          />
          <NumberField
            label={t('materials:min_stock')}
            hint={t('materials:min_stock_hint')}
            unit={measure === 'kg' ? t('common:kg_symbol') : t('common:count_symbol')}
            decimals={measure === 'kg' ? 3 : 0}
            value={minStock}
            onChange={(event) => setMinStock(event.target.value)}
          />
          <div>
            <TextAreaField
              label={t('glossary:notes')}
              hint={t('common:optional')}
              value={notes}
              maxLength={2000}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          {maySetPrices ? (
            <>
              <h3 className="mz-heading mz-form-grid__wide" style={{ marginBlockStart: 'var(--space-2)' }}>
                {t('materials:this_month_prices')}
              </h3>
              <div className={maySeeBought ? undefined : 'mz-form-grid__wide'}>
                <MoneyInput
                  label={t('glossary:sale_price')}
                  value={sale ?? valueOf(stored?.sale)}
                  rate={rate}
                  onChange={setSale}
                />
              </div>
              {maySeeBought ? (
                <div>
                  <MoneyInput
                    label={t('glossary:bought_price')}
                    value={bought ?? valueOf(stored?.bought)}
                    rate={rate}
                    onChange={setBought}
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <p className="mz-caption">
          {maySetPrices ? t('materials:edit_material_prices_hint') : t('materials:edit_material_no_prices_hint')}
        </p>
        {otherError ? (
          <p className="mz-warning" role="alert">
            {otherError}
          </p>
        ) : null}
        <Button type="submit" variant="primary" block loading={save.isPending} disabled={!ready}>
          {t('common:save')}
        </Button>
      </form>
    </BottomSheet>
  );
}

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, NumberField, StickyFooter, TextField } from '@mizan/ui';
import type { Rate } from '@mizan/money';
import { ApiError, apiRequest, newIdempotencyKey } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { MoneyInput } from '../components/MoneyInput.js';
import type { MoneyValue } from '../components/MoneyInput.js';
import { useFormatter, usePermission } from '../lib/store.js';

const emptyMoney = (): MoneyValue => ({ amount: null, currency: 'IQD', other_amount: null });

/** A money value for the API, or null when nothing was typed. */
function toMoney(value: MoneyValue) {
  return value.amount === null
    ? null
    : { amount: value.amount, currency: value.currency, other_amount: value.other_amount ?? null };
}

/**
 * "New material" (FR-301, FR-302): create the item in the catalogue and, in the same form, give
 * it what it needs to be useful — a code, how much is in stock now, and this month's prices in
 * both currencies. A material is counted, so there is no per-piece / per-kg choice.
 */
export function NewMaterialPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const maySetPrices = usePermission('materials.set_prices');
  const mayRecordStock = usePermission('materials.opening_stock');

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [quantity, setQuantity] = useState('');
  const [sale, setSale] = useState<MoneyValue>(emptyMoney);
  const [bought, setBought] = useState<MoneyValue>(emptyMoney);
  const [idempotencyKey] = useState(newIdempotencyKey);

  const globalRate = useQuery({
    queryKey: ['global-rate'],
    queryFn: () =>
      apiRequest<{ current: { rate_iqd_per_usd: string } | null }>('/settings/global-rates'),
  });
  const rate: Rate = globalRate.data?.current?.rate_iqd_per_usd ?? '1310.0000';
  const thisMonth = formatter.today().slice(0, 7);

  const create = useMutation({
    mutationFn: async () => {
      const created = await apiRequest<{ id: string }>('/items', {
        method: 'POST',
        idempotencyKey,
        // `per_piece` stays the model until the count-only migration; the choice is gone from the UI.
        body: {
          name: name.trim(),
          pricing_unit: 'per_piece',
          code: code.trim() === '' ? null : code.trim(),
        },
      });
      const id = created.id;

      if (maySetPrices && (sale.amount !== null || bought.amount !== null)) {
        await apiRequest(`/items/${id}/prices/${thisMonth}`, {
          method: 'PUT',
          idempotencyKey: newIdempotencyKey(),
          body: { sale: toMoney(sale), bought: toMoney(bought), note: null },
        });
      }

      if (mayRecordStock && quantity.trim() !== '') {
        await apiRequest(`/items/${id}/opening-stock`, {
          method: 'POST',
          idempotencyKey: newIdempotencyKey(),
          body: {
            entry_date: formatter.today(),
            qty_count: Math.round(Number(quantity)),
            qty_kg: null,
            note: t('glossary:opening_stock'),
          },
        });
      }

      return created;
    },
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['items'] });
      navigate(`/materials/${created.id}`, { replace: true });
    },
  });

  const duplicate = create.error instanceof ApiError ? create.error.fieldError('name') : undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() !== '') create.mutate();
  };

  usePageTitle(t('materials:new_material'));

  return (
    <form className="mz-stack mz-form-page" onSubmit={submit} noValidate>
      <Card>
        <div className="mz-stack">
          <div>
            <h2 className="mz-heading">{t('materials:new_material')}</h2>
            <p className="mz-muted">{t('materials:new_material_hint')}</p>
          </div>
          <div className="mz-form-grid">
            {/* The name is the one field that always earns the full width. */}
            <div className="mz-form-grid__wide">
              <TextField
                label={t('materials:name')}
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
                maxLength={200}
                error={
                  duplicate
                    ? t('errors:duplicate_material', {
                        name: String(duplicate.params?.name ?? name),
                      })
                    : undefined
                }
              />
            </div>

            <TextField
              label={t('materials:code')}
              hint={t('common:optional')}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              maxLength={40}
            />

            {mayRecordStock ? (
              <NumberField
                label={t('glossary:quantity')}
                hint={t('common:optional')}
                unit={t('common:count_symbol')}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            ) : null}
          </div>
        </div>
      </Card>

      {maySetPrices ? (
        <Card>
          <div className="mz-stack">
            <div>
              <h2 className="mz-heading">{t('materials:prices')}</h2>
              <p className="mz-muted">{t('materials:prices_hint')}</p>
            </div>
            {/* Sale and bought are two decisions, so they read as two rows with a rule between —
                each its own dinar-and-dollar pair — not four fields strung across one line. */}
            <MoneyInput
              label={t('glossary:sale_price')}
              value={sale}
              rate={rate}
              sourceLabel={t('glossary:system_rate')}
              onChange={setSale}
            />
            <hr className="mz-divider" />
            <MoneyInput
              label={t('glossary:bought_price')}
              value={bought}
              rate={rate}
              sourceLabel={t('glossary:system_rate')}
              onChange={setBought}
            />
          </div>
        </Card>
      ) : null}

      <StickyFooter>
        <Button type="submit" block loading={create.isPending} disabled={name.trim() === ''}>
          {t('common:save')}
        </Button>
        <Button type="button" variant="ghost" block onClick={() => navigate('/materials')}>
          {t('glossary:cancel')}
        </Button>
      </StickyFooter>
    </form>
  );
}

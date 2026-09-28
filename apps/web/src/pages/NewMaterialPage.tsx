import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, DateField, NumberField, StickyFooter, TextField } from '@mizan/ui';
import { ApiError, apiRequest } from '../lib/api.js';
import { useIdempotencyKey } from '../lib/idempotency.js';
import { toMoneyBody } from '../lib/money.js';
import { parseCount } from '../lib/quantity.js';
import { usePageTitle } from '../lib/page-title.js';
import { MoneyInput } from '../components/MoneyInput.js';
import type { MoneyValue } from '../components/MoneyInput.js';
import { useFormatter, usePermission } from '../lib/store.js';
import { errorMessage } from '../lib/errors.js';
import { invalidateMoneyViews } from '../lib/invalidate.js';
import { useGlobalRate } from '../lib/rates.js';

const emptyMoney = (): MoneyValue => ({ amount: null, currency: 'IQD', other_amount: null });

/**
 * "New material" (FR-301, FR-302, D-062): creating a material is buying it. The form names the
 * material, records its first buy — how many came in and what each one cost — and, for those
 * who set prices, this month's prices. The material and its first buy are one request, written
 * together or not at all. A material is counted, so there is no per-piece / per-kg choice.
 */
export function NewMaterialPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const maySetPrices = usePermission('materials.set_prices');
  // The first buy is a buy: it needs the key buying needs (the API refuses it otherwise).
  const mayBuy = usePermission('purchases.create');

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState<MoneyValue>(emptyMoney);
  const [boughtOn, setBoughtOn] = useState(() => formatter.today());
  const [buyNote, setBuyNote] = useState('');
  const [sale, setSale] = useState<MoneyValue>(emptyMoney);
  const [bought, setBought] = useState<MoneyValue>(emptyMoney);
  // The material and its prices are two writes, each with its own key held across retries.
  const createKey = useIdempotencyKey();
  const pricesKey = useIdempotencyKey();

  // Null until a rate is set: the money fields then show no conversion rather than invent one.
  const { rate } = useGlobalRate();
  const thisMonth = formatter.today().slice(0, 7);

  // Pieces are whole: "2.5" is refused under the field, never rounded to 3.
  const count = parseCount(quantity);

  const create = useMutation({
    mutationFn: async () => {
      const created = await apiRequest<{ id: string }>('/items', {
        method: 'POST',
        idempotencyKey: createKey.key,
        // `per_piece` stays the model until the count-only migration; the choice is gone from the UI.
        body: {
          name: name.trim(),
          pricing_unit: 'per_piece',
          code: code.trim() === '' ? null : code.trim(),
          buy: {
            qty_count: count.kind === 'count' ? count.value : null,
            qty_kg: null,
            unit_price: toMoneyBody(unitCost),
            purchase_date: boughtOn,
            note: buyNote.trim() === '' ? null : buyNote.trim(),
          },
        },
      });
      const id = created.id;

      if (maySetPrices && (sale.amount !== null || bought.amount !== null)) {
        await apiRequest(`/items/${id}/prices/${thisMonth}`, {
          method: 'PUT',
          idempotencyKey: pricesKey.key,
          body: { sale: toMoneyBody(sale), bought: toMoneyBody(bought), note: null },
        });
      }

      return created;
    },
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['items'] });
      await invalidateMoneyViews(queryClient);
      navigate(`/materials/${created.id}`, { replace: true });
    },
  });

  const duplicate = create.error instanceof ApiError ? create.error.fieldError('name') : undefined;
  const otherError = duplicate ? null : errorMessage(t, create.error);

  const quantityValid = count.kind === 'count' && count.value > 0;
  const costValid = unitCost.amount !== null && unitCost.amount >= 0;
  const ready = mayBuy && name.trim() !== '' && quantityValid && costValid && boughtOn !== '';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) create.mutate();
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

          </div>
        </div>
      </Card>

      {/* The first buy (D-062): a material comes into the warehouse by being bought. */}
      <Card>
        <div className="mz-stack">
          <div>
            <h2 className="mz-heading">{t('materials:first_buy')}</h2>
            <p className="mz-muted">{t('materials:first_buy_hint')}</p>
          </div>
          {mayBuy ? (
            <>
              <div className="mz-form-grid">
                <NumberField
                  label={t('glossary:quantity')}
                  unit={t('common:count_symbol')}
                  value={quantity}
                  error={count.kind === 'invalid' ? t('common:count_whole') : undefined}
                  onChange={(event) => setQuantity(event.target.value)}
                />
                <DateField
                  label={t('materials:bought_on')}
                  value={boughtOn}
                  max={formatter.today()}
                  onChange={(event) => setBoughtOn(event.target.value)}
                />
              </div>
              <MoneyInput
                label={t('materials:cost_per_unit')}
                value={unitCost}
                rate={rate}
                sourceLabel={t('glossary:system_rate')}
                onChange={setUnitCost}
              />
              <TextField
                label={t('materials:buy_note')}
                hint={t('common:optional')}
                value={buyNote}
                onChange={(event) => setBuyNote(event.target.value)}
                maxLength={500}
              />
            </>
          ) : (
            <p className="mz-warning" role="status">
              {t('materials:needs_buy_permission')}
            </p>
          )}
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

      {otherError ? (
        <div className="mz-warning" role="alert">
          {otherError}
        </div>
      ) : null}

      <StickyFooter>
        <Button type="submit" block loading={create.isPending} disabled={!ready}>
          {t('common:save')}
        </Button>
        <Button type="button" variant="ghost" block onClick={() => navigate('/materials')}>
          {t('glossary:cancel')}
        </Button>
      </StickyFooter>
    </form>
  );
}

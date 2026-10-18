import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Chip, DateField, EmptyState, Icon, IconButton, SegmentedControl, TextAreaField } from '@mizan/ui';
import { computeLineTotals, convert, documentTotals } from '@mizan/money';
import type { Currency } from '@mizan/money';
import { ApiError, apiRequest } from '../lib/api.js';
import { useIdempotencyKey } from '../lib/idempotency.js';
import { usePageTitle } from '../lib/page-title.js';
import { useAccount } from '../lib/accounts.js';
import { errorMessage } from '../lib/errors.js';
import { invalidateMoneyViews } from '../lib/invalidate.js';
import { useFormatter, usePermission } from '../lib/store.js';
import { MoneyInput } from '../components/MoneyInput.js';
import type { MoneyValue } from '../components/MoneyInput.js';
import { QuantityInput } from '../components/QuantityInput.js';
import { PickerSheet } from '../components/PickerSheet.js';
import { NewMaterialSheet } from '../components/NewMaterialSheet.js';
import { DriverField } from '../components/DriverPicker.js';
import { TotalsFooter } from '../components/TotalsFooter.js';
import { DualAmount } from '../components/DualAmount.js';
import {
  BuyRateField,
  CompanyField,
  NOTHING_PAID,
  PaidNowField,
  companyIdOf,
  paidNowBody,
  paidNowValid,
  useBuyRate,
} from '../components/BuyFields.js';
import type { CompanyChoice, PaidNow } from '../components/BuyFields.js';
import type { ItemRow } from './MaterialsPage.js';
import type { PurchaseDetail } from '../lib/purchases.js';

interface FormLine {
  key: string;
  item_id: string;
  item_name: string;
  priced_measure: 'count' | 'kg';
  qty_count: number | null;
  qty_kg: string | null;
  cost: MoneyValue;
  note: string;
}

/**
 * "New purchase" (D-085): what we bought, from which company, what each one cost, and what we
 * paid them on the spot. The mirror of the order form — a card of the facts the purchase carries,
 * a card per material, and the total in the sticky footer — because buying is now most of what
 * the business uses the system for.
 *
 * Saved, it opens the purchase's own page, which offers its receipt to print straight away. The
 * cost of a material opens at this month's bought price, when one is set; whatever is typed is
 * the price of this purchase alone.
 */
export function PurchaseFormPage() {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const mayPay = usePermission('companies.record_payment');
  const maySeeOwed = usePermission('fields.see_company_balances');

  const [company, setCompany] = useState<CompanyChoice>({ kind: 'unset' });
  // A link from a company's page names it; its name and currency are read from the API below.
  const linkedCompanyId = company.kind === 'unset' ? params.get('company') : null;
  const linked = useAccount(linkedCompanyId);
  const chosen: CompanyChoice =
    company.kind === 'unset' && linked.data && !linked.data.is_system
      ? { kind: 'company', id: linked.data.id, name: linked.data.name, settlement_currency: linked.data.settlement_currency }
      : company;
  const companyId = companyIdOf(chosen);

  const [date, setDate] = useState(() => formatter.today());
  const [notes, setNotes] = useState('');
  // Who brought it in (D-106); a purchase opened from a driver's page starts with that driver.
  const [driver, setDriver] = useState<{ id: string | null; name: string | null }>(() => ({
    id: params.get('driver'),
    name: null,
  }));
  const [lines, setLines] = useState<FormLine[]>([]);
  const [paid, setPaid] = useState<PaidNow>(NOTHING_PAID);
  const [picking, setPicking] = useState(false);
  // The picker opens on what this company has sold us before; "All materials" is one tap away,
  // for the first buy of something from them (D-096).
  const [materialScope, setMaterialScope] = useState<'company' | 'all'>('company');
  // A material named on the spot from the picker (D-090): what was typed there, while its sheet is open.
  const [naming, setNaming] = useState<string | null>(null);
  const mayCreateMaterial = usePermission('materials.create');
  const saveKey = useIdempotencyKey();

  const details = useAccount(companyId);
  const settlement: Currency = chosen.kind === 'company' ? chosen.settlement_currency : 'IQD';

  // The rate of this purchase (2.3.3, D-092): its box opens with the company's own rate, else the
  // system's, and may be changed for this deal — the precedence the server applies.
  const buyRate = useBuyRate(details.data, t('purchases:rate_source_purchase'));
  const { rate, source: rateSource, label: rateSourceLabel } = buyRate;

  const totals = useMemo(() => {
    const perLine = lines.map((line) => {
      const quantity = line.priced_measure === 'kg' ? line.qty_kg : line.qty_count;
      if (rate === null || quantity === null || line.cost.amount === null) return null;
      const amount = line.cost.amount;
      return computeLineTotals({
        priced_measure: line.priced_measure,
        qty_count: line.qty_count,
        qty_kg: line.qty_kg,
        unit_price_iqd: line.cost.currency === 'IQD' ? amount : (line.cost.other_amount ?? convert(amount, 'USD', rate)),
        unit_price_usd_cents:
          line.cost.currency === 'USD' ? amount : (line.cost.other_amount ?? convert(amount, 'IQD', rate)),
        price_entered_currency: line.cost.currency,
        both_prices_typed: line.cost.other_amount !== null && line.cost.other_amount !== undefined,
        document_rate: rate,
        document_rate_source: rateSource,
      });
    });
    const complete = perLine.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    return { perLine, ...documentTotals(complete, { discount_iqd: 0, discount_usd_cents: 0 }) };
  }, [lines, rate, rateSource]);

  const save = useMutation({
    mutationFn: () =>
      apiRequest<PurchaseDetail & { paid_entry_id: string | null }>('/purchases', {
        method: 'POST',
        idempotencyKey: saveKey.key,
        body: {
          company_id: companyId,
          purchase_date: date,
          notes: notes.trim() === '' ? null : notes.trim(),
          driver_id: driver.id,
          rate_iqd_per_usd: buyRate.body,
          lines: lines.map((line) => ({
            item_id: line.item_id,
            qty_count: line.priced_measure === 'count' ? line.qty_count : null,
            qty_kg: line.priced_measure === 'kg' ? line.qty_kg : null,
            unit_price: { amount: line.cost.amount, currency: line.cost.currency, other_amount: line.cost.other_amount ?? null },
            note: line.note.trim() === '' ? null : line.note.trim(),
          })),
          paid: companyId && mayPay ? paidNowBody(paid, settlement) : null,
        },
      }),
    onSuccess: async (purchase) => {
      saveKey.renew();
      await queryClient.invalidateQueries({ queryKey: ['purchases'] });
      await queryClient.invalidateQueries({ queryKey: ['items'] });
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
      await invalidateMoneyViews(queryClient);
      // The purchase's own page offers its receipt the moment it opens (D-086).
      navigate(`/purchases/${purchase.id}`, { replace: true, state: { justSaved: true } });
    },
  });

  const error = save.error instanceof ApiError ? save.error : null;
  const paidError = error?.fieldError('paid.amount') ?? error?.fieldError('paid');
  // Refusals a line card or the payment card already shows under its own input need no banner as
  // well; anything else — a material deactivated since it was picked — must reach the banner,
  // or Save would do nothing in silence (review).
  const shownUnderInputs =
    error !== null &&
    error.fields.length > 0 &&
    error.fields.every(
      (field) => /^lines\.\d+\.(qty_kg|qty_count|unit_price)$/.test(field.path) || field.path.startsWith('paid'),
    );
  const saveError = shownUnderInputs ? null : errorMessage(t, save.error);

  const ready =
    chosen.kind === 'company' &&
    lines.length > 0 &&
    lines.every(
      (line) =>
        (line.priced_measure === 'kg' ? line.qty_kg !== null : line.qty_count !== null && line.qty_count > 0) &&
        line.cost.amount !== null,
    ) &&
    !buyRate.invalid &&
    paidNowValid(paid);

  const addLine = (item: ItemRow) => {
    setPicking(false);
    save.reset();
    setLines((current) => [
      ...current,
      {
        key: `${item.id}-${current.length}-${Date.now()}`,
        item_id: item.id,
        item_name: item.name,
        priced_measure: item.stock.priced_measure,
        qty_count: null,
        qty_kg: null,
        // This month's bought price, in the currency it was set in: the cost a line opens with is
        // the cost it saves, at this purchase's rate, whatever is then typed (second review —
        // a dinar copy of a dollar price was a different figure at another rate).
        cost: item.bought
          ? {
              amount: item.bought.entered_currency === 'USD' ? item.bought.amount_usd_cents : item.bought.amount_iqd,
              currency: item.bought.entered_currency,
              other_amount: null,
            }
          : { amount: null, currency: 'IQD', other_amount: null },
        note: '',
      },
    ]);
  };
  const updateLine = (key: string, patch: Partial<FormLine>) => {
    save.reset();
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };

  usePageTitle(t('purchases:new_purchase'));

  const owedNow = details.data?.payable;

  return (
    <div className="mz-stack mz-form-page">
      <Card>
        <div className="mz-stack">
          <div>
            <h2 className="mz-heading">{t('purchases:details')}</h2>
            <p className="mz-muted">{t('purchases:new_purchase_hint')}</p>
          </div>
          <div className="mz-form-grid">
            <div className="mz-form-grid__wide">
              <CompanyField
                value={chosen}
                onChange={(choice) => {
                  save.reset();
                  setCompany(choice);
                  setMaterialScope('company');
                  // What was typed survives a change of company; "paid in" follows the new one.
                  if (choice.kind !== 'company') setPaid(NOTHING_PAID);
                }}
              />
              {owedNow && maySeeOwed && chosen.kind === 'company' && (owedNow.amount_iqd !== 0 || owedNow.amount_usd_cents !== 0) ? (
                <div className="mz-row mz-row--between" style={{ marginBlockStart: 'var(--space-2)' }}>
                  <span className="mz-caption">{t('purchases:owed_before')}</span>
                  <DualAmount
                    amount_iqd={owedNow.amount_iqd}
                    amount_usd_cents={owedNow.amount_usd_cents}
                    primary={owedNow.currency}
                    kind="derived"
                  />
                </div>
              ) : null}
            </div>
            <DateField
              label={t('materials:bought_on')}
              value={date}
              max={formatter.today()}
              onChange={(event) => {
                save.reset();
                setDate(event.target.value);
              }}
            />
            <BuyRateField state={buyRate} label={t('purchases:rate_for_purchase')} />
            <DriverField
              driverId={driver.id}
              driverName={driver.name}
              hint={t('purchases:driver_hint')}
              onChange={(picked) => setDriver({ id: picked?.id ?? null, name: picked?.name ?? null })}
            />
            <div className="mz-form-grid__wide">
              <TextAreaField
                label={t('glossary:notes')}
                hint={t('purchases:notes_hint')}
                value={notes}
                maxLength={2000}
                onChange={(event) => setNotes(event.target.value)}
              />
            </div>
          </div>
        </div>
      </Card>

      <h2 className="mz-heading">{t('materials:title')}</h2>

      {lines.length === 0 ? (
        <Card>
          <EmptyState
            icon="materials"
            title={t('purchases:no_lines')}
            body={t('purchases:add_first_line')}
            action={
              <Button icon="plus" onClick={() => setPicking(true)}>
                {t('purchases:add_line')}
              </Button>
            }
          />
        </Card>
      ) : null}

      {lines.map((line, index) => (
        <div key={line.key} className="mz-line-card">
          <div className="mz-line-card__head">
            <span className="mz-row" style={{ gap: 'var(--space-2)', alignItems: 'center', minInlineSize: 0 }}>
              <Icon name="materials" size={18} />
              <strong>
                <bdi>{line.item_name}</bdi>
              </strong>
            </span>
            <span className="mz-row" style={{ gap: 'var(--space-2)' }}>
              <Chip>{t(`glossary:${line.priced_measure === 'kg' ? 'per_kg' : 'per_piece'}`)}</Chip>
              <IconButton
                icon="trash"
                label={t('purchases:remove_line')}
                onClick={() => {
                  // The refusals are by line number, so they would land on the wrong card now.
                  save.reset();
                  setLines((current) => current.filter((row) => row.key !== line.key));
                }}
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
            label={t('materials:cost_per_unit')}
            value={line.cost}
            rate={rate}
            sourceLabel={rateSourceLabel}
            onChange={(cost) => updateLine(line.key, { cost })}
            error={error?.fieldError(`lines.${index}.unit_price`) ? t('errors:price_required') : undefined}
          />
          <TextAreaField
            label={t('purchases:line_note')}
            hint={t('common:optional')}
            value={line.note}
            maxLength={500}
            onChange={(event) => updateLine(line.key, { note: event.target.value })}
          />
          {totals.perLine[index] ? (
            <div className="mz-row mz-row--between">
              <span className="mz-caption">{t('glossary:line_total')}</span>
              <DualAmount
                amount_iqd={totals.perLine[index]?.line_total_iqd ?? 0}
                amount_usd_cents={totals.perLine[index]?.line_total_usd_cents ?? 0}
                primary={settlement}
              />
            </div>
          ) : null}
        </div>
      ))}

      {lines.length > 0 ? (
        <Button variant="secondary" block icon="plus" onClick={() => setPicking(true)}>
          {t('purchases:add_line')}
        </Button>
      ) : null}

      {/* Did we pay them now? Only for a company, and only for someone who may pay companies. */}
      {chosen.kind === 'company' && mayPay ? (
        <Card>
          <div className="mz-stack">
            <PaidNowField
              value={paid}
              rate={rate}
              accountCurrency={settlement}
              error={paidError ? errorMessage(t, save.error) ?? undefined : undefined}
              onChange={(value) => {
                save.reset();
                setPaid(value);
              }}
            />
          </div>
        </Card>
      ) : null}

      {saveError ? (
        <div className="mz-warning" role="alert">
          {saveError}
        </div>
      ) : null}

      <TotalsFooter
        total_iqd={totals.total_iqd}
        total_usd_cents={totals.total_usd_cents}
        primary={settlement}
        lineCount={lines.length}
        saving={save.isPending}
        disabled={!ready}
        onSave={() => save.mutate()}
        saveLabel={t('purchases:save_purchase')}
        note={chosen.kind === 'unset' && lines.length > 0 ? t('purchases:choose_company_first') : undefined}
      />

      {picking ? (
        <PickerSheet
          title={t('purchases:pick_material')}
          open
          onClose={() => setPicking(false)}
          path={companyId && materialScope === 'company' ? `/items?company_id=${companyId}` : '/items'}
          icon="materials"
          searchLabel={t('materials:search_placeholder')}
          emptyTitle={
            companyId && materialScope === 'company' ? t('purchases:scope_company_empty') : t('materials:empty')
          }
          header={
            companyId ? (
              <SegmentedControl
                label={t('purchases:materials_scope')}
                value={materialScope}
                onChange={setMaterialScope}
                options={[
                  { value: 'company', label: t('purchases:scope_company') },
                  { value: 'all', label: t('purchases:scope_all') },
                ]}
              />
            ) : undefined
          }
          toItem={(row: never) => {
            const item = row as unknown as ItemRow;
            return {
              id: item.id,
              title: item.name,
              subtitle: item.bought ? formatter.money(item.bought.amount_iqd, 'IQD') : undefined,
              detail: item.stock.priced_complete ? (
                <span className="mz-picker__meta">
                  {formatter.quantity(item.stock.priced_quantity)}{' '}
                  {t(`common:${item.stock.priced_measure}_symbol`)}
                </span>
              ) : undefined,
            };
          }}
          onPick={(_id, row) => addLine(row as unknown as ItemRow)}
          footer={
            mayCreateMaterial
              ? (typed) => (
                  <Button
                    variant="secondary"
                    icon="plus"
                    block
                    onClick={() => {
                      setPicking(false);
                      setNaming(typed);
                    }}
                  >
                    {t('materials:new_material')}
                  </Button>
                )
              : undefined
          }
        />
      ) : null}

      {naming !== null ? (
        <NewMaterialSheet
          initialName={naming}
          companyName={chosen.kind === 'company' ? chosen.name : null}
          onClose={() => setNaming(null)}
          onCreated={(item) => {
            setNaming(null);
            addLine(item);
          }}
        />
      ) : null}
    </div>
  );
}

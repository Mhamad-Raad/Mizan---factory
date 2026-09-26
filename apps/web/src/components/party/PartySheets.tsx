import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { BottomSheet, Button, Checkbox, Icon, NumberField, TextField } from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { apiRequest } from '../../lib/api.js';
import { QueryStates } from '../states.js';
import { useFormatter, usePermission } from '../../lib/store.js';
import type { CustomerRow } from '../../pages/CustomersPage.js';

/**
 * Edit the business itself (FR-501, FR-701, D-054): its name and contact details, and which
 * sides it takes part in. A side is offered only to somebody who may edit that side, and a side
 * that already has documents on it cannot be switched off — the server says so in words.
 */
export function EditPartySheet({
  party,
  saving,
  error,
  onClose,
  onSave,
}: {
  party: CustomerRow;
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const mayEditCustomer = usePermission('customers.edit');
  const mayEditCompany = usePermission('companies.edit');
  const [name, setName] = useState(party.name);
  const [contactName, setContactName] = useState(party.contact_name ?? '');
  const [phone, setPhone] = useState(party.phone ?? '');
  const [address, setAddress] = useState(party.address ?? '');
  const [notes, setNotes] = useState(party.notes ?? '');
  const [isCustomer, setIsCustomer] = useState(party.is_customer);
  const [isSupplier, setIsSupplier] = useState(party.is_supplier);
  const noSide = !isCustomer && !isSupplier;

  return (
    <BottomSheet title={t('common:edit')} open onClose={onClose} closeLabel={t('common:close')}>
      <div className="mz-stack">
        <TextField label={t('customers:name')} value={name} onChange={(event) => setName(event.target.value)} />
        <fieldset className="mz-stack" style={{ gap: 'var(--space-1)', border: 0, padding: 0, margin: 0 }}>
          <legend className="mz-field__label">{t('customers:sides')}</legend>
          <Checkbox
            label={t('customers:side_customer_hint')}
            checked={isCustomer}
            disabled={!mayEditCustomer || party.is_system}
            onChange={setIsCustomer}
          />
          <Checkbox
            label={t('customers:side_company_hint')}
            checked={isSupplier}
            disabled={!mayEditCompany || party.is_system}
            onChange={setIsSupplier}
          />
        </fieldset>
        {isSupplier ? (
          <TextField
            label={t('companies:contact_name')}
            hint={t('common:optional')}
            value={contactName}
            onChange={(event) => setContactName(event.target.value)}
          />
        ) : null}
        <TextField
          label={t('customers:phone')}
          hint={t('common:optional')}
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
        />
        <TextField
          label={t('customers:address')}
          hint={t('common:optional')}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <TextField
          label={t('glossary:notes')}
          hint={t('common:optional')}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
        {noSide ? (
          <p className="mz-field__error" role="alert">
            {t('errors:customer_no_side')}
          </p>
        ) : null}
        {error ? (
          <p className="mz-field__error" role="alert">
            {error}
          </p>
        ) : null}
        <Button
          block
          loading={saving}
          disabled={name.trim() === '' || noSide}
          onClick={() =>
            onSave({
              name: name.trim(),
              contact_name: contactName.trim() === '' ? null : contactName.trim(),
              phone: phone.trim() === '' ? null : phone.trim(),
              address: address.trim() === '' ? null : address.trim(),
              notes: notes.trim() === '' ? null : notes.trim(),
              is_customer: isCustomer,
              is_supplier: isSupplier,
              version: party.version,
            })
          }
        >
          {t('common:save')}
        </Button>
      </div>
    </BottomSheet>
  );
}

/** Every rate this business has had, newest first — a rate is never edited, only replaced. */
export function RateHistorySheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const rates = useQuery({
    queryKey: ['customers', id, 'rates'],
    queryFn: () =>
      apiRequest<{
        items: {
          id: string;
          rate_iqd_per_usd: string;
          effective_from: string;
          note: string | null;
          created_by_name: string | null;
        }[];
      }>(`/customers/${id}/rates`),
  });

  return (
    <BottomSheet title={t('companies:rate_history')} open onClose={onClose} closeLabel={t('common:close')}>
      <QueryStates
        query={rates}
        isEmpty={(rates.data?.items.length ?? 0) === 0}
        emptyTitle={t('companies:rate_is_global')}
      >
        <ul className="mz-list">
          {(rates.data?.items ?? []).map((row) => (
            <li key={row.id} className="mz-list__item">
              <span className="mz-list__body">
                <span className="mz-list__title" data-tabular>
                  {formatter.rate(row.rate_iqd_per_usd)}
                </span>
                <span className="mz-caption">
                  {t('companies:rate_since', { date: formatter.date(row.effective_from.slice(0, 10)) })}
                  {row.created_by_name ? ` · ${row.created_by_name}` : ''}
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
      </QueryStates>
    </BottomSheet>
  );
}

/**
 * Changing the settlement currency (FR-702, 2.3.5, D-054): with money on either side it needs
 * the rate the balances are carried over at, and it writes one marker entry per ledger — no
 * stored amount is ever recalculated.
 */
export function SettlementCurrencySheet({
  current,
  hasMoney,
  balance,
  rate,
  saving,
  error,
  onClose,
  onSave,
}: {
  current: Currency;
  /** Whether either side has money on it; then the carry-over needs a rate. */
  hasMoney: boolean;
  /** The figure shown as "now": the net where the caller may see it. */
  balance: number;
  rate: string;
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (body: unknown) => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const target: Currency = current === 'IQD' ? 'USD' : 'IQD';
  const [rebaseRate, setRebaseRate] = useState(rate);
  const [note, setNote] = useState('');

  return (
    <BottomSheet
      title={t('companies:settlement_currency_change')}
      open
      onClose={onClose}
      closeLabel={t('common:close')}
    >
      <div className="mz-stack">
        <div className="mz-row mz-row--between">
          <span className="mz-caption">{t('glossary:settlement_currency')}</span>
          <span className="mz-row" style={{ gap: 'var(--space-1)' }}>
            {t(`glossary:${current.toLowerCase()}`)}
            {/* The registry's arrow, which mirrors in RTL — a `→` character does not. */}
            <Icon name="next" size={16} />
            {t(`glossary:${target.toLowerCase()}`)}
          </span>
        </div>
        <div className="mz-row mz-row--between">
          <span className="mz-caption">{t('glossary:balance')}</span>
          <span data-tabular>{formatter.money(balance, current)}</span>
        </div>

        {hasMoney ? (
          <NumberField
            label={t('companies:rebase_rate')}
            decimals={4}
            value={rebaseRate}
            onChange={(event) => setRebaseRate(event.target.value)}
            error={error}
          />
        ) : null}
        <p className="mz-caption">{t('companies:rebase_hint')}</p>

        <TextField label={t('common:note')} value={note} onChange={(event) => setNote(event.target.value)} />

        <Button
          block
          loading={saving}
          disabled={note.trim() === '' || (hasMoney && rebaseRate.trim() === '')}
          onClick={() =>
            onSave({
              currency: target,
              note: note.trim(),
              rebase_rate: hasMoney ? rebaseRate.trim() : null,
            })
          }
        >
          {t('glossary:confirm')}
        </Button>
      </div>
    </BottomSheet>
  );
}

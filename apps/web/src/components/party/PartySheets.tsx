import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BottomSheet, Button, Icon, NumberField, TextField } from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { useFormatter, usePermission } from '../../lib/store.js';
import type { CustomerRow } from '../../pages/CustomersPage.js';

/**
 * Edit the account itself (FR-501, FR-701, D-055): its name, contact details and its own
 * conversion rate. A changed rate is written as a new rate — the old one is never edited — so
 * every order already saved keeps the rate it was made at, and History says who
 * changed it and when.
 */
export function EditPartySheet({
  party,
  saving,
  error,
  onClose,
  onSave,
  onEdit,
}: {
  party: CustomerRow;
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (body: Record<string, unknown>) => void;
  /** Any change to the inputs: the caller forgets the last refusal. */
  onEdit?: () => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const maySetCustomerRate = usePermission('customers.set_rate');
  const maySetCompanyRate = usePermission('companies.set_rate');
  const ownRate = party.rate?.is_customer_rate ? party.rate.rate_iqd_per_usd : '';
  const [name, setName] = useState(party.name);
  const [rate, setRate] = useState(ownRate);
  const [contactName, setContactName] = useState(party.contact_name ?? '');
  const [phone, setPhone] = useState(party.phone ?? '');
  const [address, setAddress] = useState(party.address ?? '');
  const [notes, setNotes] = useState(party.notes ?? '');
  const rateChanged = rate.trim() !== '' && rate.trim() !== ownRate;
  const edit = (set: (value: string) => void, value: string) => {
    onEdit?.();
    set(value);
  };

  return (
    <BottomSheet title={t('common:edit')} open onClose={onClose} closeLabel={t('common:close')}>
      {/* Two columns from a tablet up, so a laptop shows the whole form without scrolling. */}
      <div className="mz-form-grid">
        <div className="mz-form-grid__wide">
          <TextField
            label={t('customers:name')}
            value={name}
            onChange={(event) => edit(setName, event.target.value)}
          />
        </div>
        <TextField
          label={t('companies:contact_name')}
          hint={t('common:optional')}
          value={contactName}
          onChange={(event) => edit(setContactName, event.target.value)}
        />
        {(maySetCustomerRate || maySetCompanyRate) && !party.is_system ? (
          <NumberField
            label={t('customers:rate_field')}
            hint={t('customers:rate_field_edit_hint')}
            decimals={4}
            value={rate}
            placeholder={formatter.rate(party.rate?.rate_iqd_per_usd ?? '0')}
            onChange={(event) => edit(setRate, event.target.value)}
          />
        ) : null}
        <TextField
          label={t('customers:phone')}
          hint={t('common:optional')}
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={(event) => edit(setPhone, event.target.value)}
        />
        <TextField
          label={t('customers:address')}
          hint={t('common:optional')}
          value={address}
          onChange={(event) => edit(setAddress, event.target.value)}
        />
        <div className="mz-form-grid__wide">
          <TextField
            label={t('glossary:notes')}
            hint={t('common:optional')}
            value={notes}
            onChange={(event) => edit(setNotes, event.target.value)}
          />
        </div>
        {error ? (
          <p className="mz-field__error mz-form-grid__wide" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mz-form-grid__wide">
          <Button
            block
            loading={saving}
            disabled={name.trim() === ''}
            onClick={() =>
              onSave({
                name: name.trim(),
                contact_name: contactName.trim() === '' ? null : contactName.trim(),
                phone: phone.trim() === '' ? null : phone.trim(),
                address: address.trim() === '' ? null : address.trim(),
                notes: notes.trim() === '' ? null : notes.trim(),
                ...(rateChanged ? { rate_iqd_per_usd: rate.trim() } : {}),
                version: party.version,
              })
            }
          >
            {t('common:save')}
          </Button>
        </div>
      </div>
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
  rateRequired,
  onClose,
  onSave,
  onEdit,
}: {
  current: Currency;
  /** Whether either side has money on it; then the carry-over needs a rate. */
  hasMoney: boolean;
  /** The figure shown as "now": the net where the caller may see it. */
  balance: number;
  rate: string;
  saving: boolean;
  error?: string;
  /**
   * The server answered REBASE_RATE_REQUIRED. `hasMoney` is worked out from the balance the
   * caller may see, which reads zero when the figures are withheld or the two sides cancel —
   * while the server asks for a rate whenever either side has money. Its answer wins.
   */
  rateRequired?: boolean;
  onClose: () => void;
  onSave: (body: unknown) => void;
  /** Any change to the inputs: the caller forgets the last refusal. */
  onEdit?: () => void;
}) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  const target: Currency = current === 'IQD' ? 'USD' : 'IQD';
  const [rebaseRate, setRebaseRate] = useState(rate);
  const [note, setNote] = useState('');
  // Once the server has asked for the rate the field stays, even after the refusal is cleared
  // by typing — otherwise it would vanish under the thumb that is answering it.
  const [asked, setAsked] = useState(false);
  if (rateRequired && !asked) setAsked(true);
  const needsRate = hasMoney || asked || Boolean(rateRequired);

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

        {needsRate ? (
          <NumberField
            label={t('companies:rebase_rate')}
            decimals={4}
            value={rebaseRate}
            onChange={(event) => {
              onEdit?.();
              setRebaseRate(event.target.value);
            }}
            error={error}
          />
        ) : error ? (
          // With nothing owed there is no rate field to show a refusal under.
          <p className="mz-field__error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="mz-caption">{t('companies:rebase_hint')}</p>

        <TextField
          label={t('common:note')}
          value={note}
          onChange={(event) => {
            onEdit?.();
            setNote(event.target.value);
          }}
        />

        <Button
          block
          loading={saving}
          disabled={note.trim() === '' || (needsRate && rebaseRate.trim() === '')}
          onClick={() =>
            onSave({
              currency: target,
              note: note.trim(),
              rebase_rate: needsRate ? rebaseRate.trim() : null,
            })
          }
        >
          {t('glossary:confirm')}
        </Button>
      </div>
    </BottomSheet>
  );
}

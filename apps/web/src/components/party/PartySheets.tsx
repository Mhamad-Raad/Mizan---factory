import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { BottomSheet, Button, Icon, NumberField, TextField } from '@mizan/ui';
import type { Currency } from '@mizan/money';
import { apiRequest } from '../../lib/api.js';
import { Pager } from '../Pager.js';
import { QueryStates } from '../states.js';
import { DEFAULT_PAGE_SIZE, clampPageSize } from '../../lib/paging.js';
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
      <div className="mz-stack">
        <TextField label={t('customers:name')} value={name} onChange={(event) => edit(setName, event.target.value)} />
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
        <TextField
          label={t('glossary:notes')}
          hint={t('common:optional')}
          value={notes}
          onChange={(event) => edit(setNotes, event.target.value)}
        />
        {error ? (
          <p className="mz-field__error" role="alert">
            {error}
          </p>
        ) : null}
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
    </BottomSheet>
  );
}

/** Every rate this business has had, newest first — a rate is never edited, only replaced. */
export function RateHistorySheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const formatter = useFormatter();
  // A sheet's page is its own: it closes, so it does not belong in the address (D-058).
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const rates = useQuery({
    queryKey: ['customers', id, 'rates', page, pageSize],
    queryFn: () =>
      apiRequest<{
        items: {
          id: string;
          rate_iqd_per_usd: string;
          effective_from: string;
          note: string | null;
          created_by_name: string | null;
        }[];
        total: number;
      }>(`/customers/${id}/rates?page=${page}&page_size=${pageSize}`),
    placeholderData: keepPreviousData,
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
        <Pager
          page={page}
          pageSize={pageSize}
          total={rates.data?.total ?? 0}
          onPage={setPage}
          onPageSize={(size) => {
            setPageSize(clampPageSize(size));
            setPage(1);
          }}
        />
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

import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, NumberField, SegmentedControl, StickyFooter, TextField } from '@mizan/ui';
import { apiRequest, newIdempotencyKey } from '../lib/api.js';
import { errorMessage } from '../lib/errors.js';
import { useGlobalRate } from '../lib/rates.js';
import { usePageTitle } from '../lib/page-title.js';
import { MoneyInput } from '../components/MoneyInput.js';
import type { MoneyValue } from '../components/MoneyInput.js';
import { useFormatter, usePermission } from '../lib/store.js';
import { invalidateHistory } from '../lib/invalidate.js';

interface Duplicate {
  id: string;
  name: string;
}

/**
 * "New company" (FR-501, FR-701, D-054, D-055).
 *
 * One kind of account: a company that buys from us (D-062). Its own conversion rate is typed here,
 * on the same form — empty means the system-wide rate — because every order with it
 * is priced at that rate and keeps it. The duplicate check runs while the name is typed and over
 * *every* account, and offers to open the one that already exists instead.
 */
export function NewCustomerPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const formatter = useFormatter();
  const maySetCustomerRate = usePermission('customers.set_rate');
  const maySetCompanyRate = usePermission('companies.set_rate');
  const maySetRate = maySetCustomerRate || maySetCompanyRate;

  const [name, setName] = useState('');
  const [ownRate, setOwnRate] = useState('');
  const [contactName, setContactName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [currency, setCurrency] = useState<'IQD' | 'USD'>('IQD');
  const [creditLimit, setCreditLimit] = useState<MoneyValue>({ amount: null, currency: 'IQD', other_amount: null });
  const [idempotencyKey] = useState(newIdempotencyKey);

  const { rate: systemRate } = useGlobalRate();

  const duplicates = useQuery({
    queryKey: ['customers', 'duplicates', name.trim()],
    queryFn: () =>
      apiRequest<{ duplicates: Duplicate[] }>(`/customers/duplicates?name=${encodeURIComponent(name.trim())}`),
    enabled: name.trim().length >= 2,
  });

  const create = useMutation({
    mutationFn: () =>
      apiRequest<{ id: string }>('/customers', {
        method: 'POST',
        idempotencyKey,
        body: {
          name: name.trim(),
          contact_name: contactName.trim() === '' ? null : contactName.trim(),
          rate_iqd_per_usd: ownRate.trim() === '' ? null : ownRate.trim(),
          phone: phone.trim() === '' ? null : phone.trim(),
          address: address.trim() === '' ? null : address.trim(),
          notes: notes.trim() === '' ? null : notes.trim(),
          settlement_currency: currency,
          credit_limit:
            creditLimit.amount === null
              ? null
              : {
                  amount: creditLimit.amount,
                  currency: creditLimit.currency,
                  other_amount: creditLimit.other_amount ?? null,
                },
        },
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
      await queryClient.invalidateQueries({ queryKey: ['companies'] });
      await invalidateHistory(queryClient);
      navigate(`/customers/${created.id}`, { replace: true });
    },
  });

  const matches = duplicates.data?.duplicates ?? [];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() !== '') create.mutate();
  };

  usePageTitle(t('customers:new_party'));

  return (
    <form className="mz-stack mz-form-page" onSubmit={submit} noValidate>
      <Card>
        <div className="mz-stack">
          <h2 className="mz-heading">{t('customers:new_party')}</h2>

          <div className="mz-form-grid">
            <div className="mz-form-grid__wide">
              <TextField
                label={t('customers:name')}
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
                maxLength={200}
              />
            </div>

            {matches.length > 0 ? (
              <div className="mz-warning mz-form-grid__wide" role="status">
                <span>
                  {t('customers:duplicate_open', { name: matches[0]?.name ?? '' })}{' '}
                  <Link to={`/customers/${matches[0]?.id ?? ''}`}>{t('customers:open_existing')}</Link>
                </span>
              </div>
            ) : null}

            <TextField
              label={t('companies:contact_name')}
              hint={t('common:optional')}
              value={contactName}
              onChange={(event) => setContactName(event.target.value)}
              maxLength={200}
            />
            <TextField
              label={t('customers:phone')}
              hint={t('common:optional')}
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              maxLength={40}
            />
            <div className="mz-form-grid__wide">
              <TextField
                label={t('customers:address')}
                hint={t('common:optional')}
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                maxLength={500}
              />
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <div className="mz-stack">
          {/* The company's own conversion rate (2.3.3, D-055): what its orders are
              priced at, and what each of them keeps. Empty, the system-wide rate applies. */}
          {maySetRate ? (
            <NumberField
              label={t('customers:rate_field')}
              hint={
                systemRate === null
                  ? t('settings:no_rate_yet')
                  : t('customers:rate_field_hint', { rate: formatter.rate(systemRate) })
              }
              decimals={4}
              value={ownRate}
              onChange={(event) => setOwnRate(event.target.value)}
            />
          ) : null}

          <SegmentedControl
            label={t('glossary:settlement_currency')}
            value={currency}
            onChange={setCurrency}
            options={[
              { value: 'IQD', label: t('glossary:iqd') },
              { value: 'USD', label: t('glossary:usd') },
            ]}
          />

          {/* Proposed — not requested (FR-616): a warning on a borrowed order, never a block. */}
          <MoneyInput
            label={t('customers:credit_limit')}
            value={creditLimit}
            rate={systemRate}
            onChange={setCreditLimit}
            hint={t('customers:credit_limit_hint')}
          />

          <TextField
            label={t('glossary:notes')}
            hint={t('common:optional')}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={2000}
          />

          {create.error ? (
            <p className="mz-field__error" role="alert">
              {errorMessage(t, create.error)}
            </p>
          ) : null}
        </div>
      </Card>

      <StickyFooter>
        <Button type="submit" block loading={create.isPending} disabled={name.trim() === ''}>
          {t('common:save')}
        </Button>
        <Button type="button" variant="ghost" block onClick={() => navigate('/customers')}>
          {t('glossary:cancel')}
        </Button>
      </StickyFooter>
    </form>
  );
}

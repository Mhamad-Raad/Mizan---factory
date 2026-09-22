import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, SegmentedControl, TextField } from '@mizan/ui';
import { apiRequest, newIdempotencyKey } from '../lib/api.js';
import { AppShell } from '../components/AppShell.js';
import { MoneyInput } from '../components/MoneyInput.js';
import type { MoneyValue } from '../components/MoneyInput.js';
import { usePermission } from '../lib/store.js';

interface Duplicate {
  id: string;
  name: string;
  assigned_user_name: string | null;
}

/**
 * "New customer" (FR-501). The duplicate check runs while the name is typed and over *every*
 * customer, whatever this employee may see: when the twin belongs to a colleague the warning
 * says to ask the admin instead of offering to open a record they cannot reach — which is
 * what keeps the directory from filling with duplicates.
 */
export function NewCustomerPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mayAssign = usePermission('customers.assign');

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [currency, setCurrency] = useState<'IQD' | 'USD'>('IQD');
  const [assignee, setAssignee] = useState('');
  const [creditLimit, setCreditLimit] = useState<MoneyValue>({ amount: null, currency: 'IQD', other_amount: null });
  const [idempotencyKey] = useState(newIdempotencyKey);

  const rate = useQuery({
    queryKey: ['global-rate'],
    queryFn: () => apiRequest<{ current: { rate_iqd_per_usd: string } | null }>('/settings/global-rates'),
  });

  const directory = useQuery({
    queryKey: ['users', 'directory'],
    queryFn: () => apiRequest<{ id: string; display_name: string; is_active: boolean }[]>('/users/directory'),
    enabled: mayAssign,
  });

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
          phone: phone.trim() === '' ? null : phone.trim(),
          address: address.trim() === '' ? null : address.trim(),
          notes: notes.trim() === '' ? null : notes.trim(),
          settlement_currency: currency,
          assigned_user_id: assignee === '' ? null : assignee,
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
      navigate(`/customers/${created.id}`, { replace: true });
    },
  });

  const matches = duplicates.data?.duplicates ?? [];

  return (
    <AppShell title={t('customers:new_customer')}>
      <div className="mz-stack">
        <TextField
          label={t('customers:name')}
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
          maxLength={200}
        />

        {matches.length > 0 ? (
          <div className="mz-warning" role="status">
            <span>
              {matches[0]?.assigned_user_name
                ? t('customers:duplicate_assigned', {
                    name: matches[0].name,
                    employee: matches[0].assigned_user_name,
                  })
                : t('customers:duplicate_open', { name: matches[0]?.name ?? '' })}
              {matches[0] && !matches[0].assigned_user_name ? (
                <>
                  {' '}
                  <Link to={`/customers/${matches[0].id}`}>{t('customers:open_existing')}</Link>
                </>
              ) : null}
            </span>
          </div>
        ) : null}

        <TextField
          label={t('customers:phone')}
          hint={t('common:optional')}
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          maxLength={40}
        />
        <TextField
          label={t('customers:address')}
          hint={t('common:optional')}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          maxLength={500}
        />

        <SegmentedControl
          label={t('glossary:settlement_currency')}
          value={currency}
          onChange={setCurrency}
          options={[
            { value: 'IQD', label: t('glossary:iqd') },
            { value: 'USD', label: t('glossary:usd') },
          ]}
        />

        {mayAssign ? (
          <label className="mz-field">
            <span className="mz-field__label">{t('glossary:assigned_to')}</span>
            <select
              className="mz-field__control"
              value={assignee}
              onChange={(event) => setAssignee(event.target.value)}
            >
              <option value="">{t('customers:unassigned')}</option>
              {(directory.data ?? [])
                .filter((user) => user.is_active)
                .map((user) => (
                  <option key={user.id} value={user.id}>
                    <bdi>{user.display_name}</bdi>
                  </option>
                ))}
            </select>
          </label>
        ) : null}

        {/* Proposed — not requested (FR-616): a warning on a borrowed order, never a block. */}
        <MoneyInput
          label={t('customers:credit_limit')}
          value={creditLimit}
          rate={rate.data?.current?.rate_iqd_per_usd ?? '1310.0000'}
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

        <Button block loading={create.isPending} disabled={name.trim() === ''} onClick={() => create.mutate()}>
          {t('common:save')}
        </Button>
        <Button variant="ghost" onClick={() => navigate('/customers')}>
          {t('glossary:cancel')}
        </Button>
      </div>
    </AppShell>
  );
}

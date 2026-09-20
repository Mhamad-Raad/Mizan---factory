import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, SegmentedControl, TextField } from '@mizan/ui';
import { ApiError, apiRequest, newIdempotencyKey } from '../lib/api.js';
import { AppShell } from '../components/AppShell.js';
import { usePermission } from '../lib/store.js';

/**
 * "New company" (FR-701). A company name is unique — two rows for one supplier would split
 * the account they exist to keep — so the API refuses a twin and the form shows the existing
 * one with a link, rather than a bare validation error.
 */
export function NewCompanyPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mayAssign = usePermission('companies.assign');

  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [currency, setCurrency] = useState<'IQD' | 'USD'>('IQD');
  const [assignee, setAssignee] = useState('');
  const [idempotencyKey] = useState(newIdempotencyKey);

  const directory = useQuery({
    queryKey: ['users', 'directory'],
    queryFn: () => apiRequest<{ id: string; display_name: string; is_active: boolean }[]>('/users/directory'),
    enabled: mayAssign,
  });

  const create = useMutation({
    mutationFn: () =>
      apiRequest<{ id: string }>('/companies', {
        method: 'POST',
        idempotencyKey,
        body: {
          name: name.trim(),
          contact_name: contact.trim() === '' ? null : contact.trim(),
          phone: phone.trim() === '' ? null : phone.trim(),
          address: address.trim() === '' ? null : address.trim(),
          notes: notes.trim() === '' ? null : notes.trim(),
          settlement_currency: currency,
          assigned_user_id: assignee === '' ? null : assignee,
        },
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['companies'] });
      navigate(`/companies/${created.id}`, { replace: true });
    },
  });

  const duplicate =
    create.error instanceof ApiError ? create.error.fieldError('name') : undefined;
  const existingId = duplicate?.params?.id as string | undefined;
  const existingName = duplicate?.params?.name as string | undefined;

  return (
    <AppShell title={t('companies:new_company')}>
      <div className="mz-stack">
        <TextField
          label={t('companies:name')}
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
          maxLength={200}
          error={duplicate ? t('errors:duplicate_company') : undefined}
        />

        {duplicate && existingId ? (
          <div className="mz-warning" role="status">
            <span>
              {t('companies:duplicate_name', { name: existingName ?? name.trim() })}{' '}
              <Link to={`/companies/${existingId}`}>{t('companies:open_existing')}</Link>
            </span>
          </div>
        ) : null}

        <TextField
          label={t('companies:contact_name')}
          hint={t('common:optional')}
          value={contact}
          onChange={(event) => setContact(event.target.value)}
          maxLength={200}
        />
        <TextField
          label={t('companies:phone')}
          hint={t('common:optional')}
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          maxLength={40}
        />
        <TextField
          label={t('companies:address')}
          hint={t('common:optional')}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          maxLength={500}
        />

        {/* The currency this account is kept and settled in; changing it later re-bases the
            balance through one marker entry, so it is a decision, not a display option (2.3.5). */}
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
              <option value="">{t('companies:unassigned')}</option>
              {(directory.data ?? [])
                .filter((user) => user.is_active)
                .map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.display_name}
                  </option>
                ))}
            </select>
          </label>
        ) : null}

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
        <Button variant="ghost" onClick={() => navigate('/companies')}>
          {t('glossary:cancel')}
        </Button>
      </div>
    </AppShell>
  );
}

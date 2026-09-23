import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { applyPreset } from '@mizan/permissions';
import { Button, Card, SegmentedControl, TextField } from '@mizan/ui';
import { ApiError, apiRequest, newIdempotencyKey } from '../lib/api.js';
import { usePageTitle } from '../lib/page-title.js';
import { PermissionEditor } from '../components/PermissionEditor.js';
import type { PermissionSelection } from '../components/PermissionEditor.js';


export function NewUserPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<'employee' | 'admin'>('employee');
  /**
   * What the new employee may do, chosen here rather than on a second visit.
   *
   * The screen used to offer a preset and nothing else, so an employee who needed anything
   * other than the three presets had to be created and then opened and edited — and the admin
   * could not see, while creating them, what they were about to be able to do. It is the same
   * editor the Permissions tab uses, so the two screens cannot drift apart.
   */
  const [permissions, setPermissions] = useState<PermissionSelection>(() => ({
    keys: [...applyPreset([], 'sales').keys],
    preset: 'sales',
  }));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);
  /** One key per submission, reused by a retry so a timeout cannot create two accounts. */
  const [idempotencyKey] = useState(newIdempotencyKey);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFieldErrors({});
    try {
      const response = await apiRequest<{ user: { id: string }; temporary_password: string }>('/users', {
        method: 'POST',
        idempotencyKey,
        body: {
          display_name: displayName,
          username,
          phone: phone || null,
          role,
          preset_key: permissions.preset === 'none' ? null : permissions.preset,
          keys: role === 'employee' ? permissions.keys : undefined,
        },
      });
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      setTemporaryPassword(response.temporary_password);
    } catch (caught) {
      if (caught instanceof ApiError && caught.fields.length > 0) {
        setFieldErrors(
          Object.fromEntries(caught.fields.map((field) => [field.path, t(field.message_key, field.params ?? {})])),
        );
      } else {
        setFieldErrors({ username: t('errors:INTERNAL') });
      }
    } finally {
      setBusy(false);
    }
  };

  usePageTitle(t('users:new_user'));

  if (temporaryPassword) {
    return (
      <>
        <Card>
          <div className="mz-stack">
            <h2 className="mz-heading">{t('auth:temporary_password')}</h2>
            <p className="mz-muted">{t('auth:temporary_password_once')}</p>
            <p className="mz-title" dir="ltr" data-tabular>
              {temporaryPassword}
            </p>
            <Button
              variant="secondary"
              onClick={() => void navigator.clipboard?.writeText(temporaryPassword)}
            >
              {t('common:copy')}
            </Button>
            <Button onClick={() => navigate('/users')}>{t('users:title')}</Button>
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      <Card>
        <form className="mz-stack" onSubmit={submit} noValidate>
          <TextField
            label={t('users:display_name')}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            error={fieldErrors.display_name}
            required
          />
          <TextField
            label={t('users:username')}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            error={fieldErrors.username}
            autoCapitalize="none"
            autoCorrect="off"
            dir="ltr"
            required
          />
          <TextField
            label={t('users:phone')}
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            error={fieldErrors.phone}
            type="tel"
            inputMode="tel"
          />
          <SegmentedControl
            label={t('users:role')}
            value={role}
            onChange={setRole}
            options={[
              { value: 'employee', label: t('glossary:employee') },
              { value: 'admin', label: t('glossary:admin') },
            ]}
          />
          {role === 'employee' ? (
            <PermissionEditor value={permissions} onChange={setPermissions} />
          ) : (
            // An admin holds every key, so there is nothing to choose (FR-105).
            <p className="mz-caption">{t('permissions:simple_mode')}</p>
          )}

          <Button type="submit" block loading={busy} disabled={!displayName || !username}>
            {t('users:create')}
          </Button>
        </form>
      </Card>
    </>
  );
}

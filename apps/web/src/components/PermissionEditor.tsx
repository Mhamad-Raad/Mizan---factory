import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  EXTRAS,
  PAGES,
  PERMISSIONS,
  applyExtra,
  applyPreset,
  extraState,
  isCustomisedBeyondExtras,
  setKey,
} from '@mizan/permissions';
import type { ExtraKey, PresetKey } from '@mizan/permissions';
import { Chip, SegmentedControl, Toggle } from '@mizan/ui';

export interface PermissionSelection {
  keys: string[];
  preset: PresetKey | 'none';
}

/**
 * The permission editor — **one** editor, used where an employee is created and where they are
 * edited afterwards (FR-204, wireframe 3.4.4).
 *
 * It lived inside the employee's Permissions tab, so a new employee could only be given a
 * preset and had to be opened again to be told what they may actually do. The set is per action
 * per feature either way (48 keys), so the same three layers belong on both screens: a **preset**
 * as a starting point (1.5.3), the six **everyday extras** that cover what an admin changes
 * weekly, and the **Advanced grid** of every key for the rare role the presets do not fit.
 *
 * Controlled on purpose: the caller owns the set, because on one screen it is a draft against a
 * saved set and on the other it is part of a form that has not created anybody yet.
 */
export function PermissionEditor({
  value,
  onChange,
  disabled,
}: {
  value: PermissionSelection;
  onChange: (next: PermissionSelection) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  /** Transient feedback: what a change dragged along with it, and what it refused to do. */
  const [notes, setNotes] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<string | null>(null);
  const { keys, preset } = value;
  const customised = isCustomisedBeyondExtras(keys, preset === 'none' ? null : preset);

  return (
    <div className="mz-stack">
      <SegmentedControl
        label={t('glossary:preset')}
        value={preset}
        onChange={(next) => {
          const applied = next === 'none' ? { keys: new Set(keys) } : applyPreset(keys, next);
          onChange({ keys: [...applied.keys], preset: next });
          setNotes([]);
          setBlocked(null);
        }}
        options={[
          { value: 'sales', label: t('permissions:preset.sales') },
          { value: 'warehouse', label: t('permissions:preset.warehouse') },
          { value: 'accountant', label: t('permissions:preset.accountant') },
          { value: 'none', label: t('permissions:preset.none') },
        ]}
      />

      <h3 className="mz-heading">{t('permissions:extras')}</h3>
      {EXTRAS.map((extra) => {
        const state = extraState(keys, extra.key as ExtraKey);
        return (
          <Toggle
            key={extra.key}
            label={t(`permissions:extra.${extra.key}`)}
            hint={state === 'partly' ? t('permissions:state_partly') : undefined}
            checked={state === 'on' ? true : state === 'partly' ? 'mixed' : false}
            disabled={disabled}
            onChange={(next) => {
              const result = applyExtra(keys, extra.key as ExtraKey, next);
              if (result.blockedBy) {
                setBlocked(t('permissions:blocked_by', { keys: result.blockedBy.join(', ') }));
                return;
              }
              setBlocked(null);
              onChange({ keys: [...result.keys], preset });
              setNotes([
                ...(result.alsoGranted.length > 0
                  ? [t('permissions:also_granted', { keys: result.alsoGranted.join(', ') })]
                  : []),
                ...(result.alsoRevoked.length > 0
                  ? [t('permissions:also_revoked', { keys: result.alsoRevoked.join(', ') })]
                  : []),
              ]);
            }}
          />
        );
      })}

      {blocked ? (
        <p className="mz-field__error" role="alert">
          {blocked}
        </p>
      ) : null}
      {notes.map((note) => (
        <p key={note} className="mz-field__hint">
          {note}
        </p>
      ))}

      {customised ? (
        <Chip tone="warning" icon="warning">
          {t('permissions:customised_in_advanced')}
        </Chip>
      ) : null}

      {/* The full grid, folded away: the simple editor covers the three roles this factory has,
          and the grid is for the rare one it does not. */}
      <details className="mz-disclosure">
        <summary className="mz-disclosure__summary">{t('settings:advanced_permissions')}</summary>
        <p className="mz-caption">{t('settings:advanced_permissions_hint')}</p>
        <PermissionGrid
          keys={keys}
          disabled={disabled}
          onChange={(next, note) => {
            setBlocked(null);
            onChange({ keys: next, preset });
            setNotes(note ? [note] : []);
          }}
        />
      </details>
    </div>
  );
}

/**
 * Every key, grouped by the screen it belongs to (FR-204, wireframe 3.4.4).
 *
 * Turning a key on turns on what it implies, and the row says so — an admin who grants "record
 * a payment" should see that "see customer balances" came with it rather than discover it
 * later. Turning one off takes away the keys that cannot stand without it, for the same reason.
 */
function PermissionGrid({
  keys,
  disabled,
  onChange,
}: {
  keys: readonly string[];
  disabled?: boolean;
  onChange: (keys: string[], note: string | null) => void;
}) {
  const { t } = useTranslation();
  const granted = useMemo(() => new Set(keys), [keys]);

  return (
    <div className="mz-stack">
      {PAGES.map((page) => (
        <div key={page} className="mz-stack" style={{ gap: 'var(--space-2)' }}>
          <h4 className="mz-caption">{t(`permissions:page.${page}`, { defaultValue: page })}</h4>
          {PERMISSIONS.filter((definition) => definition.page === page).map((definition) => (
            <Toggle
              key={definition.key}
              label={t(`permissions:${definition.labelKey}`, { defaultValue: definition.key })}
              hint={
                definition.implies.length > 0
                  ? t('settings:implied_by', { key: definition.implies.join(', ') })
                  : undefined
              }
              checked={granted.has(definition.key)}
              disabled={disabled}
              onChange={(next) => {
                const result = setKey(keys, definition.key, next);
                const alsoGranted =
                  result.alsoGranted.length > 0
                    ? t('permissions:also_granted', { keys: result.alsoGranted.join(', ') })
                    : null;
                const alsoRevoked =
                  result.alsoRevoked.length > 0
                    ? t('permissions:also_revoked', { keys: result.alsoRevoked.join(', ') })
                    : null;
                onChange([...result.keys], alsoGranted ?? alsoRevoked);
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

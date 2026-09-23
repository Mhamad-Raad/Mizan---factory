import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PAGES, PERMISSIONS, PRESETS, applyPreset, setKey } from '@mizan/permissions';
import type { PresetKey } from '@mizan/permissions';
import { Button, Checkbox } from '@mizan/ui';

export interface PermissionSelection {
  keys: string[];
  /** Which preset was applied, for the label on the employee's row; the keys are the truth. */
  preset: PresetKey | 'none';
}

const PRESET_KEYS: PresetKey[] = ['sales', 'warehouse', 'accountant'];

/**
 * What an employee may do, per action per feature (FR-204, wireframe 3.4.4).
 *
 * **Nothing is selected to begin with.** A preset is a *shortcut*, not a state: pressing
 * "Sales" ticks the boxes that preset holds and leaves them editable, and an employee who
 * needs something else is given it by ticking a box rather than by being pushed into the
 * nearest role. Pressing nothing and ticking nothing is a valid answer too — an account that
 * can sign in and see nothing yet.
 *
 * The keys are grouped by the screen they govern, because that is how the admin thinks about
 * them ("what can they do on Orders?"), and a group is a few checkboxes rather than a column
 * of switches — forty-eight settings, each taking the width of the form, was a page nobody
 * could take in.
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
  /** What the last change dragged along with it, and what it refused to take away. */
  const [note, setNote] = useState<string | null>(null);
  const granted = useMemo(() => new Set(value.keys), [value.keys]);

  /**
   * A key's own name, for the places that used to print the identifier.
   *
   * "Comes with fields.see_bought_price" is a sentence for a developer; the admin reading this
   * screen should be told "Comes with: See bought prices" — the same words as the checkbox two
   * groups over (1.6).
   */
  const names = useMemo(
    () => new Map(PERMISSIONS.map((definition) => [definition.key, definition.labelKey])),
    [],
  );
  const nameOf = (key: string): string =>
    t(`permissions:${names.get(key) ?? ''}`, { defaultValue: key });

  const apply = (preset: PresetKey): void => {
    const applied = applyPreset([], preset);
    onChange({ keys: [...applied.keys], preset });
    setNote(t('permissions:preset_applied', { preset: t(`permissions:preset.${preset}`) }));
  };

  const clear = (): void => {
    onChange({ keys: [], preset: 'none' });
    setNote(null);
  };

  return (
    <div className="mz-stack">
      <div className="mz-stack" style={{ gap: 'var(--space-2)' }}>
        <p className="mz-field__label">{t('permissions:start_from')}</p>
        <div className="mz-row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {PRESET_KEYS.map((preset) => (
            <Button key={preset} variant="secondary" disabled={disabled} onClick={() => apply(preset)}>
              {t(`permissions:preset.${preset}`)}
            </Button>
          ))}
          <Button variant="ghost" disabled={disabled || value.keys.length === 0} onClick={clear}>
            {t('permissions:clear_all')}
          </Button>
        </div>
        <p className="mz-field__hint">{t('permissions:presets_are_a_start')}</p>
      </div>

      {note ? <p className="mz-field__hint">{note}</p> : null}

      <div className="mz-check-groups">
        {PAGES.map((page) => {
          const keys = PERMISSIONS.filter((definition) => definition.page === page);
          if (keys.length === 0) return null;
          const on = keys.filter((definition) => granted.has(definition.key)).length;
          return (
            <fieldset key={page} className="mz-check-group">
              <legend className="mz-check-group__legend">
                {t(`permissions:page.${page}`, { defaultValue: page })}
                <span className="mz-caption">{on > 0 ? ` · ${on}/${keys.length}` : ''}</span>
              </legend>
              {keys.map((definition) => (
                <Checkbox
                  key={definition.key}
                  label={t(`permissions:${definition.labelKey}`, { defaultValue: definition.key })}
                  hint={
                    definition.implies.length > 0
                      ? t('permissions:comes_with', {
                          keys: definition.implies.map((implied) => nameOf(implied)).join(', '),
                        })
                      : undefined
                  }
                  checked={granted.has(definition.key)}
                  disabled={disabled}
                  onChange={(next) => {
                    // Turning a key on turns on what it implies, and the note says so: an admin
                    // granting "record a payment" should see that "see balances" came with it.
                    const result = setKey(value.keys, definition.key, next);
                    onChange({ keys: [...result.keys], preset: value.preset });
                    setNote(
                      result.alsoGranted.length > 0
                        ? t('permissions:also_granted', {
                            keys: result.alsoGranted.map((key) => nameOf(key)).join(', '),
                          })
                        : result.alsoRevoked.length > 0
                          ? t('permissions:also_revoked', {
                              keys: result.alsoRevoked.map((key) => nameOf(key)).join(', '),
                            })
                          : null,
                    );
                  }}
                />
              ))}
            </fieldset>
          );
        })}
      </div>

      <p className="mz-caption">
        {t('permissions:n_selected', { count: value.keys.length, total: PERMISSIONS.length })}
        {value.preset !== 'none' && PRESETS[value.preset]
          ? ` · ${t('permissions:started_from', { preset: t(`permissions:preset.${value.preset}`) })}`
          : ''}
      </p>
    </div>
  );
}

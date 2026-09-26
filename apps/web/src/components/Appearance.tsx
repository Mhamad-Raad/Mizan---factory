import { useId } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Icon } from '@mizan/ui';
import type { IconName } from '@mizan/ui';
import { LANGUAGE_NAMES, LOCALES, directionOf } from '@mizan/i18n';
import { FONT_SCALES, THEMES, resolveTheme } from '../lib/preferences.js';
import type { FontScale, Theme } from '../lib/preferences.js';
import { useApp } from '../lib/store.js';

/**
 * How the device looks and which language it speaks (FR-1103), as choices you can see.
 *
 * A theme is a picture, not a word: each card draws a miniature of the whole screen — sidebar,
 * heading, three figures, a striped table — in the theme it would give you, and "Follow device"
 * honestly draws both halves. A text size is drawn *at* that size, in a field like the ones the
 * forms use. This is the arrangement the client asked to be copied from the item-management
 * system, whose appearance page works the same way.
 */

const THEME_ICONS: Record<Theme, IconName> = { light: 'sun', dark: 'moon', auto: 'monitor' };

/** What each size is called — the same four names the old strip carried. */
const SCALE_LABELS: Record<FontScale, string> = {
  0.875: 'settings:font_small',
  1: 'settings:font_default',
  1.125: 'settings:font_large',
  1.25: 'settings:font_xlarge',
};

/** The root font size the browser gives us, which `--font-scale` multiplies (base.css). */
const ROOT_FONT_PX = 16;

/**
 * One choice in an appearance group.
 *
 * The radio is real and lives inside its label, so the group is announced as a single choice and
 * the arrow keys walk it in the reading direction; it is then made invisible and stretched over
 * the whole card, so a press anywhere on the picture lands on the control itself. The preview is
 * a picture and carries no name — the radio is named by its title alone.
 */
function OptionCard({
  name,
  value,
  checked,
  onSelect,
  title,
  hint,
  icon,
  preview,
}: {
  name: string;
  value: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  hint?: string;
  icon?: IconName;
  preview?: ReactNode;
}) {
  const hintId = useId();
  return (
    <label className="mz-option" data-selected={checked ? 'true' : undefined}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onSelect}
        aria-label={title}
        aria-describedby={hint ? hintId : undefined}
        className="mz-option__input"
      />
      {preview ? <span className="mz-option__preview">{preview}</span> : null}
      <span className="mz-option__row">
        {icon ? (
          <span className="mz-option__badge" aria-hidden="true">
            <Icon name={icon} size={18} />
          </span>
        ) : null}
        <span className="mz-option__body">
          <span className="mz-option__title">{title}</span>
          {hint ? (
            <span className="mz-option__hint" id={hintId}>
              {hint}
            </span>
          ) : null}
        </span>
        {/* The tick is the second signal, for whoever cannot see the ring (WCAG 1.4.1). */}
        {checked ? (
          <span className="mz-option__check" aria-hidden="true">
            <Icon name="check" size={14} />
          </span>
        ) : null}
      </span>
    </label>
  );
}

/** A titled group of option cards, named by its own heading and described by its hint. */
function OptionGroup({
  title,
  hint,
  wide,
  children,
}: {
  title: string;
  hint: string;
  /** Three or four across on a desktop; a text size needs the room, a language does not. */
  wide?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <Card>
      <div className="mz-stack">
        <h2 className="mz-heading" id={`${id}-title`}>
          {title}
        </h2>
        <p className="mz-muted" id={`${id}-hint`}>
          {hint}
        </p>
        <div
          role="radiogroup"
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-hint`}
          className={wide ? 'mz-options mz-options--wide' : 'mz-options'}
        >
          {children}
        </div>
      </div>
    </Card>
  );
}

/**
 * The application in miniature, drawn from the tokens alone.
 *
 * `data-theme` on this box makes the ramp declare itself again here (tokens.css), so a light
 * miniature stays light inside a dark app — which is the whole point of the preview.
 */
function Miniature({ mode }: { mode: 'light' | 'dark' }) {
  return (
    <span className="mz-mini" data-theme={mode}>
      <span className="mz-mini__nav">
        <span className="mz-mini__brand" />
        <span className="mz-mini__row mz-mini__row--on" />
        <span className="mz-mini__row" />
        <span className="mz-mini__row" />
      </span>
      <span className="mz-mini__body">
        <span className="mz-mini__bar">
          <span className="mz-mini__title" />
          <span className="mz-mini__dot" />
        </span>
        <span className="mz-mini__tiles">
          <span className="mz-mini__tile">
            <span className="mz-mini__label" />
            <span className="mz-mini__figure" />
          </span>
          <span className="mz-mini__tile">
            <span className="mz-mini__label" />
            <span className="mz-mini__figure mz-mini__figure--success" />
          </span>
          <span className="mz-mini__tile">
            <span className="mz-mini__label" />
            <span className="mz-mini__figure mz-mini__figure--warning" />
          </span>
        </span>
        <span className="mz-mini__table">
          <span className="mz-mini__head" />
          <span className="mz-mini__line" />
          <span className="mz-mini__line mz-mini__line--alt" />
        </span>
      </span>
    </span>
  );
}

/** `auto` cannot honestly be one screen, so it is drawn as both. */
function ThemePreview({ mode }: { mode: Theme }) {
  if (mode === 'auto') {
    return (
      <span className="mz-mini-pair" aria-hidden="true">
        <Miniature mode="light" />
        <Miniature mode="dark" />
      </span>
    );
  }
  return (
    <span aria-hidden="true">
      <Miniature mode={mode} />
    </span>
  );
}

/**
 * A field drawn at the size the option produces.
 *
 * The application scales through the root font size, so the specimen sets that size on its own
 * box and everything inside is measured in `em`: a preview in `rem` would draw all four cards
 * identically, which is the one thing it must not do.
 */
function TextSpecimen({ scale, label, sample }: { scale: FontScale; label: string; sample: string }) {
  return (
    <span className="mz-specimen" aria-hidden="true" style={{ fontSize: `${ROOT_FONT_PX * scale}px` }}>
      <span className="mz-specimen__label">{label}</span>
      <span className="mz-specimen__field" data-tabular>
        {sample}
      </span>
    </span>
  );
}

/** Language, theme and text size: the three cards at the top of Settings. */
export function AppearanceCards() {
  const { t } = useTranslation();
  const preferences = useApp((state) => state.preferences);
  const setPreference = useApp((state) => state.setPreference);

  return (
    <>
      <OptionGroup title={t('settings:language')} hint={t('settings:language_hint')}>
        {LOCALES.map((locale) => (
          <OptionCard
            key={locale}
            name="mizan-language"
            value={locale}
            checked={preferences.lang === locale}
            onSelect={() => setPreference('lang', locale)}
            // A language is named in its own script, never translated (spec 1.6).
            title={LANGUAGE_NAMES[locale]}
            hint={directionOf(locale) === 'rtl' ? t('settings:reads_rtl') : t('settings:reads_ltr')}
            icon="language"
          />
        ))}
      </OptionGroup>

      <OptionGroup title={t('settings:theme')} hint={t('settings:theme_hint')}>
        {THEMES.map((mode) => (
          <OptionCard
            key={mode}
            name="mizan-theme"
            value={mode}
            checked={preferences.theme === mode}
            onSelect={() => setPreference('theme', mode)}
            title={t(`settings:theme_${mode}`)}
            hint={t(`settings:theme_${mode}_hint`)}
            icon={THEME_ICONS[mode]}
            preview={<ThemePreview mode={mode} />}
          />
        ))}
      </OptionGroup>

      <OptionGroup title={t('settings:font_size')} hint={t('settings:font_size_hint')} wide>
        {FONT_SCALES.map((scale) => (
          <OptionCard
            key={scale}
            name="mizan-font-scale"
            value={String(scale)}
            checked={preferences.fontScale === scale}
            onSelect={() => setPreference('fontScale', scale)}
            title={t(SCALE_LABELS[scale])}
            preview={
              <TextSpecimen scale={scale} label={t(SCALE_LABELS[scale])} sample={t('settings:font_preview')} />
            }
          />
        ))}
      </OptionGroup>
    </>
  );
}

/**
 * The same two choices as menus, for the app bar (spec 3.7.4).
 *
 * They are built here rather than in the shell so that the bar and the Settings cards offer the
 * identical list of modes and sizes, in the identical order, with the identical names.
 */
export function useAppearanceMenus() {
  const { t } = useTranslation();
  const preferences = useApp((state) => state.preferences);
  const setPreference = useApp((state) => state.setPreference);
  const onScreen = resolveTheme(preferences.theme);

  /** The icon the bar shows: what the theme resolves to *now*, not what was chosen. */
  const themeIcon: IconName = onScreen === 'dark' ? 'moon' : 'sun';

  return {
    themeIcon,
    themeItems: THEMES.map((mode) => ({
      label: t(`settings:theme_${mode}`),
      current: preferences.theme === mode,
      onSelect: () => setPreference('theme', mode),
    })),
    textItems: FONT_SCALES.map((scale) => ({
      label: t(SCALE_LABELS[scale]),
      current: preferences.fontScale === scale,
      onSelect: () => setPreference('fontScale', scale),
    })),
  };
}

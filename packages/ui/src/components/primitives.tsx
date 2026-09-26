import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons/registry.js';
import type { IconName } from '../icons/registry.js';

/**
 * The component library. It mirrors the names and behaviour of the palette system's
 * `@factory/ui` (spec 2.10.11) and consumes semantic tokens only, so replacing it with the
 * real package is an import change and no screen is touched (decision D-001).
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  block?: boolean;
  loading?: boolean;
  icon?: IconName;
}

export function Button({ variant = 'primary', block, loading, icon, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={`mz-button mz-button--${variant}${block ? ' mz-button--block' : ''}`}
      aria-busy={loading || undefined}
      {...rest}
      disabled={rest.disabled || loading}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  /** Required: an icon alone is never a label for a screen reader (NFR-10). */
  label: string;
}

export function IconButton({ icon, label, ...rest }: IconButtonProps) {
  return (
    <button type="button" className="mz-icon-button" aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={22} />
    </button>
  );
}

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  children: (id: string) => ReactNode;
}

export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  return (
    <div className={`mz-field${error ? ' mz-field--invalid' : ''}`}>
      <label className="mz-field__label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint && !error ? <span className="mz-field__hint">{hint}</span> : null}
      {error ? (
        <span className="mz-field__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function TextField({ label, hint, error, ...rest }: TextFieldProps) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(id) => (
        <input
          id={id}
          className="mz-field__control"
          aria-invalid={error ? true : undefined}
          {...rest}
        />
      )}
    </Field>
  );
}

export interface PasswordFieldProps extends TextFieldProps {
  showLabel: string;
  hideLabel: string;
}

export function PasswordField({ label, hint, error, showLabel, hideLabel, ...rest }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label} hint={hint} error={error}>
      {(id) => (
        <div className="mz-password">
          <input
            id={id}
            type={visible ? 'text' : 'password'}
            className="mz-field__control"
            aria-invalid={error ? true : undefined}
            {...rest}
          />
          <span className="mz-password__toggle">
            <IconButton
              icon={visible ? 'eye-off' : 'eye'}
              label={visible ? hideLabel : showLabel}
              onClick={() => setVisible((current) => !current)}
            />
          </span>
        </div>
      )}
    </Field>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
}

export function SegmentedControl<T extends string>({ label, value, options, onChange }: SegmentedControlProps<T>) {
  const strip = useRef<HTMLDivElement>(null);

  /**
   * The chosen option is brought into view when the strip is too narrow to show them all —
   * otherwise "History" is selected somewhere off the edge of a 360 px screen and the tab
   * strip looks as though nothing is chosen. Only along the inline axis, so the page does not
   * jump vertically, and instantly when the reader has asked for less motion (3.6.1).
   */
  useEffect(() => {
    const row = strip.current;
    if (!row || row.scrollWidth <= row.clientWidth) return;
    const chosen = row.querySelector('[aria-pressed="true"]');
    chosen?.scrollIntoView({
      inline: 'nearest',
      block: 'nearest',
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }, [value, options]);

  return (
    <div className="mz-field">
      <span className="mz-field__label">{label}</span>
      <div className="mz-segmented" role="group" aria-label={label} ref={strip}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className="mz-segmented__option"
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Three states, because a permission extra can be granted only in part (FR-204). */
export type ToggleState = boolean | 'mixed';

export interface ToggleProps {
  label: string;
  hint?: string;
  checked: ToggleState;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

export function Toggle({ label, hint, checked, disabled, onChange }: ToggleProps) {
  return (
    <label className="mz-toggle">
      <span>
        <span>{label}</span>
        {hint ? <span className="mz-field__hint" style={{ display: 'block' }}>{hint}</span> : null}
      </span>
      <button
        type="button"
        role="switch"
        className="mz-toggle__track"
        aria-checked={checked === 'mixed' ? 'mixed' : checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(checked !== true)}
      >
        <span className="mz-toggle__thumb" />
      </button>
    </label>
  );
}

export interface CheckboxProps {
  label: string;
  hint?: string;
  checked: boolean;
  /** A group that is partly granted, as a permission extra can be (FR-204). */
  indeterminate?: boolean;
  disabled?: boolean;
  /**
   * The label still names the box for a screen reader, but the eye reads it from the column
   * heading instead — a permission matrix would otherwise repeat "See orders" in every cell.
   */
  labelHidden?: boolean;
  /** Shown on hover and read after the label: what this choice drags in with it. */
  title?: string;
  onChange: (next: boolean) => void;
}

/**
 * A checkbox, for the many small choices a switch is too heavy for.
 *
 * `Toggle` is a row: a label at one end, a switch at the other, the width of the form. That is
 * right for a setting somebody changes once — "allow selling below stock" — and wrong for
 * forty-eight permissions, where the label belongs *beside* the box and a dozen of them belong
 * on a screen at once. The target is still 44 px tall (NFR-10): the label is part of it, so a
 * thumb has the whole row even though the box is small.
 */
export function Checkbox({
  label,
  hint,
  checked,
  indeterminate,
  disabled,
  labelHidden,
  title,
  onChange,
}: CheckboxProps) {
  return (
    <label
      className={`mz-check${disabled ? ' mz-check--disabled' : ''}${labelHidden ? ' mz-check--bare' : ''}`}
      title={title}
    >
      <input
        type="checkbox"
        className="mz-check__box"
        checked={checked}
        disabled={disabled}
        aria-label={labelHidden ? label : undefined}
        ref={(node) => {
          // `indeterminate` is a property, never an attribute: there is no way to set it in JSX.
          if (node) node.indeterminate = indeterminate === true && !checked;
        }}
        onChange={(event) => onChange(event.target.checked)}
      />
      {labelHidden ? null : (
        <span className="mz-check__body">
          <span>{label}</span>
          {hint ? <span className="mz-field__hint">{hint}</span> : null}
        </span>
      )}
    </label>
  );
}

export type ChipTone = 'neutral' | 'success' | 'warning' | 'danger' | 'primary';

export interface ChipProps {
  tone?: ChipTone;
  icon?: IconName;
  children: ReactNode;
}

/** Colour is never the only carrier of meaning: a chip always shows its word (NFR-10). */
export function Chip({ tone = 'neutral', icon, children }: ChipProps) {
  return (
    <span className={`mz-chip${tone === 'neutral' ? '' : ` mz-chip--${tone}`}`}>
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </span>
  );
}

export interface TabsProps<T extends string> {
  label: string;
  value: T;
  tabs: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}

export function Tabs<T extends string>({ label, value, tabs, onChange }: TabsProps<T>) {
  return (
    <div className="mz-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          className="mz-tabs__tab"
          aria-selected={tab.value === value}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Card({ children, className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  // `className` is merged, not spread over: spreading `{...rest}` after a hard-coded class let
  // a caller passing `className` — or even `className={undefined}` — silently delete
  // `mz-card`, taking the padding and the border with it. Found by a screenshot diff in I6,
  // which is the only thing that would have noticed.
  return (
    <div className={className ? `mz-card ${className}` : 'mz-card'} {...rest}>
      {children}
    </div>
  );
}

export function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => [...part][0] ?? '')
    .join('');
  return (
    <span className="mz-avatar" aria-hidden="true">
      {initials}
    </span>
  );
}

/** Skeletons, never spinners — a list looks like a list while it loads (spec 3.1 point 6). */
export function Skeleton({ lines = 1, width = '100%' }: { lines?: number; width?: string }) {
  return (
    <div className="mz-stack" aria-hidden="true" style={{ gap: 'var(--space-2)' }}>
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className="mz-skeleton" style={{ inlineSize: index === lines - 1 ? '60%' : width }} />
      ))}
    </div>
  );
}

export interface StateProps {
  title: string;
  body?: string;
  action?: ReactNode;
  icon?: IconName;
}

/** Zero dead ends: every empty and error state says what happened and what to do (3.1 point 7). */
export function EmptyState({ title, body, action, icon = 'search' }: StateProps) {
  return (
    <div className="mz-state">
      <Icon name={icon} size={32} />
      <p className="mz-heading">{title}</p>
      {body ? <p>{body}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ title, body, action }: StateProps) {
  return (
    <div className="mz-state" role="alert">
      <Icon name="warning" size={32} />
      <p className="mz-heading">{title}</p>
      {body ? <p>{body}</p> : null}
      {action}
    </div>
  );
}

export interface BottomSheetProps {
  title: string;
  open: boolean;
  onClose: () => void;
  closeLabel: string;
  children: ReactNode;
}

/**
 * A modal bottom sheet (wireframes 3.4, spec 3.3).
 *
 * While it is open the page behind it is marked `inert`: it cannot be reached by the keyboard,
 * it is out of the accessibility tree, and a screen reader reads the sheet rather than the
 * dimmed list underneath. Without that, `aria-modal` is a claim the page does not keep — which
 * is what the I6 axe pass found, reporting the *dimmed* rows behind the sheet as unreadable
 * text, because to a machine they were still text somebody was expected to read (NFR-10).
 */
export function BottomSheet({ title, open, onClose, closeLabel, children }: BottomSheetProps) {
  useEffect(() => {
    if (!open) return;
    const app = document.querySelector('.mz-app');
    if (!(app instanceof HTMLElement)) return;
    app.setAttribute('inert', '');
    return () => app.removeAttribute('inert');
  }, [open]);

  if (!open) return null;
  return createPortal(
    <>
      <div className="mz-backdrop" onClick={onClose} role="presentation" />
      <div className="mz-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="mz-row mz-row--between" style={{ marginBlockEnd: 'var(--space-3)' }}>
          <h2 className="mz-heading">{title}</h2>
          <IconButton icon="close" label={closeLabel} onClick={onClose} />
        </div>
        {children}
      </div>
    </>,
    // Outside the inert app, so the sheet itself stays interactive.
    document.body,
  );
}

export interface MenuItem {
  label: string;
  /** The current choice, marked for the eye and for a screen reader. */
  current?: boolean;
  /** For a language row: the item's own language, so it is read in the right voice. */
  lang?: string;
  onSelect: () => void;
}

/**
 * A small menu hung off a button — the language switch and the account menu in the app bar.
 *
 * Deliberately plain: a button that owns `aria-expanded`, a list of `role="menuitem"` buttons,
 * and the two ways anybody expects to dismiss it (Escape, or a click anywhere else). No
 * library, no portal, no focus trap: a menu of three rows is not a dialog, and the rows are
 * ordinary buttons, so the keyboard already works.
 */
export function Menu({
  label,
  icon,
  items,
  align = 'end',
  variant = 'icon',
}: {
  label: string;
  icon: IconName;
  items: readonly MenuItem[];
  align?: 'start' | 'end';
  /** `icon` is the app-bar dot; `button` is a labelled trigger for a toolbar (e.g. Filter). */
  variant?: 'icon' | 'button';
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const activeCount = items.filter((item) => item.current).length;

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent | KeyboardEvent): void => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') setOpen(false);
        return;
      }
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', dismiss);
    };
  }, [open]);

  return (
    <div className="mz-menu" ref={root}>
      {variant === 'button' ? (
        <button
          type="button"
          className="mz-button mz-button--secondary mz-menu__trigger"
          aria-label={label}
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={() => setOpen((current) => !current)}
        >
          <Icon name={icon} size={18} />
          {label}
          {activeCount > 0 ? <span className="mz-menu__count">{activeCount}</span> : null}
          <Icon name="chevron" size={16} />
        </button>
      ) : (
        <button
          type="button"
          className="mz-icon-button"
          aria-label={label}
          title={label}
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={() => setOpen((current) => !current)}
        >
          <Icon name={icon} size={22} />
        </button>
      )}
      {open ? (
        <div className={`mz-menu__list mz-menu__list--${align}`} role="menu" aria-label={label}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              lang={item.lang}
              className="mz-menu__item"
              aria-current={item.current ? 'true' : undefined}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.current ? <Icon name="check" size={16} /> : <span className="mz-menu__gap" />}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface ToastProps {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function Toast({ message, actionLabel, onAction }: ToastProps) {
  return (
    <div className="mz-toast" role="status" aria-live="polite">
      <span style={{ flex: 1 }}>{message}</span>
      {actionLabel && onAction ? (
        <button type="button" className="mz-button mz-button--ghost" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

export interface NumberFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
  hint?: string;
  error?: string;
  /** The unit that sits at the inline end: kg, د.ع, $ (spec 2.10.6 point 5). */
  unit?: string;
  /** Kilograms take three decimals; counts and minor units take none. */
  decimals?: number;
}

/**
 * A numeric input that stays LTR inside an RTL form, with its unit at the inline end and
 * Eastern digits accepted on the way in (spec 2.10.6 point 5, 2.10.4).
 *
 * It is deliberately not a `type="number"` field: the spinner is useless on a phone, and
 * `inputmode="decimal"` opens the right keyboard without the browser reformatting what the
 * employee typed.
 */
export function NumberField({ label, hint, error, unit, decimals = 0, onChange, ...rest }: NumberFieldProps) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(id) => (
        // Numbers read left-to-right in every language, so the field is an LTR island: the digits
        // start at the left and the unit sits at the right, even on an Arabic or Kurdish page.
        <div className="mz-number" dir="ltr">
          <input
            id={id}
            className="mz-field__control"
            inputMode={decimals > 0 ? 'decimal' : 'numeric'}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              // Eastern Arabic-Indic and Persian digits are normalised to ASCII on input, so
              // nothing downstream has to know which keyboard was used (spec 2.10.4).
              const normalized = normalizeDigits(event.target.value);
              if (normalized !== event.target.value) event.target.value = normalized;
              onChange?.(event);
            }}
            {...rest}
          />
          {unit ? (
            <span className="mz-number__unit" aria-hidden="true">
              {unit}
            </span>
          ) : null}
        </div>
      )}
    </Field>
  );
}

const EASTERN_DIGITS = /[٠-٩۰-۹]/g;

function normalizeDigits(value: string): string {
  return value.replace(EASTERN_DIGITS, (digit) => {
    const code = digit.codePointAt(0) as number;
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

export interface DateFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
  hint?: string;
  error?: string;
}

/**
 * A business date. The value is always `YYYY-MM-DD` (what the API takes), while the browser
 * renders it in the device's own format; the interface shows dates through the formatting
 * service everywhere it *displays* one (spec 2.10.4).
 */
export function DateField({ label, hint, error, ...rest }: DateFieldProps) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(id) => (
        <input id={id} type="date" className="mz-field__control" dir="ltr" aria-invalid={error ? true : undefined} {...rest} />
      )}
    </Field>
  );
}

export interface SheetFooterProps {
  children: ReactNode;
}

/** The sticky footer a form keeps in the thumb zone on a phone (wireframe 3.4.1). */
export function StickyFooter({ children }: SheetFooterProps) {
  return <div className="mz-sticky-footer">{children}</div>;
}

export interface FabProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon?: IconName;
}

/** The one primary action of a list page, in the thumb zone (spec 3.3). */
export function Fab({ label, icon = 'plus', ...rest }: FabProps) {
  return (
    <button type="button" className="mz-fab" {...rest}>
      <Icon name={icon} />
      {label}
    </button>
  );
}

export interface PinPadProps {
  /** The digits typed so far; the parent owns them, as with every field here. */
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  /** How many digits this device demands — 6 on a shared tablet (FR-106). */
  length?: number;
  label: string;
  hint?: string;
  error?: string;
  backspaceLabel: string;
  disabled?: boolean;
}

/**
 * The PIN pad of the lock screen (FR-106, wireframe 3.3).
 *
 * A keypad rather than a text field, because the lock screen is used one-handed on a tablet
 * standing on a bench, often with gloves: the targets are large, the digits are tabular, and
 * nothing here depends on a software keyboard appearing. The dots show how many digits have
 * been typed and never what they are.
 *
 * The grid is laid out in *logical* order, so it reads 1-2-3 from the start edge in both
 * directions — a numeric keypad is not mirrored in RTL (spec 2.10.6 point 5: numbers stay
 * left-to-right), which is why the digits carry `dir="ltr"` while the labels do not.
 */
export function PinPad({
  value,
  onChange,
  onComplete,
  length = 6,
  label,
  hint,
  error,
  backspaceLabel,
  disabled,
}: PinPadProps) {
  const press = (digit: string): void => {
    if (disabled || value.length >= length) return;
    const next = `${value}${digit}`;
    onChange(next);
    if (next.length === length) onComplete?.(next);
  };

  return (
    <div className="mz-stack" style={{ gap: 'var(--space-3)' }}>
      <div className="mz-pinpad__status">
        <p className="mz-caption" id="mz-pinpad-label">
          {label}
        </p>
        <div className="mz-pinpad__dots" role="img" aria-label={`${value.length} / ${length}`} dir="ltr">
          {Array.from({ length }, (_, index) => (
            <span
              key={index}
              className={index < value.length ? 'mz-pinpad__dot mz-pinpad__dot--on' : 'mz-pinpad__dot'}
            />
          ))}
        </div>
        {hint ? <p className="mz-caption">{hint}</p> : null}
        {error ? (
          <p className="mz-field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="mz-pinpad" role="group" aria-labelledby="mz-pinpad-label" dir="ltr">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <button
            key={digit}
            type="button"
            className="mz-pinpad__key"
            onClick={() => press(digit)}
            disabled={disabled}
            data-tabular
          >
            {digit}
          </button>
        ))}
        <button
          type="button"
          className="mz-pinpad__key mz-pinpad__key--quiet"
          onClick={() => onChange(value.slice(0, -1))}
          disabled={disabled || value.length === 0}
          aria-label={backspaceLabel}
        >
          <Icon name="back" />
        </button>
        <button
          type="button"
          className="mz-pinpad__key"
          onClick={() => press('0')}
          disabled={disabled}
          data-tabular
        >
          0
        </button>
      </div>
    </div>
  );
}

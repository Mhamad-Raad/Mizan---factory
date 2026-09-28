import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { groupDigits, ungroupDigits } from '@mizan/text';
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
  const sheet = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  /*
   * A dialog behaves like one (NFR-10): focus moves into it when it opens, Escape closes it, and
   * focus goes back to whatever opened it when it closes — before this a keyboard user was left
   * on the inert page behind the sheet, with no key that closed it.
   *
   * Into the first field where there is a mouse or a keyboard; into the sheet itself on a touch
   * screen, where focusing a field would throw the software keyboard over the sheet unasked. One
   * effect, so the order is explicit: the opener is noted before the page goes inert (which can
   * take its focus away), and given focus back only after the page is live again.
   */
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const app = document.querySelector('.mz-app');
    if (app instanceof HTMLElement) app.setAttribute('inert', '');

    const node = sheet.current;
    const fine = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;
    const field = fine
      ? node?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled])')
      : null;
    (field ?? node)?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (app instanceof HTMLElement) app.removeAttribute('inert');
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <>
      <div className="mz-backdrop" onClick={onClose} role="presentation" />
      <div ref={sheet} className="mz-sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
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
  /** An icon before the label, for a menu of actions rather than of choices (the account menu). */
  icon?: IconName;
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
              {item.icon ? (
                <Icon name={item.icon} size={16} />
              ) : item.current ? (
                <Icon name="check" size={16} />
              ) : (
                <span className="mz-menu__gap" />
              )}
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
  /**
   * Thousands separators while typing — `1,250,000` on screen, `1250000` to the form. On by
   * default; off for a figure that is not a quantity, such as a year or a reference number.
   */
  grouped?: boolean;
}

/**
 * A numeric input that stays LTR inside an RTL form, with its unit at the inline end and
 * Eastern digits accepted on the way in (spec 2.10.6 point 5, 2.10.4).
 *
 * It is deliberately not a `type="number"` field: the spinner is useless on a phone, and
 * `inputmode="decimal"` opens the right keyboard without the browser reformatting what the
 * employee typed.
 */
export function NumberField({
  label,
  hint,
  error,
  unit,
  decimals = 0,
  grouped = true,
  onChange,
  value,
  ...rest
}: NumberFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  /**
   * Where the caret belongs after a keystroke, counted in characters that are not separators:
   * typing the fourth digit adds a comma *before* the caret, and without this the caret would
   * jump to the end of the field on every keystroke.
   */
  const caret = useRef<number | null>(null);
  const shown = value === undefined || value === null ? value : grouped ? groupDigits(String(value)) : value;

  useLayoutEffect(() => {
    const element = input.current;
    const wanted = caret.current;
    caret.current = null;
    if (!element || wanted === null || document.activeElement !== element) return;
    let position = 0;
    for (let seen = 0; position < element.value.length && seen < wanted; position += 1) {
      if (element.value[position] !== ',') seen += 1;
    }
    element.setSelectionRange(position, position);
  });

  return (
    <Field label={label} hint={hint} error={error}>
      {(id) => (
        // Numbers read left-to-right in every language, so the field is an LTR island: the digits
        // run left to right and the unit sits at the right, even on an Arabic or Kurdish page.
        <div className="mz-number" dir="ltr">
          <input
            ref={input}
            id={id}
            className="mz-field__control"
            inputMode={decimals > 0 ? 'decimal' : 'numeric'}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            value={shown}
            onChange={(event) => {
              // Eastern Arabic-Indic and Persian digits are normalised to ASCII on input, so
              // nothing downstream has to know which keyboard was used (spec 2.10.4); the
              // separators are presentation, so the form only ever sees the bare number.
              const typed = event.target.value;
              const normalized = normalizeDigits(typed);
              const raw = grouped ? ungroupDigits(normalized) : normalized;
              if (grouped) {
                const before = typed.slice(0, event.target.selectionStart ?? typed.length);
                caret.current = ungroupDigits(normalizeDigits(before)).length;
              }
              if (raw !== typed) event.target.value = raw;
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


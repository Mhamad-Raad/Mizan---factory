import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { useId, useState } from 'react';
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
  return (
    <div className="mz-field">
      <span className="mz-field__label">{label}</span>
      <div className="mz-segmented" role="group" aria-label={label}>
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

export function Card({ children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="mz-card" {...rest}>
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

export function BottomSheet({ title, open, onClose, closeLabel, children }: BottomSheetProps) {
  if (!open) return null;
  return (
    <>
      <div className="mz-backdrop" onClick={onClose} role="presentation" />
      <div className="mz-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="mz-row mz-row--between" style={{ marginBlockEnd: 'var(--space-3)' }}>
          <h2 className="mz-heading">{title}</h2>
          <IconButton icon="close" label={closeLabel} onClick={onClose} />
        </div>
        {children}
      </div>
    </>
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
        <div className="mz-number">
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

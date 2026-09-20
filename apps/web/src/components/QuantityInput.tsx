import { useTranslation } from 'react-i18next';
import { NumberField } from '@mizan/ui';
import type { Measure } from '@mizan/money';

export interface QuantityValue {
  qty_count: number | null;
  qty_kg: string | null;
}

export interface QuantityInputProps {
  /** The measure that drives the price; it comes first and is required (FR-302). */
  priced_measure: Measure;
  value: QuantityValue;
  onChange: (value: QuantityValue) => void;
  disabled?: boolean;
  error?: string;
}

/**
 * Count and kilograms, with the priced measure first and labelled as the one that matters;
 * the other is optional and marked "for information" (FR-302, component of 2.10.11).
 */
export function QuantityInput({ priced_measure, value, onChange, disabled, error }: QuantityInputProps) {
  const { t } = useTranslation();

  const count = (
    <NumberField
      key="count"
      label={t('glossary:count')}
      value={value.qty_count === null ? '' : String(value.qty_count)}
      hint={priced_measure === 'count' ? undefined : t('orders:for_information')}
      error={priced_measure === 'count' ? error : undefined}
      disabled={disabled}
      onChange={(event) => {
        const text = event.target.value.trim();
        onChange({ ...value, qty_count: text === '' ? null : Math.round(Number(text)) });
      }}
    />
  );

  const kg = (
    <NumberField
      key="kg"
      label={t('glossary:weight_kg')}
      unit={t('common:kg_symbol')}
      decimals={3}
      value={value.qty_kg ?? ''}
      hint={priced_measure === 'kg' ? undefined : t('orders:for_information')}
      error={priced_measure === 'kg' ? error : undefined}
      disabled={disabled}
      onChange={(event) => {
        const text = event.target.value.trim();
        onChange({ ...value, qty_kg: text === '' ? null : text });
      }}
    />
  );

  return <div className="mz-grid-2">{priced_measure === 'kg' ? [kg, count] : [count, kg]}</div>;
}

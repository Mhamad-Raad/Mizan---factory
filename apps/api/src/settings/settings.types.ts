import { z } from 'zod';

/**
 * The system settings of specification 2.2.3. Only the keys Iteration 0 needs are editable
 * here; the money, stock and period-lock keys are seeded now and become editable in the
 * iteration that uses them, so nothing is built ahead of its brief.
 */
export const SETTING_SCHEMAS = {
  week_start: z.enum(['sat', 'sun', 'mon']),
  date_format: z.literal('dd/MM/yyyy'),
  idle_lock_shared_minutes: z.number().int().min(1).max(120),
  idle_lock_default_minutes: z.number().int().min(1).max(1440),
  allow_negative_stock: z.boolean(),
  default_customer_currency: z.enum(['IQD', 'USD']),
  rate_guard_percent: z.number().int().min(1).max(100),
  settle_tolerance_iqd: z.number().int().min(0),
  settle_tolerance_usd_cents: z.number().int().min(0),
  pin_min_length_shared: z.number().int().min(4).max(6),
  pin_min_length_personal: z.number().int().min(4).max(6),
  allow_pin_switch_on_shared: z.boolean(),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;

/** What an admin may change in I0 (spec 4.2: idle-lock minutes, week start, date format). */
export const I0_EDITABLE_KEYS: readonly SettingKey[] = [
  'idle_lock_shared_minutes',
  'idle_lock_default_minutes',
  'week_start',
  'date_format',
];

/** Everyone may read these; the rest are admin-only (FR-1107). */
export const PUBLIC_SETTING_KEYS: readonly SettingKey[] = ['week_start', 'date_format'];

export type Settings = {
  [K in SettingKey]: z.infer<(typeof SETTING_SCHEMAS)[K]>;
};

export const DEFAULT_SETTINGS: Settings = {
  week_start: 'sat',
  date_format: 'dd/MM/yyyy',
  idle_lock_shared_minutes: 5,
  idle_lock_default_minutes: 30,
  allow_negative_stock: true,
  default_customer_currency: 'IQD',
  rate_guard_percent: 20,
  settle_tolerance_iqd: 250,
  settle_tolerance_usd_cents: 25,
  pin_min_length_shared: 6,
  pin_min_length_personal: 4,
  allow_pin_switch_on_shared: true,
};
